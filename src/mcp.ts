import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bitacora } from './core.js';
import { operationDescriptions, operationSchemas } from './schemas.js';

type Core = Pick<Bitacora, 'execute'>;

function errorResult(error: unknown) {
  const value = error as { code?: unknown; message?: unknown; details?: unknown } | null;
  const result = {
    code: typeof value?.code === 'string' ? value.code : 'INTERNAL_ERROR',
    message: typeof value?.message === 'string' ? value.message : 'Unexpected error',
    ...(value?.details === undefined ? {} : { details: value.details }),
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function createServer(core: Core): McpServer {
  const server = new McpServer({ name: 'daybook', version: '0.1.0' });
  for (const name of Object.keys(operationSchemas) as (keyof typeof operationSchemas)[]) {
    const schema = operationSchemas[name];
    server.registerTool(name, {
      description: operationDescriptions[name],
      inputSchema: schema.shape,
      ...(name.startsWith('delete_') ? { annotations: { destructiveHint: true, readOnlyHint: false } } : {}),
    }, async (input: unknown) => {
      try {
        const result = await core.execute(name, input);
        const structuredContent = result !== null && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown>
          : { result };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        return errorResult(error);
      }
    });
  }
  return server;
}

async function main(): Promise<void> {
  const core = new Bitacora();
  const server = createServer(core);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.stdin.off('end', onSignal);
    try {
      await server.close();
    } finally {
      await core.close();
    }
  };
  const onSignal = () => {
    void shutdown().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.stdin.once('end', onSignal);
  server.server.onclose = onSignal;
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
