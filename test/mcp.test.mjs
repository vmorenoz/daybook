import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { operationSchemas, operationDescriptions } from '../dist/schemas.js';

test('MCP stdio exposes only English operations and executes tools', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitacora-mcp-'));
  let client;
  let transport;
  try {
    client = new Client({ name: 'bitacora-test', version: '1.0.0' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/mcp.js', import.meta.url))],
      env: { ...process.env, DAYBOOK_HOME: home },
      stderr: 'inherit',
    });
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'daybook');
    const { tools } = await client.listTools();
    assert.equal(tools.length, Object.keys(operationSchemas).length);
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(operationSchemas).sort());
    const names = new Set(tools.map(tool => tool.name));
    for (const name of [
      'create_project', 'get_project', 'list_projects', 'update_project', 'delete_project',
      'delete_plan', 'delete_phase', 'delete_task', 'create_item', 'update_item',
      'get_summary', 'get_details', 'get_active_context', 'list_history', 'list_changes',
      'add_note', 'add_relation', 'remove_relation', 'reopen_item', 'create_backup',
    ]) assert.ok(names.has(name), name);
    for (const name of [
      'crear_proyecto', 'obtener_proyecto', 'listar_proyectos', 'actualizar_proyecto', 'eliminar_proyecto',
      'eliminar_plan', 'eliminar_fase', 'eliminar_tarea', 'registrar', 'actualizar',
      'obtener_resumen', 'obtener_detalle', 'obtener_contexto_activo', 'consultar_historico', 'consultar_cambios',
      'anotar', 'agregar_relacion', 'retirar_relacion', 'reabrir', 'crear_backup',
    ]) assert.ok(!names.has(name), name);
    for (const tool of tools) {
      assert.equal(tool.description, operationDescriptions[tool.name]);
      assert.doesNotMatch(tool.description, /\b(Crea|Obtiene|Lista|Actualiza|Elimina|Registra|Consulta|Agrega|Retira|Reabre|Copia)\b/);
    }
    for (const tool of tools.filter(tool => tool.name.startsWith('delete_'))) {
      assert.equal(tool.annotations.destructiveHint, true);
      assert.equal(tool.annotations.readOnlyHint, false);
      if (['delete_project', 'delete_task'].includes(tool.name)) {
        assert.ok(tool.inputSchema.required.includes('confirm'));
        assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'confirmar'));
      }
    }
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
      return response.structuredContent;
    };
    const project = await call('create_project', { name: 'MCP' });
    const project_id = project.id;
    const task = await call('create_item', { project_id, type: 'task', title: 'From stdio' });
    await call('update_item', { project_id, id: task.id, status: 'completed' });
    assert.ok(!(await call('get_active_context', { project_id })).items.some(item => item.id === task.id));
    assert.ok((await call('list_history', { project_id })).items.some(item => item.id === task.id));
    assert.equal((await call('reopen_item', { project_id, id: task.id })).id, task.id);
    assert.deepEqual(await call('delete_task', { project_id, id: task.id, confirm: true }), {
      project_id, id: task.id, type: 'task', deleted: true, documents_deleted: false,
    });
    assert.deepEqual((await call('get_active_context', { project_id })).items, []);
    assert.deepEqual(await call('delete_project', { project_id, confirm: true }), {
      project_id, deleted: true, documents_deleted: false,
    });
    assert.deepEqual((await call('list_projects', {})).items, []);
  } finally {
    try { await client?.close(); } finally {
      try { await transport?.close(); } finally { await rm(home, { recursive: true, force: true }); }
    }
  }
});
