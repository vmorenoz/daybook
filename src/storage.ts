import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Storage {
  readonly db: DatabaseSync;
  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'projects'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'backups'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, 'bitacora.sqlite'));
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      this.transaction(() => {
        const row = this.db.prepare('PRAGMA user_version').get();
        const version = Number(row?.user_version);
        if (version > 1) throw new Error('Versión de base de datos no soportada: ' + version);
        if (version === 0) this.db.exec(`
          CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE records (
            id TEXT PRIMARY KEY, proyecto_id TEXT NOT NULL REFERENCES projects(id),
            tipo TEXT NOT NULL CHECK(tipo IN ('plan','fase','tarea')),
            estado TEXT NOT NULL CHECK(estado IN ('pendiente','en_planificacion','en_curso','bloqueado','terminado','cancelado')),
            plan_id TEXT REFERENCES records(id), fase_id TEXT REFERENCES records(id),
            version INTEGER NOT NULL CHECK(version > 0), data TEXT NOT NULL
          );
          CREATE INDEX records_scope ON records(proyecto_id, estado, id);
          CREATE INDEX records_phase ON records(proyecto_id, fase_id);
          CREATE TABLE relations (
            proyecto_id TEXT NOT NULL REFERENCES projects(id),
            id TEXT NOT NULL REFERENCES records(id), destino_id TEXT NOT NULL REFERENCES records(id),
            tipo TEXT NOT NULL CHECK(tipo IN ('depende_de','relacionado','contribuye_a')),
            creado_en TEXT NOT NULL,
            PRIMARY KEY(proyecto_id,id,destino_id,tipo), CHECK(id <> destino_id)
          );
          CREATE INDEX relations_destination ON relations(proyecto_id,destino_id);
          CREATE TABLE annotations (
            id TEXT PRIMARY KEY, proyecto_id TEXT NOT NULL REFERENCES projects(id),
            registro_id TEXT NOT NULL REFERENCES records(id), tipo TEXT NOT NULL,
            texto TEXT NOT NULL, referencia TEXT, creado_en TEXT NOT NULL
          );
          CREATE INDEX annotations_record ON annotations(proyecto_id,registro_id,tipo,creado_en);
          CREATE TABLE events (
            secuencia INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            proyecto_id TEXT NOT NULL REFERENCES projects(id), registro_id TEXT,
            operacion TEXT NOT NULL, antes TEXT, despues TEXT, anotacion TEXT, creado_en TEXT NOT NULL
          );
          CREATE INDEX events_scope ON events(proyecto_id,registro_id,secuencia);
          CREATE TABLE requests (
            scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            response TEXT, PRIMARY KEY(scope,request_id)
          );
          PRAGMA user_version=1;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).get(...params);
  }
  all(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).all(...params);
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
