import { z } from 'zod';

export const estados = ['pendiente', 'en_planificacion', 'en_curso', 'bloqueado', 'terminado', 'cancelado'] as const;
export const tipos = ['plan', 'fase', 'tarea'] as const;
const texto = z.string().trim().min(1);
const id = z.string().uuid();
const scope = { proyecto_id: id };
const target = { ...scope, id };
const paging = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) };
const mutation = { request_id: texto.max(200).optional() };
const version = { expected_version: z.number().int().min(1).optional() };
const confirmation = { confirmar: z.literal(true).describe('Solo true después de obtener confirmación explícita del usuario para esta eliminación irreversible. No confirmar automáticamente.') };
const fields = {
  titulo: texto,
  descripcion: z.string().optional(),
  documento_ruta: texto.optional(),
  plan_id: id.nullable().optional(),
  fase_id: id.nullable().optional(),
  criterios: z.array(texto).optional(),
  evidencias: z.array(texto).optional(),
  estado: z.enum(estados).optional(),
};
const filters = { tipo: z.enum(tipos).optional(), plan_id: id.optional(), fase_id: id.optional(), estado: z.enum(estados).optional() };
const relation = { ...target, destino_id: id, tipo: z.enum(['depende_de', 'relacionado', 'contribuye_a']), ...version, ...mutation };

export const legacyOperationSchemas = {
  crear_proyecto: z.object({ nombre: texto, descripcion: z.string().optional(), repositorios: z.array(texto).optional(), ...mutation }).strict(),
  obtener_proyecto: z.object(scope).strict(),
  listar_proyectos: z.object(paging).strict(),
  actualizar_proyecto: z.object({ ...scope, nombre: texto.optional(), descripcion: z.string().nullable().optional(), repositorios: z.array(texto).optional(), ...version, ...mutation }).strict(),
  eliminar_proyecto: z.object({ ...scope, ...confirmation, ...version, ...mutation }).strict(),
  eliminar_plan: z.object({ ...target, ...version, ...mutation }).strict(),
  eliminar_fase: z.object({ ...target, ...version, ...mutation }).strict(),
  eliminar_tarea: z.object({ ...target, ...confirmation, ...version, ...mutation }).strict(),
  registrar: z.object({ ...scope, tipo: z.enum(tipos), ...fields, ...mutation }).strict(),
  actualizar: z.object({ ...target, tipo: z.enum(tipos).optional(), ...fields, titulo: texto.optional(), descripcion: z.string().nullable().optional(), documento_ruta: texto.nullable().optional(), ...version, ...mutation }).strict(),
  obtener_resumen: z.object(target).strict(),
  obtener_detalle: z.object(target).strict(),
  obtener_contexto_activo: z.object({ ...scope, ...filters, ...paging }).strict(),
  consultar_historico: z.object({ ...scope, ...filters, ...paging }).strict(),
  consultar_cambios: z.object({ ...scope, id: id.optional(), ...paging }).strict(),
  anotar: z.object({ ...target, tipo: z.enum(['avance', 'acuerdo', 'bloqueo', 'nota', 'evidencia']), texto, referencia: texto.optional(), ...version, ...mutation }).strict(),
  agregar_relacion: z.object(relation).strict(),
  retirar_relacion: z.object(relation).strict(),
  reabrir: z.object({ ...target, estado: z.enum(['pendiente', 'en_planificacion', 'en_curso', 'bloqueado']).default('pendiente'), motivo: texto.optional(), ...version, ...mutation }).strict(),
  crear_backup: z.object({ proyecto_id: id.optional(), ruta_destino: texto.optional(), ...mutation }).strict(),
};

const documento = ' Los documentos Markdown se crean y editan externamente; solo se registra su ruta absoluta, nunca su contenido. Se recomienda incluir Título, Objetivo y Alcances; criterios, acuerdos, enfoque, dependencias y evidencias son opcionales.';
export const legacyOperationDescriptions: Record<keyof typeof legacyOperationSchemas, string> = {
  crear_proyecto: 'Crea un proyecto local sin modificar repositorios. Devuelve su ID y versión.',
  obtener_proyecto: 'Obtiene los metadatos de un proyecto por su ID explícito.',
  listar_proyectos: 'Lista proyectos con paginación; no selecciona un proyecto global.',
  actualizar_proyecto: 'Actualiza metadatos del proyecto con control de versión opcional.',
  eliminar_proyecto: 'Eliminación irreversible del proyecto y, en cascada, todos sus planes, fases, tareas, anotaciones, relaciones e historial. Requiere confirmación explícita previa del usuario (confirmar: true); nunca confirmar automáticamente. Invalida respuestas idempotentes antiguas; solo conserva el recibo mínimo de esta solicitud si tiene request_id. No elimina documentos, .work ni ningún archivo o directorio, incluidos home/projects y rutas externas; el usuario decide su limpieza manual.',
  eliminar_plan: 'Elimina irreversiblemente un plan solo si no tiene fases ni tareas directas o derivadas, incluidas las terminadas o canceladas; si quedan hijos devuelve HAS_CHILDREN sin borrar nada. Elimina sus anotaciones, relaciones e historial e invalida respuestas idempotentes antiguas. No elimina documentos ni archivos; su limpieza es manual.',
  eliminar_fase: 'Elimina irreversiblemente una fase solo si no tiene tareas de ningún estado, incluidas las terminadas o canceladas; si quedan tareas devuelve HAS_CHILDREN sin borrar nada. Elimina sus anotaciones, relaciones e historial e invalida respuestas idempotentes antiguas. No elimina documentos ni archivos; su limpieza es manual.',
  eliminar_tarea: 'Elimina irreversiblemente una tarea, sus anotaciones, relaciones e historial e invalida respuestas idempotentes antiguas. Requiere confirmación explícita previa del usuario (confirmar: true); nunca confirmar automáticamente. No elimina documentos ni archivos; el usuario decide su limpieza manual.',
  registrar: 'Registra plan, fase o tarea; admite tareas sueltas, fases independientes y tareas directas de plan. Devuelve un resumen.' + documento,
  actualizar: 'Actualiza datos, pertenencia o estado sin cerrar descendientes. Los arrays proporcionados reemplazan los existentes; null retira campos opcionales. Devuelve un resumen.' + documento,
  obtener_resumen: 'Obtiene ID, tipo, título, estado, versión, pertenencia y ruta documental, sin historial.',
  obtener_detalle: 'Obtiene metadatos, criterios, evidencias, relaciones y fechas; no expande historial ni archivos.',
  obtener_contexto_activo: 'Lista todo trabajo no terminado ni cancelado, independientemente del padre; incluye bloqueos actuales y dependencias relevantes, sin historial ni evidencias anteriores.',
  consultar_historico: 'Consulta explícitamente trabajo terminado o cancelado, en proyección mínima y paginada.',
  consultar_cambios: 'Consulta eventos y anotaciones del proyecto o registro, con instantáneas antes/después y paginación.',
  anotar: 'Registra avance, acuerdo, bloqueo, nota o referencia de evidencia. No cambia automáticamente el estado ni crea archivos. El último bloqueo permanece en contexto hasta actualizar explícitamente a un estado distinto de bloqueado o reabrir.',
  agregar_relacion: 'Agrega una relación dirigida dentro del mismo proyecto; no altera estados.',
  retirar_relacion: 'Retira una relación dirigida conservando trazabilidad.',
  reabrir: 'Reabre exclusivamente trabajo cerrado conservando ID, evidencias y relaciones; motivo opcional.',
  crear_backup: 'Copia consistentemente toda la BD y los documentos gestionados en home/projects; no copia rutas externas ni garantiza atomicidad con ediciones externas. proyecto_id, si se indica, valida el proyecto pero no limita la copia global.',
};
