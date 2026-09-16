import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations.js';

// Loaded via createRequire so bundlers/Vite transforms never trip over the
// very recent built-in specifier; Node itself always resolves 'node:sqlite'.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/**
 * Thin wrapper around node's built-in synchronous SQLite driver.
 * Zero external service / zero cost. `':memory:'` is used in tests.
 */
export class Database {
  /** @param {string} dbPath file path or ':memory:' */
  constructor(dbPath) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.pragmas();
    runMigrations(this);
  }

  pragmas() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.path !== ':memory:') {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
      } catch {
        /* WAL may not be supported — safe to continue without it */
      }
    }
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  /** Synchronous transaction helper — rolls back on any throw. */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
