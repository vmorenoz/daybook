/** Boundary translation only: storage, event snapshots and fingerprints stay legacy-compatible. */
export const legacyOperations = {
  create_project: 'crear_proyecto', get_project: 'obtener_proyecto', list_projects: 'listar_proyectos',
  update_project: 'actualizar_proyecto', delete_project: 'eliminar_proyecto', delete_plan: 'eliminar_plan',
  delete_phase: 'eliminar_fase', delete_task: 'eliminar_tarea', create_item: 'registrar', update_item: 'actualizar',
  get_summary: 'obtener_resumen', get_details: 'obtener_detalle', get_active_context: 'obtener_contexto_activo',
  list_history: 'consultar_historico', list_changes: 'consultar_cambios', add_note: 'anotar',
  add_relation: 'agregar_relacion', remove_relation: 'retirar_relacion', reopen_item: 'reabrir', create_backup: 'crear_backup',
} as const;

const fields: Record<string, string> = {
  proyecto_id: 'project_id', nombre: 'name', descripcion: 'description', repositorios: 'repositories',
  tipo: 'type', titulo: 'title', estado: 'status', documento_ruta: 'document_path', fase_id: 'phase_id',
  criterios: 'acceptance_criteria', evidencias: 'evidence', confirmar: 'confirm', destino_id: 'target_id',
  texto: 'text', referencia: 'reference', motivo: 'reason', ruta_destino: 'destination_path',
  creado_en: 'created_at', modificado_en: 'updated_at', cerrado_en: 'closed_at', bloqueo_actual: 'current_blocker',
  bloqueo: 'blocker', dependencias: 'dependencies', relaciones: 'relations', anotacion: 'annotation',
  registro_id: 'item_id', operacion: 'operation', antes: 'before', despues: 'after', fases: 'phases', tareas: 'tasks',
  tipo_esperado: 'expected_type', tipo_actual: 'actual_type', eliminado: 'deleted', documentos_eliminados: 'documents_deleted',
  ruta: 'path', base_datos: 'database_path', documentos_ruta: 'documents_path', alcance: 'scope',
  documentos_copiados: 'documents_copied', rutas_externas_no_copiadas: 'external_paths_not_copied',
  rutas_omitidas: 'skipped_paths', limitaciones: 'limitations', copia_incompleta: 'incomplete_copy',
};
const statuses: Record<string, string> = {
  pendiente: 'pending', en_planificacion: 'planning', en_curso: 'in_progress', bloqueado: 'blocked', terminado: 'completed', cancelado: 'cancelled',
};
const types: Record<string, string> = {
  plan: 'plan', fase: 'phase', tarea: 'task', avance: 'progress', acuerdo: 'agreement', bloqueo: 'blocker',
  nota: 'note', evidencia: 'evidence', depende_de: 'depends_on', relacionado: 'related', contribuye_a: 'contributes_to',
};
const invert = (map: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(map).map(([key, value]) => [value, key]));
const inputFields = invert(fields);
const inputStatuses = invert(statuses);
const inputTypes = invert(types);
const operations = { ...invert(legacyOperations), derivar_plan: 'derive_plan' };
const lookup = (map: Record<string, string>, value: string): string => Object.hasOwn(map, value) ? map[value]! : value;

export function toLegacyInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    lookup(inputFields, key),
    typeof value === 'string' && key === 'status' ? lookup(inputStatuses, value)
      : typeof value === 'string' && key === 'type' ? lookup(inputTypes, value) : value,
  ]));
}

const backupMessages: Record<string, string> = {
  'Base de datos completa de todos los proyectos y archivos regulares gestionados en home/projects.': 'Complete database of all projects and regular files managed in home/projects.',
  'La base de datos es consistente; la copia de documentos no es atómica respecto de ediciones externas.': 'The database is consistent; document copying is not atomic with respect to external edits.',
  'No se siguen enlaces simbólicos ni se copian documentos externos.': 'Symbolic links are not followed and external documents are not copied.',
  'Los archivos copiados no constituyen un historial de versiones.': 'Copied files do not constitute a version history.',
};

/** Translate only known field names and typed values, never arbitrary user text. */
export function toPublicResult(value: unknown, field?: string): unknown {
  if (Array.isArray(value)) return value.map(item => toPublicResult(item, field));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [lookup(fields, key), toPublicResult(item, key)]));
  }
  if (typeof value !== 'string') return value;
  if (field === 'estado') return lookup(statuses, value);
  if (field === 'tipo' || field === 'tipo_esperado' || field === 'tipo_actual') return lookup(types, value);
  if (field === 'operacion') return lookup(operations, value);
  if (field === 'alcance' || field === 'limitaciones') return lookup(backupMessages, value);
  return value;
}
