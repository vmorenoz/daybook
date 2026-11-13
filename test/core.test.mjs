import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bitacora } from '../dist/core.js';

test('flujo jerárquico, tareas sueltas, histórico y persistencia', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitacora-core-'));
  let core;
  try {
    core = new Bitacora({ home });
    const proyecto = await core.execute('crear_proyecto', { nombre: 'Prueba' });
    const proyecto_id = proyecto.id;
    const call = (operation, input = {}) => core.execute(operation, { proyecto_id, ...input });
    const plan = await call('registrar', { tipo: 'plan', titulo: 'Plan', documento_ruta: '/planes/prueba.md' });
    const fase = await call('registrar', { tipo: 'fase', titulo: 'Fase', plan_id: plan.id });
    const tarea = await call('registrar', { tipo: 'tarea', titulo: 'Tarea', fase_id: fase.id });
    await call('anotar', { id: tarea.id, tipo: 'bloqueo', texto: 'Pendiente de acuerdo' });
    await call('anotar', { id: tarea.id, tipo: 'avance', texto: 'Acuerdo resuelto' });
    const terminada = await call('actualizar', { id: tarea.id, estado: 'terminado' });
    assert.equal(terminada.estado, 'terminado');
    assert.ok(!(await call('obtener_contexto_activo')).items.some(item => item.id === tarea.id));
    assert.ok((await call('consultar_historico')).items.some(item => item.id === tarea.id));
    const reabierta = await call('reabrir', { id: tarea.id });
    assert.equal(reabierta.id, tarea.id);
    assert.ok((await call('obtener_contexto_activo')).items.some(item => item.id === tarea.id));
    for (let i = 0; i < 3; i++) {
      const suelta = await call('registrar', { tipo: 'tarea', titulo: `Suelta ${i}` });
      await call('actualizar', { id: suelta.id, estado: 'en_curso' });
      await call('actualizar', { id: suelta.id, estado: 'terminado' });
    }
    assert.equal((await call('consultar_historico')).items.length, 3);
    await core.close();
    core = undefined;
    core = new Bitacora({ home });
    const persisted = await call('obtener_resumen', { id: tarea.id });
    assert.equal(persisted.id, tarea.id);
    assert.equal(persisted.estado, reabierta.estado);
    assert.equal((await call('consultar_historico')).items.length, 3);
  } finally {
    try { await core?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
});
