import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { runSetup } from '../installer/install.mjs';

test('instalador registra MCP e instrucciones sin backups y repetir no modifica archivos', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitacora-setup-'));
  let transcript = '';
  const output = new Writable({ write(chunk, _encoding, done) { transcript += chunk.toString(); done(); } });
  const options = {
    home, platform: 'darwin', output, errorOutput: output,
    serverPath: fileURLToPath(new URL('../dist/mcp.js', import.meta.url)),
    env: {
      DAYBOOK_INSTALL_CLIENTS: 'opencode,codex,antigravity,claude-code',
      DAYBOOK_INSTALL_CONFIRM: '1',
      DAYBOOK_HOME: join(home, 'datos'),
    },
  };
  try {
    const configDirectory = join(home, '.config/opencode');
    await mkdir(configDirectory, { recursive: true });
    await Promise.all(['opencode.json', 'opencode.jsonc'].map((name) => writeFile(join(configDirectory, name), '{}\n')));
    const instructionFiles = ['.config/opencode/instructions/daybook.md', '.codex/AGENTS.md', '.gemini/GEMINI.md', '.claude/CLAUDE.md'].map(path => join(home, path));
    for (const path of instructionFiles) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'Mi instrucción personal.\n');
    }
    const result = await runSetup(options);
    assert.equal(result.status, 'registered', result.error?.message);
    assert.equal(result.changed.length, 9);
    assert.equal(transcript, 'Connected: OpenCode, Codex, Antigravity, Claude Code.\n');
    const config = JSON.parse(await readFile(join(home, '.config/opencode/opencode.json'), 'utf8'));
    assert.deepEqual(config.mcp.servers.daybook.command, [process.execPath, options.serverPath]);
    assert.equal(config.mcp.servers.daybook.environment.DAYBOOK_HOME, options.env.DAYBOOK_HOME);
    assert.deepEqual(config.instructions, [instructionFiles[0]]);
    const jsonc = JSON.parse(await readFile(join(configDirectory, 'opencode.jsonc'), 'utf8'));
    assert.deepEqual(jsonc.mcp.servers.daybook, config.mcp.servers.daybook);
    for (const path of instructionFiles) {
      const text = await readFile(path, 'utf8');
      assert.ok(text.startsWith('Mi instrucción personal.\n'));
      assert.equal(text.split('<!-- daybook:start -->').length - 1, 1);
      assert.ok(text.includes('get_active_context'));
    }
    const before = await Promise.all(result.changed.map((path) => readFile(path, 'utf8')));
    transcript = '';
    const repeat = await runSetup({ ...options, env: { BITACORA_HOME: options.env.DAYBOOK_HOME, BITACORA_INSTALL_CLIENTS: options.env.DAYBOOK_INSTALL_CLIENTS, BITACORA_INSTALL_CONFIRM: '1' } });
    assert.equal(repeat.status, 'unchanged');
    assert.deepEqual(repeat.changed, []);
    assert.equal(transcript, 'No changes.\n');
    assert.deepEqual(await Promise.all(result.changed.map((path) => readFile(path, 'utf8'))), before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
