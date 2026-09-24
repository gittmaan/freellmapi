import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// bun:sqlite is a built-in module under Bun only. The factory-selection and
// SQL-rewrite tests always run (they don't need bun:sqlite to be importable);
// the deep tests skip when bun:sqlite is unavailable — same pattern as
// node-sqlite.test.ts. Note: vitest workers run under Node even when invoked
// via `bun x vitest`, so the deep tests execute when the test runner is
// running under Bun directly (e.g. CI runs `bun test` rather than `bun x vitest`).
const hasBunSqlite = (() => {
  try {
    createRequire(import.meta.url)('bun:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const itWithSqlite = it.skipIf(!hasBunSqlite);

import { connectDb, defaultDbFactory } from '../../db/index.js';
import { bunSqliteFactory, isBunRuntime, rewriteAtPlaceholders } from '../../db/bun-sqlite.js';
import { runMigrationsSync } from '../../db/migrate/runner.js';
import type { Db } from '../../db/types.js';

describe('bun:sqlite runtime backend', () => {
  let db: Db | undefined;
  const tempDirs: string[] = [];

  afterEach(() => {
    db?.close?.();
    db = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is selected by default when running under Bun', () => {
    // The factory-selection test runs under both Node and Bun. Under Node
    // isBunRuntime() is false so the assertion holds vacuously; under Bun
    // it's true and we assert bun:sqlite wins.
    if (isBunRuntime()) {
      expect(defaultDbFactory('linux')).toBe(bunSqliteFactory);
      expect(defaultDbFactory('darwin')).toBe(bunSqliteFactory);
    } else {
      expect(defaultDbFactory('linux')).not.toBe(bunSqliteFactory);
    }
  });

  it('respects FREEAPI_DB_BACKEND= overrides', () => {
    const previous = process.env.FREEAPI_DB_BACKEND;
    try {
      process.env.FREEAPI_DB_BACKEND = 'bun';
      expect(defaultDbFactory('linux')).toBe(bunSqliteFactory);
      process.env.FREEAPI_DB_BACKEND = 'better';
      expect(defaultDbFactory('linux')).not.toBe(bunSqliteFactory);
    } finally {
      if (previous === undefined) delete process.env.FREEAPI_DB_BACKEND;
      else process.env.FREEAPI_DB_BACKEND = previous;
    }
  });

  itWithSqlite('opens a file-backed database with WAL and file metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-bun-sqlite-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'freeapi.db');

    db = connectDb(dbPath, { factory: bunSqliteFactory });
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO sample (value) VALUES (?)').run('persisted');

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
  });

  itWithSqlite('runs the complete application migration set', () => {
    db = connectDb(':memory:', { factory: bunSqliteFactory, ensureDir: false });
    runMigrationsSync(db, 'up');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toContain('api_keys');
    expect((db.prepare('SELECT COUNT(*) AS count FROM models').get() as { count: number }).count).toBeGreaterThan(0);
  });

  itWithSqlite('supports nested transaction commit and rollback semantics', () => {
    db = connectDb(':memory:', { factory: bunSqliteFactory, ensureDir: false });
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

    const outer = db.transaction(() => {
      db!.prepare('INSERT INTO items (value) VALUES (?)').run('outer');
      db!.transaction(() => {
        db!.prepare('INSERT INTO items (value) VALUES (?)').run('inner');
      })();

      try {
        db!.transaction(() => {
          db!.prepare('INSERT INTO items (value) VALUES (?)').run('rolled-back');
          throw new Error('rollback inner savepoint');
        })();
      } catch {
        // The outer transaction remains usable and commits.
      }
    });

    outer();

    const rows = db.prepare('SELECT value FROM items ORDER BY id').all() as { value: string }[];
    expect(rows.map((row) => row.value)).toEqual(['outer', 'inner']);
  });
});

describe('rewriteAtPlaceholders', () => {
  it('rewrites @name to $name', () => {
    expect(rewriteAtPlaceholders('SELECT * FROM foo WHERE id = @id'))
      .toBe('SELECT * FROM foo WHERE id = $id');
  });

  it('rewrites multiple @name placeholders in one query', () => {
    expect(rewriteAtPlaceholders('INSERT INTO foo (a, b) VALUES (@a, @b)'))
      .toBe('INSERT INTO foo (a, b) VALUES ($a, $b)');
  });

  it('leaves $name, :name, and ? placeholders untouched', () => {
    const sql = "SELECT * FROM foo WHERE a = $a AND b = :b AND c = ? AND d = @d";
    expect(rewriteAtPlaceholders(sql))
      .toBe("SELECT * FROM foo WHERE a = $a AND b = :b AND c = ? AND d = $d");
  });

  it('does not rewrite @-signs inside string literals', () => {
    expect(rewriteAtPlaceholders("SELECT 'literal @name' FROM foo WHERE id = @id"))
      .toBe("SELECT 'literal @name' FROM foo WHERE id = $id");
  });

  it('does not rewrite @-signs inside line comments', () => {
    expect(rewriteAtPlaceholders('-- uses @placeholder here\nSELECT * WHERE id = @id'))
      .toBe('-- uses @placeholder here\nSELECT * WHERE id = $id');
  });

  it('returns SQL unchanged when there is no @-prefixed identifier', () => {
    const sql = 'SELECT 1';
    expect(rewriteAtPlaceholders(sql)).toBe(sql);
  });
});
