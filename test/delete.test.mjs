import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bitacora } from '../dist/core.js';

test('eliminación ordenada y de proyecto en cascada conserva documentos y otros proyectos', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitacora-delete-'));
  let core;
  try {
    const documentos = join(home, 'repo', '.work', 'planes');
    await mkdir(documentos, { recursive: true });
    const documento_ruta = join(documentos, 'plan.md');
    const contenido = '# Plan conservado\n';
    await writeFile(documento_ruta, contenido);
    core = new Bitacora({ home });
    const proyecto = await core.execute('crear_proyecto', { nombre: 'Conservado' });
    const proyecto_id = proyecto.id;
    const call = (operation, input = {}) => core.execute(operation, { proyecto_id, ...input });
    const plan = await call('registrar', { tipo: 'plan', titulo: 'Plan', documento_ruta });
    const fase = await call('registrar', { tipo: 'fase', titulo: 'Fase', plan_id: plan.id });
    const tarea = await call('registrar', { tipo: 'tarea', titulo: 'Tarea de fase', fase_id: fase.id });
    const directa = await call('registrar', { tipo: 'tarea', titulo: 'Tarea directa', plan_id: plan.id });
    await call('agregar_relacion', { id: tarea.id, destino_id: directa.id, tipo: 'relacionado' });
    await call('anotar', { id: tarea.id, tipo: 'nota', texto: 'Trabajo de prueba' });
    const eliminar = { id: tarea.id, confirmar: true, request_id: 'eliminar-tarea' };
    const recibo = await call('eliminar_tarea', eliminar);
    assert.equal(recibo.eliminado, true);
    assert.equal(recibo.documentos_eliminados, false);
    assert.deepEqual(await call('eliminar_tarea', eliminar), recibo);
    assert.deepEqual((await call('obtener_detalle', { id: directa.id })).relaciones, []);
    for (const [operation, input] of [
      ['eliminar_tarea', { id: directa.id, confirmar: true }],
      ['eliminar_fase', { id: fase.id }],
      ['eliminar_plan', { id: plan.id }],
    ]) {
      const resultado = await call(operation, input);
      assert.equal(resultado.eliminado, true);
      assert.equal(resultado.documentos_eliminados, false);
    }
    assert.deepEqual((await call('obtener_contexto_activo')).items, []);
    assert.deepEqual((await call('consultar_historico')).items, []);
    assert.equal(await readFile(documento_ruta, 'utf8'), contenido);

    const conservada = await call('registrar', { tipo: 'tarea', titulo: 'No eliminar' });
    const cascada = await core.execute('crear_proyecto', { nombre: 'Eliminar en cascada' });
    const otro = (operation, input = {}) => core.execute(operation, { proyecto_id: cascada.id, ...input });
    const planAbierto = await otro('registrar', { tipo: 'plan', titulo: 'Plan abierto', documento_ruta, request_id: 'plan-abierto' });
    const faseAbierta = await otro('registrar', { tipo: 'fase', titulo: 'Fase abierta', plan_id: planAbierto.id });
    const tareaAbierta = await otro('registrar', { tipo: 'tarea', titulo: 'Tarea abierta', fase_id: faseAbierta.id });
    await otro('agregar_relacion', { id: tareaAbierta.id, destino_id: planAbierto.id, tipo: 'contribuye_a' });
    await otro('anotar', { id: tareaAbierta.id, tipo: 'nota', texto: 'Incluida en cascada' });
    const resultado = await otro('eliminar_proyecto', { confirmar: true });
    assert.equal(resultado.proyecto_id, cascada.id);
    assert.equal(resultado.eliminado, true);
    assert.equal(resultado.documentos_eliminados, false);
    assert.deepEqual((await core.execute('listar_proyectos', {})).items, [proyecto]);
    assert.deepEqual((await call('obtener_contexto_activo')).items.map(item => item.id), [conservada.id]);
    assert.equal(await readFile(documento_ruta, 'utf8'), contenido);
  } finally {
    try { await core?.close(); } finally { await rm(home, { recursive: true, force: true }); }
  }
});
