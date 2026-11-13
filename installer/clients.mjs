import { homedir } from 'node:os';
import { dirname, join, isAbsolute, posix, win32 } from 'node:path';
import { existsSync, lstatSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, parseTree, modify, applyEdits } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';

const snapshots = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const serverId = 'daybook';
const legacyIds = ['bitacora', 'vimo-contex', 'vimo-cortex', 'alba-cortex'];

function ownedLegacy(entry, server) {
  if (!object(entry)) return false;
  const opencode = Array.isArray(server.command);
  const command = opencode ? entry.command : entry.args;
  if (!Array.isArray(command) || command.length !== (opencode ? 2 : 1)) return false;
  if (!opencode && typeof entry.command !== 'string') return false;
  const path = command[opencode ? 1 : 0];
  if (typeof path !== 'string' || !(posix.isAbsolute(path) || win32.isAbsolute(path))) return false;
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  const currentPath = opencode ? server.command[1] : server.args[0];
  const environment = opencode ? 'environment' : 'env';
  return (/\/node_modules\/(?:bitacora-local|vimo-contex|vimo-cortex|alba-cortex)\/dist\/mcp\.js$/.test(normalized)
      || normalized === posix.normalize(currentPath.replaceAll('\\', '/')))
    && (entry[environment]?.DAYBOOK_HOME ?? entry[environment]?.BITACORA_HOME) === server[environment].DAYBOOK_HOME;
}

export function getClients({ home = homedir(), env = process.env } = {}) {
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
  const json = join(config, 'opencode.json');
  const jsonc = join(config, 'opencode.jsonc');
  const both = existsSync(json) && existsSync(jsonc);
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const codexOverride = join(codexHome, 'AGENTS.override.md');
  const clients = [
    // Extension precedence is undocumented: keep the same server in both existing files.
    { id: 'opencode', label: 'OpenCode', path: existsSync(jsonc) ? jsonc : json, instructionsPath: join(config, 'instructions', 'daybook.md'), format: existsSync(jsonc) ? 'jsonc' : 'json', keys: ['mcp', 'servers'], ...(both ? { files: [{ path: jsonc, format: 'jsonc' }, { path: json, format: 'json' }] } : {}) },
    { id: 'codex', label: 'Codex', path: join(codexHome, 'config.toml'), format: 'toml' },
    // https://antigravity.google/docs/mcp/ — current IDE global configuration.
    { id: 'antigravity', label: 'Antigravity', path: join(home, '.gemini', 'config', 'mcp_config.json'), instructionsPath: join(home, '.gemini', 'GEMINI.md'), format: 'json', keys: ['mcpServers'] },
    { id: 'claude-code', label: 'Claude Code', path: join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), instructionsPath: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'CLAUDE.md'), format: 'json', keys: ['mcpServers'] },
  ].map(client => ({ supported: true, ...client, detected: Boolean(client.path && existsSync(client.path)) }));
  // Resolve precedence only when Codex is selected, not while displaying other clients.
  Object.defineProperty(clients[1], 'instructionsPath', {
    enumerable: true,
    get() {
      return readSnapshot(codexOverride).text?.trim() ? codexOverride : join(codexHome, 'AGENTS.md');
    },
  });
  return clients;
}

function readSnapshot(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Will not edit a non-regular file: ${path}`);
    return { text: readFileSync(path, 'utf8'), stat };
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null, stat: null };
    throw error;
  }
}

function assertObject(value, location) {
  if (!object(value)) throw new Error(`${location} must be an object, not an array or scalar.`);
}

function jsonDocument(text, format) {
  if (format === 'json') return JSON.parse(text);
  const errors = [];
  const result = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Invalid JSONC configuration.');
  return result;
}

function editJson(before, client, server) {
  let text = before === null ? '{}\n' : before;
  const root = jsonDocument(text, client.format);
  assertObject(root, 'The root');
  // Duplicate keys make targeted edits ambiguous, even when JSON.parse accepts them.
  function unique(node) {
    if (node?.type === 'object') {
      const keys = node.children.map(child => child.children[0].value);
      if (new Set(keys).size !== keys.length) throw new Error('The configuration contains duplicate keys.');
    }
    for (const child of node?.children || []) unique(child);
  }
  unique(parseTree(text));
  let parent = root;
  for (const key of client.keys) {
    if (!own(parent, key)) break;
    parent = parent[key];
    assertObject(parent, key);
  }
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } };
  if (client.id === 'opencode' && !own(root, '$schema')) {
    text = applyEdits(text, modify(text, ['$schema'], 'https://opencode.ai/config.json', options));
  }
  // An explicit source augments global rules without hiding Claude compatibility fallbacks.
  if (client.id === 'opencode' && client.registerInstructions) {
    const sources = root.instructions ?? [];
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) throw new Error('OpenCode instructions must be an array of paths.');
    const obsolete = ['vimo-cortex', 'alba-cortex'].filter(id => ownedLegacy(parent?.[id], server)).map(id => join(dirname(client.instructionsPath), `${id}.md`));
    const retained = sources.filter(source => !obsolete.includes(source));
    const next = retained.includes(client.instructionsPath) ? retained : [...retained, client.instructionsPath];
    if (!isDeepStrictEqual(sources, next)) {
      text = applyEdits(text, modify(text, ['instructions'], next, options));
    }
  }
  for (const id of legacyIds) {
    if (ownedLegacy(parent?.[id], server)) text = applyEdits(text, modify(text, [...client.keys, id], undefined, options));
  }
  const keys = [...client.keys, serverId];
  let previous = root;
  for (const key of keys) previous = object(previous) && own(previous, key) ? previous[key] : undefined;
  if (!isDeepStrictEqual(previous, server)) text = applyEdits(text, modify(text, keys, server, options));
  jsonDocument(text, client.format);
  return text;
}

function editToml(before, server) {
  const text = before ?? '';
  const root = parseToml(text);
  if (own(root, 'mcp_servers')) assertObject(root.mcp_servers, 'mcp_servers');
  const removeLegacy = legacyIds.filter(id => ownedLegacy(root.mcp_servers?.[id], server));
  if (!removeLegacy.length && root.mcp_servers?.[serverId] && isDeepStrictEqual(JSON.parse(JSON.stringify(root.mcp_servers[serverId])), server)) return text;
  // Deliberately limited lexical editing: never mistake a multiline string for a table.
  if (text.includes('"""') || text.includes("'''")) throw new Error('Automatic editing of TOML with multiline strings is not supported.');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let target = false;
  let remainder = '';
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      // Let the TOML parser decode quoted/dotted keys; dots inside a quoted
      // project path are not path separators. Probe arrays without editing them.
      const marker = `__daybook_header_${randomUUID().replaceAll('-', '')}__`;
      let probe;
      try { probe = parseToml(`${line.trimEnd()}\n${marker} = 1\n`); }
      catch { throw new Error('Ambiguous TOML header: automatic editing is not supported.'); }
      const matches = [];
      function findMarker(value, keys = [], array = false) {
        if (Array.isArray(value)) {
          for (const item of value) findMarker(item, keys, true);
        } else if (object(value)) {
          if (own(value, marker) && value[marker] === 1) matches.push({ keys, array });
          for (const [key, child] of Object.entries(value)) {
            if (key !== marker) findMarker(child, [...keys, key], array);
          }
        }
      }
      findMarker(probe);
      if (matches.length !== 1) throw new Error('Ambiguous TOML header: automatic editing is not supported.');
      const { keys, array } = matches[0];
      target = keys[0] === 'mcp_servers' && (keys[1] === serverId || removeLegacy.includes(keys[1]));
      if (target && array) throw new Error('Automatic editing of Daybook as a TOML table array is not supported.');
    }
    if (!target) remainder += line;
  }
  const remaining = parseToml(remainder);
  if (remaining.mcp_servers && [serverId, ...removeLegacy].some(id => own(remaining.mcp_servers, id))) {
    throw new Error('Automatic editing of inline or dotted-key Daybook TOML is not supported.');
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = ['[mcp_servers.daybook]', `command = ${JSON.stringify(server.command)}`, `args = [${JSON.stringify(server.args[0])}]`, '[mcp_servers.daybook.env]', `DAYBOOK_HOME = ${JSON.stringify(server.env.DAYBOOK_HOME)}`, ''].join(eol);
  const after = remainder + (remainder && !remainder.endsWith('\n') ? eol : '') + (remainder ? eol : '') + block;
  const result = parseToml(after);
  const expected = parseToml(text);
  if (!own(expected, 'mcp_servers')) expected.mcp_servers = Object.create(Object.getPrototypeOf(result.mcp_servers));
  for (const id of removeLegacy) delete expected.mcp_servers[id];
  expected.mcp_servers[serverId] = parseToml(block).mcp_servers[serverId];
  if (!isDeepStrictEqual(result, expected)) throw new Error('TOML editing would change unrelated settings; cancelled.');
  return after;
}

function editInstructions(before, instructions) {
  let text = before ?? '';
  const start = '<!-- daybook:start -->';
  const end = '<!-- daybook:end -->';
  for (const id of ['vimo-cortex', 'alba-cortex']) {
    const legacyStart = `<!-- ${id}:start -->`;
    const legacyEnd = `<!-- ${id}:end -->`;
    if (text.includes(legacyStart) || text.includes(legacyEnd)) {
      if (text.includes(start) || text.includes(end) || text.split(legacyStart).length !== 2 || text.split(legacyEnd).length !== 2 || text.indexOf(legacyEnd) < text.indexOf(legacyStart)) {
        throw new Error('Incomplete or ambiguous legacy instruction markers; consolidate the managed blocks before installing Daybook.');
      }
      text = text.replace(legacyStart, start).replace(legacyEnd, end);
    }
  }
  const starts = text.split(start).length - 1;
  const ends = text.split(end).length - 1;
  const block = `${start}\n${instructions.trim()}\n${end}`;
  if (!starts && !ends) return text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block + '\n';
  if (starts !== 1 || ends !== 1 || text.indexOf(end) < text.indexOf(start)) {
    throw new Error('Incomplete or ambiguous Daybook instruction markers.');
  }
  return text.slice(0, text.indexOf(start)) + block + text.slice(text.indexOf(end) + end.length);
}

export function planRegistration(client, { nodePath, serverPath, dataHome, instructions }) {
  if (client.supported === false || !client.path) throw new Error(client.warning || 'Unsupported client.');
  if (!isAbsolute(client.path)) throw new Error('The client configuration directory must be an absolute path.');
  for (const [name, value] of Object.entries({ nodePath, serverPath, dataHome })) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  }
  const server = client.id === 'opencode'
    ? { type: 'local', command: [nodePath, serverPath], environment: { DAYBOOK_HOME: dataHome } }
    : { ...(client.id === 'claude-code' ? { type: 'stdio' } : {}), command: nodePath, args: [serverPath], env: { DAYBOOK_HOME: dataHome } };
  const files = (client.files || [{ path: client.path, format: client.format }]).map(file => {
    if (!isAbsolute(file.path)) throw new Error('The client configuration directory must be an absolute path.');
    const snapshot = readSnapshot(file.path);
    const target = { ...client, ...file, registerInstructions: instructions !== undefined };
    const after = target.format === 'toml' ? editToml(snapshot.text, server) : editJson(snapshot.text, target, server);
    const plan = { path: target.path, before: snapshot.text, after, changed: snapshot.text !== after };
    snapshots.set(plan, snapshot);
    return plan;
  });
  if (instructions !== undefined) {
    if (typeof instructions !== 'string') throw new Error('instructions must be text.');
    const instructionsPath = client.instructionsPath;
    if (typeof instructionsPath !== 'string' || !isAbsolute(instructionsPath)) throw new Error('instructionsPath must be an absolute path.');
    const snapshot = readSnapshot(instructionsPath);
    const after = editInstructions(snapshot.text, instructions);
    const plan = { path: instructionsPath, before: snapshot.text, after, changed: snapshot.text !== after };
    snapshots.set(plan, snapshot);
    files.push(plan);
  }
  // Keep the single-path interface; files contains every snapshot for multi-file writes.
  return { ...(files.find(file => file.changed) || files[0]), files, changed: files.some(file => file.changed) };
}

export function applyRegistration(plan) {
  const files = plan.files || [plan];
  // Validate all snapshots before writing anything, including unchanged files.
  for (const file of files) checkSnapshot(file);
  const modified = [];
  try {
    for (const file of files) {
      applyFile(file);
      if (file.changed) modified.push(file.path);
    }
  } catch (error) {
    if (modified.length) {
      const partial = new Error(error.message, { cause: error });
      partial.modifiedPaths = modified;
      throw partial;
    }
    throw error;
  }
}

function checkSnapshot(plan) {
  const snapshot = snapshots.get(plan);
  const current = readSnapshot(plan.path);
  if (current.text !== plan.before || (snapshot && ['ino', 'dev', 'mtimeNs', 'ctimeNs', 'mode'].some(key => current.stat?.[key] !== snapshot.stat?.[key]))) {
    throw new Error(`The configuration changed after planning: ${plan.path}`);
  }
  return current;
}

function applyFile(plan) {
  const current = checkSnapshot(plan);
  if (!plan.changed) return;
  mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(plan.path), `.daybook-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, plan.after, 'utf8');
    if (current.stat) chmodSync(temporary, Number(current.stat.mode & 0o7777n));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    checkSnapshot(plan);
    renameSync(temporary, plan.path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
