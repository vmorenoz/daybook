import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bitacora } from '../dist/core.js';

test('English API preserves user text, Spanish aliases, hierarchy and persisted data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitacora-english-'));
  let core;
  try {
    core = new Bitacora({ home });
    const project = await core.execute('create_project', { name: 'pendiente', request_id: 'shared-project' });
    const legacy = await core.execute('crear_proyecto', { nombre: 'pendiente', request_id: 'shared-project' });
    assert.deepEqual(legacy, { id: project.id, nombre: 'pendiente', version: project.version });
    const project_id = project.id;
    const call = (operation, input = {}) => core.execute(operation, { project_id, ...input });
    const plan = await call('create_item', { type: 'plan', title: 'pendiente' });
    const phase = await call('create_item', { type: 'phase', title: 'pendiente', plan_id: plan.id });
    const task = await call('create_item', {
      type: 'task', title: 'pendiente', description: 'pendiente', phase_id: phase.id,
      acceptance_criteria: ['pendiente'], evidence: ['pendiente'],
    });
    assert.equal(task.plan_id, plan.id);
    assert.equal(task.phase_id, phase.id);
    assert.equal(task.type, 'task');
    assert.equal(task.status, 'pending');
    await call('add_note', { id: task.id, type: 'blocker', text: 'pendiente', reference: 'pendiente' });
    await call('add_relation', { id: task.id, target_id: plan.id, type: 'depends_on' });
    const details = await call('get_details', { id: task.id });
    assert.equal(details.project_id, project_id);
    assert.equal(details.title, 'pendiente');
    assert.equal(details.description, 'pendiente');
    assert.deepEqual(details.acceptance_criteria, ['pendiente']);
    assert.deepEqual(details.evidence, ['pendiente']);
    assert.equal(details.relations[0].type, 'depends_on');
    assert.equal(details.relations[0].target_id, plan.id);
    assert.ok(details.created_at);
    assert.ok(details.updated_at);
    const changes = await call('list_changes', { id: task.id });
    const note = changes.items.find(item => item.annotation?.text === 'pendiente').annotation;
    assert.equal(note.type, 'blocker');
    assert.equal(note.reference, 'pendiente');
    const spanish = await core.execute('obtener_resumen', { proyecto_id: project_id, id: task.id });
    assert.equal(spanish.id, task.id);
    assert.equal(spanish.tipo, 'tarea');
    assert.equal(spanish.estado, 'pendiente');
    assert.equal(spanish.titulo, 'pendiente');
    assert.equal((await call('update_item', { id: task.id, status: 'completed' })).status, 'completed');
    assert.ok((await call('list_history')).items.some(item => item.id === task.id));
    assert.ok(!(await call('get_active_context')).items.some(item => item.id === task.id));
    assert.equal((await call('reopen_item', { id: task.id, reason: 'pendiente' })).status, 'pending');
    const old = await core.execute('registrar', {
      proyecto_id: project_id, tipo: 'tarea', titulo: 'pendiente', estado: 'en_curso',
    });
    const beforeRestart = await call('get_details', { id: task.id });
    await core.close();
    core = new Bitacora({ home });
    assert.deepEqual(await call('get_details', { id: task.id }), beforeRestart);
    const persisted = await call('get_summary', { id: old.id });
    assert.equal(persisted.id, old.id);
    assert.equal(persisted.type, 'task');
    assert.equal(persisted.status, 'in_progress');
    assert.equal(persisted.title, 'pendiente');
  } finally {
    try { await core?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test('English ordered deletion and project cascade preserve document files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitacora-english-delete-'));
  let core;
  try {
    const document_path = join(home, 'plan.md');
    await writeFile(document_path, 'pendiente');
    core = new Bitacora({ home });
    const project = await core.execute('create_project', { name: 'Delete' });
    const project_id = project.id;
    const call = (operation, input = {}) => core.execute(operation, { project_id, ...input });
    const plan = await call('create_item', { type: 'plan', title: 'Plan', document_path });
    const phase = await call('create_item', { type: 'phase', title: 'Phase', plan_id: plan.id });
    const task = await call('create_item', { type: 'task', title: 'Task', phase_id: phase.id, status: 'completed' });
    for (const [operation, item] of [['delete_task', task], ['delete_phase', phase], ['delete_plan', plan]]) {
      assert.deepEqual(await call(operation, { id: item.id, ...(item.type === 'task' ? { confirm: true } : {}) }), {
        project_id, id: item.id, type: item.type, deleted: true, documents_deleted: false,
      });
    }
    assert.deepEqual((await call('get_active_context')).items, []);
    assert.equal(await readFile(document_path, 'utf8'), 'pendiente');
    const cascade = await call('create_item', { type: 'plan', title: 'Cascade', document_path });
    await call('create_item', { type: 'task', title: 'Child', plan_id: cascade.id });
    assert.deepEqual(await call('delete_project', { confirm: true }), {
      project_id, deleted: true, documents_deleted: false,
    });
    assert.deepEqual((await core.execute('list_projects', {})).items, []);
    assert.equal(await readFile(document_path, 'utf8'), 'pendiente');
  } finally {
    try { await core?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
});
