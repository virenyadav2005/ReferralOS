import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export function migrateDatabase(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name));
  const files = readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
    const requiresForeignKeysOff = sql.includes('-- requires_foreign_keys_off');
    if (requiresForeignKeysOff) db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);
      db.exec('COMMIT');
      if (requiresForeignKeysOff) {
        db.exec('PRAGMA foreign_keys = ON;');
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`Migration ${name} left ${violations.length} foreign key violation(s).`);
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be committed */ }
      if (requiresForeignKeysOff) db.exec('PRAGMA foreign_keys = ON;');
      throw error;
    }
  }
}

export function closeDatabase(db) {
  db.close();
}
