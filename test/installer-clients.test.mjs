import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, readdirSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { getClients, planRegistration, applyRegistration } from '../installer/clients.mjs';

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), 'daybook-clients-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: {}, platform: 'darwin' };
}

test('cada cliente global soportado preserva otros servidores y ajustes; registro idempotente', t => {
  const options = sandbox(t);
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'server.mjs'), dataHome: join(options.home, 'data'), instructions: '  Use daybook for project memory.\n' };
  for (const client of getClients(options).filter(client => client.supported)) {
    mkdirSync(dirname(client.path), { recursive: true });
    const other = { command: 'other', args: ['keep'] };
    const initial = client.id === 'codex'
      ? '# conservar\nmodel = "keep"\n[mcp_servers.other]\ncommand = "other"\nargs = ["keep"]\n'
      : JSON.stringify({ setting: 'keep', ...(client.id === 'opencode' ? { instructions: ['/existing/rules.md'], mcp: { timeout: { startup: 999 }, servers: { other } } } : { mcpServers: { other } }) }, null, 2);
    writeFileSync(client.path, initial);
    chmodSync(client.path, 0o640);
    const userInstructions = '# My rules\r\n\r\nKeep this exactly.  ';
    mkdirSync(dirname(client.instructionsPath), { recursive: true });
    writeFileSync(client.instructionsPath, userInstructions);
    chmodSync(client.instructionsPath, 0o640);
    const plan = planRegistration(client, runtime);
    assert.equal(plan.before, initial);
    assert.equal(plan.changed, true);
    applyRegistration(plan);
    const text = readFileSync(client.path, 'utf8');
    const parsed = client.format === 'toml' ? parseToml(text) : JSON.parse(text);
    const servers = client.id === 'codex' ? parsed.mcp_servers : client.id === 'opencode' ? parsed.mcp.servers : parsed.mcpServers;
    assert.equal(servers.other.command, 'other');
    assert.deepEqual(servers.other.args, ['keep']);
    assert.equal(client.id === 'codex' ? parsed.model : parsed.setting, 'keep');
    assert.equal((servers.daybook.env || servers.daybook.environment).DAYBOOK_HOME, runtime.dataHome);
    if (client.id === 'opencode') assert.deepEqual(parsed.instructions, ['/existing/rules.md', client.instructionsPath]);
    assert.equal(statSync(client.path).mode & 0o777, 0o640);
    const instructions = readFileSync(client.instructionsPath, 'utf8');
    assert.ok(instructions.startsWith(userInstructions));
    assert.ok(instructions.includes('<!-- daybook:start -->\nUse daybook for project memory.\n<!-- daybook:end -->'));
    assert.equal(statSync(client.instructionsPath).mode & 0o777, 0o640);
    if (client.id === 'codex') assert.ok(text.includes(initial));
    const repeat = planRegistration(client, runtime);
    assert.equal(repeat.changed, false, client.id);
    applyRegistration(repeat);
    assert.equal(readFileSync(client.path, 'utf8'), text);
    assert.equal(readFileSync(client.instructionsPath, 'utf8'), instructions);
    assert.equal(instructions.split('<!-- daybook:start -->').length, 2);
    assert.ok(readdirSync(dirname(client.path)).every(name => !/\.bak$|\.tmp$/.test(name)));
  }
});

test('OpenCode con JSON y JSONC registra ambos conservando ajustes e idempotencia', t => {
  const options = sandbox(t);
  const path = join(options.home, '.config', 'opencode', 'opencode.jsonc');
  mkdirSync(dirname(path), { recursive: true });
  const json = join(dirname(path), 'opencode.json');
  writeFileSync(json, '{"model":"json-model","unknown":true,"mcp":{"servers":{"other":{"command":["keep"]}}}}');
  writeFileSync(path, '{\n// conservar comentario\n"model":"keep",\n"mcp":{"servers":{"other":{"type":"remote","url":"https://example.com"},"bitacora":{"old":true}}},\n}\n');
  const client = getClients(options).find(client => client.id === 'opencode');
  assert.equal(client.detected, true);
  assert.equal(client.supported, true);
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'server.mjs'), dataHome: join(options.home, 'data') };
  const plan = planRegistration(client, runtime);
  assert.equal(plan.files.length, 2);
  applyRegistration(plan);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('// conservar comentario'));
  const parsed = parseJsonc(text);
  assert.equal(parsed.model, 'keep');
  assert.equal(parsed.mcp.servers.other.url, 'https://example.com');
  assert.equal(parsed.mcp.servers.bitacora.old, true);
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  const other = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(other.model, 'json-model');
  assert.equal(other.unknown, true);
  assert.deepEqual(other.mcp.servers.other.command, ['keep']);
  assert.deepEqual(other.mcp.servers.daybook, parsed.mcp.servers.daybook);
  assert.equal(planRegistration(client, runtime).changed, false);

  // Even a change to the second snapshot must abort before writing the first.
  const stale = planRegistration(client, { ...runtime, dataHome: join(options.home, 'new-data') });
  writeFileSync(json, readFileSync(json, 'utf8') + '\n');
  assert.throws(() => applyRegistration(stale), /changed after planning/);
  assert.equal(readFileSync(path, 'utf8'), text);
  rmSync(json);
  symlinkSync(path, json);
  assert.throws(() => planRegistration(client, runtime), /non-regular/);
});

test('Codex reemplaza tabla daybook y sus hijas sin tocar tablas ajenas', t => {
  const options = sandbox(t);
  const client = getClients(options).find(client => client.id === 'codex');
  mkdirSync(dirname(client.path), { recursive: true });
  const other = '[profiles.work]\n# comentario ajeno\nmodel = "keep"\n'
    + '[projects."/Users/test/a.b"]\ntrust_level = "trusted"\n'
    + '[[agents]]\nname = "first"\n[[agents]]\nname = "second"\n'
    + '[mcp_servers.bitacora]\ncommand = "custom"\n';
  writeFileSync(client.path, '[mcp_servers.daybook]\ncommand = "old"\n[mcp_servers.daybook.env]\nOLD = "old"\n' + other);
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'server.mjs'), dataHome: join(options.home, 'data') };
  applyRegistration(planRegistration(client, runtime));
  const text = readFileSync(client.path, 'utf8');
  assert.ok(text.includes(other));
  assert.equal(parseToml(text).mcp_servers.daybook.env.OLD, undefined);
  assert.equal(planRegistration(client, runtime).changed, false);
});

test('cuatro clientes exactos, rutas globales y esquema Antigravity IDE', t => {
  const { home } = sandbox(t);
  const env = Object.fromEntries(['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(key => [key, join(home, key)]));
  const clients = getClients({ home, env, platform: 'linux' });
  assert.deepEqual(clients.map(client => client.id), ['opencode', 'codex', 'antigravity', 'claude-code']);
  assert.deepEqual(clients.map(client => client.label), ['OpenCode', 'Codex', 'Antigravity', 'Claude Code']);
  assert.equal(clients[0].path, join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'));
  assert.equal(clients[1].path, join(env.CODEX_HOME, 'config.toml'));
  assert.equal(clients[2].path, join(home, '.gemini', 'config', 'mcp_config.json'));
  assert.equal(clients[3].path, join(env.CLAUDE_CONFIG_DIR, '.claude.json'));
  assert.deepEqual(clients.map(client => client.instructionsPath), [
    join(env.XDG_CONFIG_HOME, 'opencode', 'instructions', 'daybook.md'),
    join(env.CODEX_HOME, 'AGENTS.md'),
    join(home, '.gemini', 'GEMINI.md'),
    join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'),
  ]);
  const defaults = getClients({ home, env: {} });
  assert.equal(defaults[3].instructionsPath, join(home, '.claude', 'CLAUDE.md'));
  const runtime = { nodePath: join(home, 'node'), serverPath: join(home, 'server.mjs'), dataHome: join(home, 'data') };
  const plan = planRegistration(clients[2], runtime);
  assert.deepEqual(JSON.parse(plan.after), { mcpServers: { daybook: { command: runtime.nodePath, args: [runtime.serverPath], env: { DAYBOOK_HOME: runtime.dataHome } } } });
});

test('migra sólo el registro legacy propio con los mismos datos, incluso rutas Windows', t => {
  const options = sandbox(t);
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'server.mjs'), dataHome: join(options.home, 'data') };
  for (const client of getClients(options)) {
    mkdirSync(dirname(client.path), { recursive: true });
    const legacyPaths = [['bitacora', 'bitacora-local'], ['vimo-contex', 'vimo-contex'], ['vimo-cortex', 'vimo-cortex'], ['alba-cortex', 'alba-cortex']].flatMap(([id, pkg]) => [
      [id, join(options.home, 'node_modules', pkg, 'dist', 'mcp.js')],
      [id, `C:\\old\\node_modules\\${pkg}\\dist\\mcp.js`],
    ]);
    for (const [legacyId, legacyPath] of legacyPaths) {
      for (const sameHome of [true, false]) {
        const dataHome = sameHome ? runtime.dataHome : join(options.home, 'custom-data');
        const legacy = client.id === 'opencode'
          ? { type: 'local', command: [runtime.nodePath, legacyPath], environment: { BITACORA_HOME: dataHome } }
          : { command: runtime.nodePath, args: [legacyPath], env: { BITACORA_HOME: dataHome } };
        const initial = client.format === 'toml'
          ? `# conservar\nmodel = "keep"\n[mcp_servers.${legacyId}]\ncommand = ${JSON.stringify(runtime.nodePath)}\nargs = [${JSON.stringify(legacyPath)}]\n[mcp_servers.${legacyId}.env]\nBITACORA_HOME = ${JSON.stringify(dataHome)}\n[mcp_servers.other]\ncommand = "keep"\n`
          : JSON.stringify({ unknown: true, ...(client.id === 'opencode' ? { mcp: { servers: { [legacyId]: legacy, other: { command: 'keep' } } } } : { mcpServers: { [legacyId]: legacy, other: { command: 'keep' } } }) });
        writeFileSync(client.path, initial);
        applyRegistration(planRegistration(client, runtime));
        const text = readFileSync(client.path, 'utf8');
        const root = client.format === 'toml' ? parseToml(text) : JSON.parse(text);
        const servers = client.id === 'codex' ? root.mcp_servers : client.id === 'opencode' ? root.mcp.servers : root.mcpServers;
        assert.ok(servers.daybook);
        assert.equal(Object.hasOwn(servers, legacyId), !sameHome, client.id);
        if (!sameHome) assert.deepEqual(JSON.parse(JSON.stringify(servers[legacyId])), legacy);
        assert.equal(servers.other.command, 'keep');
        assert.equal(client.format === 'toml' ? root.model : root.unknown, client.format === 'toml' ? 'keep' : true);
        assert.equal(planRegistration(client, runtime).changed, false);
      }
    }
  }
});

test('Codex registra instrucciones en el primer archivo global no vacío', t => {
  const options = sandbox(t);
  const codexHome = join(options.home, 'custom-codex');
  options.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  const override = join(codexHome, 'AGENTS.override.md');
  const fallback = join(codexHome, 'AGENTS.md');
  writeFileSync(override, ' \n');
  writeFileSync(fallback, '# Fallback\n');
  assert.equal(getClients(options)[1].instructionsPath, fallback);
  const user = '# Effective rules\nDo not change me.\n';
  writeFileSync(override, user);
  const client = getClients(options)[1];
  assert.equal(client.instructionsPath, override);
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'server.mjs'), dataHome: join(options.home, 'data'), instructions: 'Memory rules' };
  applyRegistration(planRegistration(client, runtime));
  assert.ok(readFileSync(override, 'utf8').startsWith(user));
  assert.equal(readFileSync(fallback, 'utf8'), '# Fallback\n');
  assert.equal(planRegistration(client, runtime).changed, false);
});

test('migra el bloque de instrucciones anterior sin duplicar identidades ni cambiar texto ajeno', t => {
  const options = sandbox(t);
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'server.mjs'), dataHome: join(options.home, 'data'), instructions: 'Use daybook.' };
  for (const client of getClients(options).filter(client => client.id !== 'opencode')) {
    mkdirSync(dirname(client.instructionsPath), { recursive: true });
    const prefix = '# User rules\nKeep me.\n';
    const suffix = '\nOther instructions.\n';
    writeFileSync(client.instructionsPath, prefix + '<!-- vimo-cortex:start -->\nOld managed guidance.\n<!-- vimo-cortex:end -->' + suffix);
    applyRegistration(planRegistration(client, runtime));
    assert.equal(readFileSync(client.instructionsPath, 'utf8'), prefix + '<!-- daybook:start -->\nUse daybook.\n<!-- daybook:end -->' + suffix);
    assert.equal(planRegistration(client, runtime).changed, false);
    writeFileSync(client.instructionsPath, '<!-- vimo-cortex:start -->\nOld\n<!-- vimo-cortex:end -->\n<!-- daybook:start -->\nNew\n<!-- daybook:end -->');
    assert.throws(() => planRegistration(client, runtime), /ambiguous legacy instruction markers/);
  }
});

test('OpenCode migra una instalación anterior y su referencia sin borrar el archivo de instrucciones', t => {
  const options = sandbox(t);
  const client = getClients(options).find(client => client.id === 'opencode');
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'node_modules', '@vmorenoz', 'daybook', 'dist', 'mcp.js'), dataHome: join(options.home, 'data'), instructions: 'Use daybook.' };
  const previous = join(dirname(client.instructionsPath), 'vimo-cortex.md');
  mkdirSync(dirname(previous), { recursive: true });
  const oldInstructions = '<!-- vimo-cortex:start -->\nOld managed guidance.\n<!-- vimo-cortex:end -->\n';
  writeFileSync(previous, oldInstructions);
  writeFileSync(client.path, JSON.stringify({ instructions: ['/other/rules.md', previous], mcp: { servers: { 'vimo-cortex': { type: 'local', command: [runtime.nodePath, join(options.home, 'node_modules', 'vimo-cortex', 'dist', 'mcp.js')], environment: { BITACORA_HOME: runtime.dataHome } } } } }));
  applyRegistration(planRegistration(client, runtime));
  const config = JSON.parse(readFileSync(client.path, 'utf8'));
  assert.deepEqual(config.instructions, ['/other/rules.md', client.instructionsPath]);
  assert.equal(config.mcp.servers['vimo-cortex'], undefined);
  assert.ok(config.mcp.servers.daybook);
  assert.equal(readFileSync(previous, 'utf8'), oldInstructions);
  assert.match(readFileSync(client.instructionsPath, 'utf8'), /Use daybook/);
  assert.equal(planRegistration(client, runtime).changed, false);
});

for (const oldPackage of ['alba-daybook', '@vicodev/daybook']) test(`updates previous ${oldPackage} runtime to scoped package while preserving other settings`, t => {
  const options = sandbox(t);
  const oldPath = join(options.home, 'node_modules', oldPackage, 'dist', 'mcp.js');
  const runtime = { nodePath: join(options.home, 'node'), serverPath: join(options.home, 'node_modules', '@vmorenoz', 'daybook', 'dist', 'mcp.js'), dataHome: join(options.home, 'data') };
  for (const client of getClients(options)) {
    mkdirSync(dirname(client.path), { recursive: true });
    const old = client.id === 'opencode'
      ? { type: 'local', command: [runtime.nodePath, oldPath], environment: { DAYBOOK_HOME: runtime.dataHome } }
      : { command: runtime.nodePath, args: [oldPath], env: { DAYBOOK_HOME: runtime.dataHome } };
    const initial = client.format === 'toml'
      ? `model = "keep"\n[mcp_servers.daybook]\ncommand = ${JSON.stringify(runtime.nodePath)}\nargs = [${JSON.stringify(oldPath)}]\n[mcp_servers.daybook.env]\nDAYBOOK_HOME = ${JSON.stringify(runtime.dataHome)}\n[mcp_servers.other]\ncommand = "keep"\n`
      : JSON.stringify({ setting: 'keep', ...(client.id === 'opencode' ? { mcp: { servers: { daybook: old, other: { command: 'keep' } } } } : { mcpServers: { daybook: old, other: { command: 'keep' } } }) });
    writeFileSync(client.path, initial);
    applyRegistration(planRegistration(client, runtime));
    const parsed = client.format === 'toml' ? parseToml(readFileSync(client.path, 'utf8')) : JSON.parse(readFileSync(client.path, 'utf8'));
    const servers = client.id === 'codex' ? parsed.mcp_servers : client.id === 'opencode' ? parsed.mcp.servers : parsed.mcpServers;
    assert.equal(client.id === 'opencode' ? servers.daybook.command[1] : servers.daybook.args[0], runtime.serverPath);
    assert.equal((servers.daybook.env || servers.daybook.environment).DAYBOOK_HOME, runtime.dataHome);
    assert.equal(servers.other.command, 'keep');
    assert.equal(client.id === 'codex' ? parsed.model : parsed.setting, 'keep');
    assert.equal(planRegistration(client, runtime).changed, false);
  }
});
