import { randomUUID, createHash } from 'node:crypto';
import { backup } from 'node:sqlite';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { operationSchemas } from './schemas.js';
import { legacyOperationSchemas } from './legacy-schemas.js';
import { legacyOperations, toLegacyInput, toPublicResult } from './public-api.js';
import { Storage } from './storage.js';

type Kind = 'plan' | 'fase' | 'tarea';
type State = 'pendiente' | 'en_planificacion' | 'en_curso' | 'bloqueado' | 'terminado' | 'cancelado';
interface Project {
  id: string; nombre: string; descripcion?: string; repositorios: string[];
  version: number; creado_en: string; modificado_en: string;
}
interface RecordData {
  id: string; proyecto_id: string; tipo: Kind; titulo: string; descripcion?: string;
  estado: State; documento_ruta?: string; plan_id?: string; fase_id?: string;
  criterios: string[]; evidencias: string[]; version: number; creado_en: string;
  modificado_en: string; cerrado_en?: string;
  bloqueo_actual?: { texto: string; referencia?: string; creado_en: string };
}
// All values in Input have already passed the exported operation schema.
type Input = Record<string, unknown>;
const closed = (state: string) => state === 'terminado' || state === 'cancelado';
const now = () => new Date().toISOString();
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
};

export class BitacoraError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'BitacoraError';
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) }; }
}

export class Bitacora {
  readonly home: string;
  private readonly storage: Storage;
  private closed = false;
  private backups = 0;

  constructor(options: { home?: string } = {}) {
    this.home = resolve(options.home ?? process.env.DAYBOOK_HOME ?? process.env.BITACORA_HOME ?? join(homedir(), '.local', 'share', 'bitacora'));
    try { this.storage = new Storage(this.home); }
    catch (error) { throw this.translate(error); }
  }

  execute(operation: string, input: unknown): unknown | Promise<unknown> {
    if (!Object.hasOwn(operationSchemas, operation)) return this.executeLegacy(operation, input);
    const publicOperation = operation as keyof typeof operationSchemas;
    const translateError = (error: unknown): never => {
      const translated = this.translate(error);
      throw new BitacoraError(translated.code, translated.message, toPublicResult(translated.details));
    };
    try {
      if (this.closed) throw new BitacoraError('CLOSED', 'Daybook is closed.');
      const parsed = operationSchemas[publicOperation].safeParse(input);
      if (!parsed.success) throw new BitacoraError('VALIDATION_ERROR', 'Invalid input.', parsed.error.issues);
      const result = this.executeLegacy(legacyOperations[publicOperation], toLegacyInput(parsed.data));
      return result instanceof Promise ? result.then(value => toPublicResult(value)).catch(translateError) : toPublicResult(result);
    } catch (error) { return translateError(error); }
  }

  private executeLegacy(operation: string, input: unknown): unknown | Promise<unknown> {
    if (this.closed) throw new BitacoraError('CLOSED', 'Daybook is closed.');
    if (!Object.hasOwn(legacyOperationSchemas, operation)) throw new BitacoraError('UNKNOWN_OPERATION', 'Unknown operation: ' + operation);
    const schema = legacyOperationSchemas[operation as keyof typeof legacyOperationSchemas];
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new BitacoraError('VALIDATION_ERROR', 'Invalid input.', parsed.error.issues);
    const data = parsed.data as Input;
    try {
      if (operation === 'crear_backup') return this.createBackup(data).catch(error => { throw this.translate(error); });
      const mutations = ['crear_proyecto', 'actualizar_proyecto', 'eliminar_proyecto', 'eliminar_plan', 'eliminar_fase', 'eliminar_tarea', 'registrar', 'actualizar', 'anotar', 'agregar_relacion', 'retirar_relacion', 'reabrir'];
      if (mutations.includes(operation)) return this.storage.transaction(() => {
        const cached = this.cached(operation, data);
        if (cached.found) return cached.response;
        const result = this.dispatch(operation, data);
        this.remember(operation, data, result);
        return result;
      });
      // A read transaction keeps multi-query projections consistent with concurrent writers.
      this.storage.db.exec('BEGIN');
      try {
        const result = this.dispatch(operation, data);
        this.storage.db.exec('COMMIT');
        return result;
      } catch (error) { this.storage.db.exec('ROLLBACK'); throw error; }
    } catch (error) { throw this.translate(error); }
  }

  close(): void {
    if (this.closed) return;
    if (this.backups) throw new BitacoraError('BACKUP_IN_PROGRESS', 'Wait for the backup to finish before closing.');
    this.storage.db.close();
    this.closed = true;
  }

  private translate(error: unknown): BitacoraError {
    if (error instanceof BitacoraError) return error;
    const message = (error instanceof Error ? error.message : String(error)).replace(/^Versión de base de datos no soportada: /, 'Unsupported database version: ');
    if (/database is locked|database is busy|SQLITE_BUSY/.test(message)) return new BitacoraError('BUSY', 'Database is busy; please retry.');
    return new BitacoraError('STORAGE_ERROR', message);
  }

  private absolute(path: string): string {
    if (!isAbsolute(path) || path.includes('\0')) throw new BitacoraError('VALIDATION_ERROR', 'A valid absolute path is required.', { ruta: path });
    return normalize(path);
  }

  private project(id: string): Project {
    const row = this.storage.get('SELECT data FROM projects WHERE id=?', id);
    if (!row) throw new BitacoraError('NOT_FOUND', 'Project not found.', { proyecto_id: id });
    return JSON.parse(String(row.data)) as Project;
  }

  private record(project: string, id: string): RecordData {
    const row = this.storage.get('SELECT data FROM records WHERE proyecto_id=? AND id=?', project, id);
    if (!row) throw new BitacoraError('NOT_FOUND', 'Item not found in the specified project.', { proyecto_id: project, id });
    return JSON.parse(String(row.data)) as RecordData;
  }

  private summary(record: RecordData) {
    return {
      id: record.id, tipo: record.tipo, titulo: record.titulo, estado: record.estado,
      ...(record.documento_ruta ? { documento_ruta: record.documento_ruta } : {}), version: record.version,
      ...(record.plan_id ? { plan_id: record.plan_id } : {}), ...(record.fase_id ? { fase_id: record.fase_id } : {}),
    };
  }

  private projectSummary(project: Project) { return { id: project.id, nombre: project.nombre, version: project.version }; }

  private assertVersion(record: { version: number }, data: Input) {
    if (data.expected_version !== undefined && record.version !== data.expected_version) throw new BitacoraError('VERSION_CONFLICT', 'The item was modified by another consumer.', { expected_version: data.expected_version, actual_version: record.version });
  }

  private fingerprint(operation: string, data: Input) {
    const { request_id: _request, ...payload } = data;
    return createHash('sha256').update(canonical({ operation, payload })).digest('hex');
  }

  private cached(operation: string, data: Input): { found: boolean; response?: unknown } {
    if (!data.request_id) return { found: false };
    const scope = operation === 'crear_backup' ? 'global:backup' : String(data.proyecto_id ?? 'global:projects');
    const row = this.storage.get('SELECT fingerprint,response FROM requests WHERE scope=? AND request_id=?', scope, String(data.request_id));
    if (!row) return { found: false };
    if (row.fingerprint !== this.fingerprint(operation, data)) throw new BitacoraError('IDEMPOTENCY_CONFLICT', 'request_id was already used with a different operation or data.');
    if (row.response === null) throw new BitacoraError('REQUEST_IN_PROGRESS', 'The request is in progress; if the process was interrupted, use a new request_id.');
    const response = JSON.parse(String(row.response)) as unknown;
    if (response !== null && typeof response === 'object' && '__deleted' in response && response.__deleted === true) throw new BitacoraError('RESOURCE_DELETED', 'The resource for this request was deleted; its previous response is no longer available.');
    return { found: true, response };
  }

  private remember(operation: string, data: Input, response: unknown) {
    if (!data.request_id) return;
    const scope = operation === 'crear_backup' ? 'global:backup' : String(data.proyecto_id ?? 'global:projects');
    this.storage.run('INSERT INTO requests(scope,request_id,fingerprint,response) VALUES(?,?,?,?)', scope, String(data.request_id), this.fingerprint(operation, data), JSON.stringify(response));
  }

  private event(project: string, id: string | null, operation: string, before: unknown, after: unknown, annotation?: unknown) {
    this.storage.run('INSERT INTO events(id,proyecto_id,registro_id,operacion,antes,despues,anotacion,creado_en) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), project, id, operation, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), annotation === undefined ? null : JSON.stringify(annotation), now());
  }

  private save(record: RecordData) {
    this.storage.run(`INSERT INTO records(id,proyecto_id,tipo,estado,plan_id,fase_id,version,data) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET tipo=excluded.tipo, estado=excluded.estado, plan_id=excluded.plan_id, fase_id=excluded.fase_id, version=excluded.version, data=excluded.data`,
      record.id, record.proyecto_id, record.tipo, record.estado, record.plan_id ?? null, record.fase_id ?? null, record.version, JSON.stringify(record));
  }

  private hierarchy(record: RecordData, data: Input) {
    if (record.tipo === 'plan' && (record.plan_id || record.fase_id)) throw new BitacoraError('INVALID_HIERARCHY', 'A plan cannot have a parent plan or phase.');
    if (record.tipo === 'fase' && record.fase_id) throw new BitacoraError('INVALID_HIERARCHY', 'A phase cannot have a parent phase.');
    if (record.fase_id) {
      const phase = this.record(record.proyecto_id, record.fase_id);
      if (phase.tipo !== 'fase') throw new BitacoraError('INVALID_HIERARCHY', 'The phase ID must identify a phase.');
      if (Object.hasOwn(data, 'plan_id') && data.plan_id !== undefined && (data.plan_id ?? undefined) !== phase.plan_id) throw new BitacoraError('INVALID_HIERARCHY', 'A task must belong to the same plan as its phase.');
      if (phase.plan_id) record.plan_id = phase.plan_id;
      else delete record.plan_id;
    }
    if (record.plan_id) {
      const plan = this.record(record.proyecto_id, record.plan_id);
      if (plan.tipo !== 'plan') throw new BitacoraError('INVALID_HIERARCHY', 'The plan ID must identify a plan.');
    }
  }

  private relationRows(project: string, id: string) {
    return this.storage.all('SELECT id,destino_id,tipo,creado_en FROM relations WHERE proyecto_id=? AND (id=? OR destino_id=?) ORDER BY creado_en,id,destino_id,tipo', project, id, id).map(row => ({ ...row }));
  }

  private dispatch(operation: string, data: Input): unknown {
    const projectId = data.proyecto_id as string;
    const id = data.id as string;
    if (operation === 'crear_proyecto') {
      const timestamp = now();
      const project: Project = { id: randomUUID(), nombre: data.nombre as string, repositorios: ((data.repositorios ?? []) as string[]).map(path => this.absolute(path)), version: 1, creado_en: timestamp, modificado_en: timestamp };
      if (data.descripcion !== undefined) project.descripcion = data.descripcion as string;
      this.storage.run('INSERT INTO projects(id,data) VALUES(?,?)', project.id, JSON.stringify(project));
      // Only managed storage is created. Repository paths are never touched.
      mkdirSync(join(this.home, 'projects', project.id), { recursive: true, mode: 0o700 });
      this.event(project.id, null, operation, null, project);
      return this.projectSummary(project);
    }
    if (operation === 'listar_proyectos') {
      const limit = data.limit as number, offset = data.offset as number;
      const rows = this.storage.all('SELECT data FROM projects ORDER BY id LIMIT ? OFFSET ?', limit + 1, offset);
      return this.page(rows.map(row => this.projectSummary(JSON.parse(String(row.data)) as Project)), limit, offset);
    }
    const project = this.project(projectId);
    if (operation === 'obtener_proyecto') return project;
    if (operation === 'eliminar_proyecto') {
      this.assertVersion(project, data);
      // Files, including managed project directories and external documents, are never touched.
      this.storage.run('DELETE FROM annotations WHERE proyecto_id=?', projectId);
      this.storage.run('DELETE FROM relations WHERE proyecto_id=?', projectId);
      this.storage.run('DELETE FROM events WHERE proyecto_id=?', projectId);
      for (const kind of ['tarea', 'fase', 'plan']) this.storage.run('DELETE FROM records WHERE proyecto_id=? AND tipo=?', projectId, kind);
      this.storage.run('DELETE FROM requests WHERE scope=?', projectId);
      this.storage.run("UPDATE requests SET response=? WHERE scope='global:projects' AND json_extract(response,'$.id')=?", '{"__deleted":true}', projectId);
      this.storage.run('DELETE FROM projects WHERE id=?', projectId);
      // execute remembers only the minimal deletion receipt after clearing the project scope.
      return { proyecto_id: projectId, eliminado: true, documentos_eliminados: false };
    }
    if (operation === 'actualizar_proyecto') {
      this.assertVersion(project, data);
      const updated = { ...project, version: project.version + 1, modificado_en: now() };
      if (data.nombre !== undefined) updated.nombre = data.nombre as string;
      if (data.descripcion === null) delete updated.descripcion;
      else if (data.descripcion !== undefined) updated.descripcion = data.descripcion as string;
      if (data.repositorios !== undefined) updated.repositorios = (data.repositorios as string[]).map(path => this.absolute(path));
      this.storage.run('UPDATE projects SET data=? WHERE id=?', JSON.stringify(updated), projectId);
      this.event(projectId, null, operation, project, updated);
      return this.projectSummary(updated);
    }
    if (operation === 'registrar') {
      const timestamp = now();
      const record: RecordData = { id: randomUUID(), proyecto_id: projectId, tipo: data.tipo as Kind, titulo: data.titulo as string, estado: (data.estado ?? 'pendiente') as State, criterios: (data.criterios ?? []) as string[], evidencias: (data.evidencias ?? []) as string[], version: 1, creado_en: timestamp, modificado_en: timestamp };
      if (data.descripcion !== undefined) record.descripcion = data.descripcion as string;
      if (data.documento_ruta) record.documento_ruta = this.absolute(data.documento_ruta as string);
      if (data.plan_id) record.plan_id = data.plan_id as string;
      if (data.fase_id) record.fase_id = data.fase_id as string;
      this.hierarchy(record, data);
      if (closed(record.estado)) record.cerrado_en = timestamp;
      this.save(record);
      this.event(projectId, record.id, operation, null, record);
      return this.summary(record);
    }
    if (operation === 'obtener_contexto_activo' || operation === 'consultar_historico') return this.listRecords(operation, data);
    if (operation === 'consultar_cambios') return this.changes(data);
    const before = this.record(projectId, id);
    if (operation === 'obtener_resumen') return this.summary(before);
    if (operation === 'obtener_detalle') return { ...before, relaciones: this.relationRows(projectId, id) };
    if (operation === 'eliminar_plan' || operation === 'eliminar_fase' || operation === 'eliminar_tarea') {
      const kind = operation.slice('eliminar_'.length) as Kind;
      if (before.tipo !== kind) throw new BitacoraError('INVALID_TYPE', 'The item does not have the type required by this operation.', { proyecto_id: projectId, id, tipo_esperado: kind, tipo_actual: before.tipo });
      this.assertVersion(before, data);
      if (kind === 'plan') {
        const phases = this.storage.get("SELECT COUNT(*) AS total FROM records WHERE proyecto_id=? AND tipo='fase' AND plan_id=?", projectId, id);
        const tasks = this.storage.get("SELECT COUNT(*) AS total FROM records WHERE proyecto_id=? AND tipo='tarea' AND (plan_id=? OR fase_id IN (SELECT id FROM records WHERE proyecto_id=? AND tipo='fase' AND plan_id=?))", projectId, id, projectId, id);
        const counts = { fases: Number(phases?.total ?? 0), tareas: Number(tasks?.total ?? 0) };
        if (counts.fases || counts.tareas) throw new BitacoraError('HAS_CHILDREN', 'The plan still has phases or direct or derived tasks, including closed work; delete them first.', { proyecto_id: projectId, id, ...counts });
      } else if (kind === 'fase') {
        const tasks = this.storage.get("SELECT COUNT(*) AS total FROM records WHERE proyecto_id=? AND tipo='tarea' AND fase_id=?", projectId, id);
        const count = Number(tasks?.total ?? 0);
        if (count) throw new BitacoraError('HAS_CHILDREN', 'The phase still has tasks, including closed work; delete them first.', { proyecto_id: projectId, id, tareas: count });
      }
      this.storage.run('DELETE FROM annotations WHERE proyecto_id=? AND registro_id=?', projectId, id);
      this.storage.run('DELETE FROM relations WHERE proyecto_id=? AND (id=? OR destino_id=?)', projectId, id, id);
      // Purge this record's own history rather than retain snapshots of deleted content.
      this.storage.run('DELETE FROM events WHERE proyecto_id=? AND registro_id=?', projectId, id);
      this.storage.run("UPDATE requests SET response=? WHERE scope=? AND json_extract(response,'$.id')=?", '{"__deleted":true}', projectId, id);
      this.storage.run('DELETE FROM records WHERE proyecto_id=? AND id=?', projectId, id);
      return { proyecto_id: projectId, id, tipo: kind, eliminado: true, documentos_eliminados: false };
    }
    this.assertVersion(before, data);
    const after: RecordData = { ...before, criterios: [...before.criterios], evidencias: [...before.evidencias], version: before.version + 1, modificado_en: now() };
    let annotation: unknown;
    let eventBefore: unknown = before;
    let eventAfter: unknown;
    if (operation === 'actualizar') {
      if (data.tipo !== undefined && data.tipo !== before.tipo) {
        after.tipo = data.tipo as Kind;
        if (after.tipo !== 'plan' && this.storage.get('SELECT id FROM records WHERE proyecto_id=? AND plan_id=? LIMIT 1', projectId, id)) throw new BitacoraError('INVALID_HIERARCHY', 'First reassign the items using this item as their plan.');
        if (after.tipo !== 'fase' && this.storage.get('SELECT id FROM records WHERE proyecto_id=? AND fase_id=? LIMIT 1', projectId, id)) throw new BitacoraError('INVALID_HIERARCHY', 'First reassign the tasks using this item as their phase.');
      }
      if (data.titulo !== undefined) after.titulo = data.titulo as string;
      if (data.descripcion === null) delete after.descripcion;
      else if (data.descripcion !== undefined) after.descripcion = data.descripcion as string;
      if (data.documento_ruta === null) delete after.documento_ruta;
      else if (data.documento_ruta !== undefined) after.documento_ruta = this.absolute(data.documento_ruta as string);
      for (const field of ['plan_id', 'fase_id'] as const) {
        if (data[field] === null) delete after[field];
        else if (data[field] !== undefined) after[field] = data[field] as string;
      }
      if (data.criterios !== undefined) after.criterios = data.criterios as string[];
      if (data.evidencias !== undefined) after.evidencias = data.evidencias as string[];
      if (data.estado !== undefined) {
        after.estado = data.estado as State;
        if (after.estado !== 'bloqueado') delete after.bloqueo_actual;
      }
      this.hierarchy(after, data);
    } else if (operation === 'reabrir') {
      if (!closed(before.estado)) throw new BitacoraError('INVALID_STATE', 'Only completed or cancelled work can be reopened.');
      after.estado = data.estado as State;
      delete after.bloqueo_actual;
      if (data.motivo) annotation = { motivo: data.motivo };
    } else if (operation === 'anotar') {
      annotation = { id: randomUUID(), tipo: data.tipo, texto: data.texto, ...(data.referencia ? { referencia: data.referencia } : {}), creado_en: after.modificado_en };
      this.storage.run('INSERT INTO annotations(id,proyecto_id,registro_id,tipo,texto,referencia,creado_en) VALUES(?,?,?,?,?,?,?)', (annotation as { id: string }).id, projectId, id, data.tipo as string, data.texto as string, data.referencia as string ?? null, after.modificado_en);
      if (data.tipo === 'evidencia') after.evidencias.push((data.referencia ?? data.texto) as string);
      if (data.tipo === 'bloqueo') after.bloqueo_actual = { texto: data.texto as string, ...(data.referencia ? { referencia: data.referencia as string } : {}), creado_en: after.modificado_en };
    } else if (operation === 'agregar_relacion' || operation === 'retirar_relacion') {
      this.record(projectId, data.destino_id as string);
      if (data.destino_id === id) throw new BitacoraError('INVALID_RELATION', 'An item cannot have a relation to itself.');
      const relationsBefore = this.relationRows(projectId, id);
      if (operation === 'agregar_relacion') {
        const result = this.storage.run('INSERT OR IGNORE INTO relations(proyecto_id,id,destino_id,tipo,creado_en) VALUES(?,?,?,?,?)', projectId, id, data.destino_id as string, data.tipo as string, after.modificado_en);
        if (Number(result.changes) === 0) return this.summary(before);
      } else {
        const result = this.storage.run('DELETE FROM relations WHERE proyecto_id=? AND id=? AND destino_id=? AND tipo=?', projectId, id, data.destino_id as string, data.tipo as string);
        if (Number(result.changes) === 0) return this.summary(before);
      }
      eventBefore = { ...before, relaciones: relationsBefore };
      eventAfter = { ...after, relaciones: this.relationRows(projectId, id) };
    }
    if (closed(after.estado)) {
      if (!closed(before.estado)) after.cerrado_en = after.modificado_en;
    } else delete after.cerrado_en;
    this.save(after);
    this.event(projectId, id, operation, eventBefore, eventAfter ?? after, annotation);
    if (after.tipo === 'fase' && before.plan_id !== after.plan_id) {
      const children = this.storage.all('SELECT data FROM records WHERE proyecto_id=? AND fase_id=?', projectId, id);
      for (const row of children) {
        const childBefore = JSON.parse(String(row.data)) as RecordData;
        const childAfter = { ...childBefore, version: childBefore.version + 1, modificado_en: after.modificado_en };
        if (after.plan_id) childAfter.plan_id = after.plan_id;
        else delete childAfter.plan_id;
        this.save(childAfter);
        this.event(projectId, childAfter.id, 'derivar_plan', childBefore, childAfter);
      }
    }
    return this.summary(after);
  }

  private page<T>(items: T[], limit: number, offset: number) {
    return { items: items.slice(0, limit), next_offset: items.length > limit ? offset + limit : null };
  }

  private listRecords(operation: string, data: Input) {
    const project = data.proyecto_id as string;
    const active = operation === 'obtener_contexto_activo';
    const clauses = ['proyecto_id=?', active ? "estado NOT IN ('terminado','cancelado')" : "estado IN ('terminado','cancelado')"];
    const args: SQLInputValue[] = [project];
    for (const field of ['tipo', 'estado', 'plan_id', 'fase_id'] as const) if (data[field] !== undefined) { clauses.push(`${field}=?`); args.push(data[field] as string); }
    // Parent filters must also belong to the explicit project.
    for (const field of ['plan_id', 'fase_id'] as const) if (data[field]) this.record(project, data[field] as string);
    const limit = data.limit as number, offset = data.offset as number;
    const rows = this.storage.all(`SELECT data FROM records WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ? OFFSET ?`, ...args, limit + 1, offset);
    const items = rows.map(row => {
      const record = JSON.parse(String(row.data)) as RecordData;
      const summary = this.summary(record);
      if (!active) return summary;
      const dependencies = this.storage.all("SELECT r.data FROM relations rel JOIN records r ON r.id=rel.destino_id AND r.proyecto_id=rel.proyecto_id WHERE rel.proyecto_id=? AND rel.id=? AND rel.tipo='depende_de' AND r.estado NOT IN ('terminado','cancelado') ORDER BY r.id", project, record.id).map(dependency => this.summary(JSON.parse(String(dependency.data)) as RecordData));
      const blockage = record.bloqueo_actual;
      return { ...summary, ...(dependencies.length ? { dependencias: dependencies } : {}), ...(blockage ? { bloqueo: { ...blockage } } : {}) };
    });
    return this.page(items, limit, offset);
  }

  private changes(data: Input) {
    const project = data.proyecto_id as string;
    if (data.id) this.record(project, data.id as string);
    const limit = data.limit as number, offset = data.offset as number;
    const rows = this.storage.all(`SELECT * FROM events WHERE proyecto_id=?${data.id ? ' AND registro_id=?' : ''} ORDER BY secuencia ASC LIMIT ? OFFSET ?`, project, ...(data.id ? [data.id as string] : []), limit + 1, offset);
    const items = rows.map(row => ({
      id: row.id, proyecto_id: row.proyecto_id, ...(row.registro_id ? { registro_id: row.registro_id } : {}),
      operacion: row.operacion, creado_en: row.creado_en,
      antes: row.antes === null ? null : JSON.parse(String(row.antes)) as unknown,
      despues: row.despues === null ? null : JSON.parse(String(row.despues)) as unknown,
      ...(row.anotacion === null ? {} : { anotacion: JSON.parse(String(row.anotacion)) as unknown }),
    }));
    return this.page(items, limit, offset);
  }

  private async createBackup(data: Input): Promise<unknown> {
    const cached = this.storage.transaction(() => {
      if (data.proyecto_id) this.project(data.proyecto_id as string);
      const result = this.cached('crear_backup', data);
      if (!result.found && data.request_id) this.storage.run('INSERT INTO requests(scope,request_id,fingerprint,response) VALUES(?,?,?,NULL)', 'global:backup', data.request_id as string, this.fingerprint('crear_backup', data));
      return result;
    });
    if (cached.found) return cached.response;
    this.backups++;
    let destination: string | undefined;
    try {
      destination = data.ruta_destino ? this.absolute(data.ruta_destino as string) : join(this.home, 'backups', now().replaceAll(':', '-') + '-' + randomUUID());
      const managedRoot = join(this.home, 'projects');
      if (lstatSync(managedRoot).isSymbolicLink()) throw new BitacoraError('VALIDATION_ERROR', 'home/projects cannot be a symbolic link when creating a backup.');
      const managed = realpathSync(managedRoot);
      const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path)); };
      // Avoid recursive copies, overwrites and following a symlink into projects.
      if (inside(managed, destination) || inside(destination, this.home)) throw new BitacoraError('VALIDATION_ERROR', 'The backup destination cannot contain home or be inside projects.');
      mkdirSync(destination, { mode: 0o700 });
      const actualDestination = realpathSync(destination);
      if (inside(managed, actualDestination) || inside(actualDestination, realpathSync(this.home))) throw new BitacoraError('VALIDATION_ERROR', 'Unsafe backup destination.');
      const database = join(destination, 'bitacora.sqlite');
      await backup(this.storage.db, database);
      const skipped: string[] = [];
      let count = 0;
      const copyManaged = (source: string, target: string) => {
        mkdirSync(target, { mode: 0o700 });
        for (const name of readdirSync(source)) {
          const from = join(source, name), to = join(target, name);
          const stat = lstatSync(from);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { skipped.push(from); continue; }
          if (stat.isDirectory()) copyManaged(from, to);
          else { copyFileSync(from, to); count++; }
        }
      };
      copyManaged(managed, join(destination, 'projects'));
      const external = this.storage.all('SELECT data FROM records WHERE json_extract(data,\'$.documento_ruta\') IS NOT NULL').map(row => (JSON.parse(String(row.data)) as RecordData).documento_ruta!).filter(path => !inside(managed, path));
      const response = {
        ruta: destination, base_datos: database, documentos_ruta: join(destination, 'projects'),
        alcance: 'Base de datos completa de todos los proyectos y archivos regulares gestionados en home/projects.',
        documentos_copiados: count, rutas_externas_no_copiadas: [...new Set(external)], rutas_omitidas: skipped,
        limitaciones: ['La base de datos es consistente; la copia de documentos no es atómica respecto de ediciones externas.', 'No se siguen enlaces simbólicos ni se copian documentos externos.', 'Los archivos copiados no constituyen un historial de versiones.'],
        creado_en: now(),
      };
      writeFileSync(join(destination, 'manifest.json'), JSON.stringify(response, null, 2), { flag: 'wx', mode: 0o600 });
      if (data.request_id) this.storage.transaction(() => { this.storage.run('UPDATE requests SET response=? WHERE scope=? AND request_id=?', JSON.stringify(response), 'global:backup', data.request_id as string); });
      return response;
    } catch (error) {
      if (data.request_id) this.storage.transaction(() => { this.storage.run('DELETE FROM requests WHERE scope=? AND request_id=? AND response IS NULL', 'global:backup', data.request_id as string); });
      // Incomplete destinations are retained for inspection, never presented as successful backups.
      if (error instanceof BitacoraError) throw error;
      if (destination && error instanceof Error) throw new BitacoraError('BACKUP_FAILED', error.message, { ruta: destination, copia_incompleta: true });
      throw error;
    } finally { this.backups--; }
  }
}
