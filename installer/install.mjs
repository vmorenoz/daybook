import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkbox, confirm } from '@inquirer/prompts';
import { applyRegistration, getClients, planRegistration } from './clients.mjs';

const defaultServerPath = fileURLToPath(new URL('../dist/mcp.js', import.meta.url));
const instructionsPath = new URL('../instructions/global.md', import.meta.url);
const clientChoices = [
  { value: 'opencode', name: 'OpenCode' },
  { value: 'codex', name: 'Codex' },
  { value: 'antigravity', name: 'Antigravity' },
  { value: 'claude-code', name: 'Claude Code' },
];

async function requireFile(path, description) {
  if (!isAbsolute(path) || !(await stat(path)).isFile()) {
    throw new Error(`${description} must be an existing file at an absolute path: ${path}`);
  }
  return path;
}

/** Register the installed runtime without importing it or opening its database. */
export async function runSetup({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  serverPath = defaultServerPath,
} = {}) {
  env = {
    ...env,
    DAYBOOK_HOME: env.DAYBOOK_HOME ?? env.BITACORA_HOME,
    DAYBOOK_SKIP_SETUP: env.DAYBOOK_SKIP_SETUP ?? env.BITACORA_SKIP_SETUP,
    DAYBOOK_INSTALL_CLIENTS: env.DAYBOOK_INSTALL_CLIENTS ?? env.BITACORA_INSTALL_CLIENTS,
    DAYBOOK_INSTALL_CONFIRM: env.DAYBOOK_INSTALL_CONFIRM ?? env.BITACORA_INSTALL_CONFIRM,
  };
  const log = (message) => output.write(`${message}\n`);
  const error = (message) => errorOutput.write(`${message}\n`);
  const changed = [];
  let cancelled = false;
  const abort = new AbortController();
  const cancel = () => {
    cancelled = true;
    abort.abort();
  };
  const cancellation = () => {
    if (changed.length) error(`Setup interrupted. Files already updated (no rollback): ${changed.join(', ')}`);
    else log('No changes.');
    return { status: 'cancelled', changed };
  };

  if (env.DAYBOOK_SKIP_SETUP === '1') {
    log('No changes.');
    return { status: 'skipped', changed };
  }

  if (env.SUDO_USER || env.SUDO_UID) {
    error('Setup skipped: run the installation without sudo.');
    return { status: 'skipped', changed };
  }

  process.on('SIGINT', cancel);
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) throw new Error('Daybook requires Node.js >=24.');
    // npm uses the same Node executable for the runtime unless it explicitly supplies one.
    const nodePath = await requireFile(env.npm_node_execpath || process.execPath, 'Node.js');
    await requireFile(serverPath, 'The installed MCP server');
    const dataHome = env.DAYBOOK_HOME || join(home, '.local', 'share', 'bitacora');
    if (!isAbsolute(dataHome)) throw new Error('DAYBOOK_HOME must be an absolute path.');

    const interactive = Boolean(input.isTTY && output.isTTY);
    const explicitSelection = env.DAYBOOK_INSTALL_CLIENTS !== undefined;
    const preconfirmed = env.DAYBOOK_INSTALL_CONFIRM === '1';
    if (!interactive && !(explicitSelection && preconfirmed)) {
      log('No changes.');
      return { status: 'skipped', changed };
    }

    const clients = await getClients({ home, platform, env });
    const compatible = (client) => client.path && client.supported !== false && !client.ambiguous && !client.unsupported;
    const available = clientChoices.map(({ value, name }) => {
      const client = clients.find((candidate) => candidate.id === value && compatible(candidate));
      if (!client) throw new Error(`Unsupported client: ${name}`);
      return client;
    });
    const promptContext = { input, output, signal: abort.signal, clearPromptOnDone: true };

    let selected;
    if (explicitSelection) {
      const ids = [...new Set(env.DAYBOOK_INSTALL_CLIENTS.split(',').map((id) => id.trim()).filter(Boolean))];
      selected = ids.map((id) => {
        const client = available.find((candidate) => candidate.id === id);
        if (!client) throw new Error(`Unknown or unsupported client: ${id}`);
        return client;
      });
    } else {
      const ids = await checkbox({
        message: 'Where should Daybook connect?',
        choices: clientChoices,
        shortcuts: { all: null, invert: null },
        theme: {
          prefix: '',
          icon: { checked: '[x]', unchecked: '[ ]', cursor: '›' },
          style: { keysHelpTip: () => '↑↓ move · space select · Enter confirm' },
        },
      }, promptContext);
      selected = available.filter((client) => ids.includes(client.id));
    }
    if (cancelled || !selected?.length) return cancellation();
    if (explicitSelection && !preconfirmed) {
      const accepted = await confirm({
        message: `Connect ${selected.map((client) => client.label).join(', ')}?`,
        default: false,
        theme: { prefix: '' },
      }, promptContext);
      if (cancelled || !accepted) return cancellation();
    }

    // Finish every plan before the first write: malformed configs cannot cause a partial setup.
    const instructions = await readFile(instructionsPath, 'utf8');
    if (!instructions.trim()) throw new Error('The Daybook global instruction is missing.');
    const plans = [];
    const planningErrors = [];
    for (const client of selected) {
      try {
        const plan = await planRegistration(client, { nodePath, serverPath, dataHome, instructions });
        plans.push(plan);
      } catch (cause) {
        planningErrors.push(`${client.label}: ${cause.message}`);
      }
    }
    if (planningErrors.length) throw new Error(`No files were written. Fix the configurations:\n${planningErrors.join('\n')}`);
    if (cancelled) return cancellation();
    const pending = plans.filter((plan) => plan.changed);
    if (!pending.length) {
      log('No changes.');
      return { status: 'unchanged', changed };
    }
    for (const plan of pending) {
      if (cancelled) return cancellation();
      await applyRegistration(plan);
      changed.push(...(plan.files || [plan]).filter((file) => file.changed).map((file) => file.path));
    }
    log(`Connected: ${selected.map((client) => client.label).join(', ')}.`);
    return { status: 'registered', changed };
  } catch (cause) {
    for (const path of cause.modifiedPaths || []) {
      if (!changed.includes(path)) changed.push(path);
    }
    if (['AbortError', 'ExitPromptError', 'AbortPromptError'].includes(cause.name)) return cancellation();
    error(`Daybook: MCP and instruction setup failed: ${cause.message}`);
    if (changed.length) error(`Files already updated (no rollback): ${changed.join(', ')}`);
    else error('No configuration files were modified.');
    return { status: 'failed', changed, error: cause };
  } finally {
    process.off('SIGINT', cancel);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSetup();
  if (result.status === 'failed') process.exitCode = 1;
}
