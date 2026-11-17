import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daybook } from '../dist/index.js';

test('CLI shares validated operations and persistence with the API', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daybook-cli-'));
  const run = (args, input) => spawnSync(process.execPath, ['dist/cli.js', ...args], {
    env: { ...process.env, DAYBOOK_HOME: home, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', input,
  });
  try {
    const help = run(['--help']).stdout;
    assert.match(help, /Projects[\s\S]*list_projects[\s\S]*create_project/);
    assert.match(help, /Delete \(irreversible\)/);
    assert.match(help, /Examples:/);
    const { operationSchemas } = await import('../dist/schemas.js');
    for (const name of Object.keys(operationSchemas)) assert.match(help, new RegExp(`\\b${name}\\b`));
    assert.match(run(['create_item', '--help']).stdout, /project_id/);
    assert.match(run(['create_item', '--help']).stdout, /--project-id/);
    assert.equal(run(['unknown']).status, 1);
    assert.equal(run(['list_projects', '{']).status, 1);
    const created = run(['create_project', '--name', 'CLI project', '--repositories', '/one', '--repositories', '/two', '--json']);
    assert.equal(created.status, 0, created.stderr);
    const project = JSON.parse(created.stdout);
    const listing = run(['list_projects']);
    assert.equal(listing.stdout, `name: CLI project\nid: ${project.id}\nversion: 1\n`);
    assert.equal(run(['create_project', '--name', 'Second']).status, 0);
    const paged = run(['list_projects', '--limit', '1']);
    assert.match(paged.stdout, /next offset: 1/);
    assert.match(run(['list_projects']).stdout, /\n---\nname: /);
    const api = new Daybook({ home });
    try {
      assert.equal((await api.execute('get_project', { project_id: project.id })).name, 'CLI project');
    } finally { api.close(); }
    const task = run(['create_item', '--project-id', project.id, '--type', 'task', '--title', 'Example', '--json']);
    assert.equal(task.status, 0, task.stderr);
    const denied = run(['delete_task', JSON.stringify({ project_id: project.id, id: JSON.parse(task.stdout).id }), '--json']);
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(denied.stderr).code, 'VALIDATION_ERROR');
    const context = run(['get_active_context', JSON.stringify({ project_id: project.id })]);
    assert.equal(context.status, 0, context.stderr);
    assert.match(context.stdout, /Example/);
    assert.doesNotMatch(context.stdout, /^\s*\{/);
    assert.match(run(['delete_task', '{}']).stderr, /Error \(VALIDATION_ERROR\)/);
    assert.equal(run(['list_projects', '--limit', 'abc']).status, 1);
    assert.equal(run(['list_projects', '--unknown', 'x']).status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
