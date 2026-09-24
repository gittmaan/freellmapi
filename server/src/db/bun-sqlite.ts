/**
 * `bun:sqlite` adapter — used when running under Bun ≥ 1.4.
 *
 * Same contract as `node-sqlite.ts` and `better-sqliteFactory`: exposes only
 * the small synchronous Db shape the rest of the server uses, with
 * better-sqlite3-style nested transactions built on SAVEPOINTs.
 */
import type { Db, DbFactory, DbStatement } from './types.js';

type BunSqliteRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type BunSqliteStatement = {
  run(...params: unknown[]): BunSqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type BunSqliteDatabase = {
  prepare(sql: string): BunSqliteStatement;
  exec(sql: string): void;
  close(): void;
};

type BunSqliteModule = {
  Database: new (path: string, options?: { readonly?: boolean; create?: boolean }) => BunSqliteDatabase;
};

function loadBunSqlite(): BunSqliteModule {
  // bun:sqlite is a bun-only built-in. The `require` indirection lets this
  // file be statically analyzable under node (TypeScript will warn about
  // the missing module) while still resolving under bun at runtime.
  // @ts-ignore — bun-only built-in module
  const mod = require('bun:sqlite');
  return mod as BunSqliteModule;
}

/**
 * bun:sqlite only recognises `?`, `?NNN`, `:name`, and `$name` placeholders
 * in SQL strings. The freellmapi codebase additionally uses `@name` (better-sqlite3
 * and node:sqlite accept it) and bare `name` in some legacy paths. We rewrite
 * any `@name` occurrences to `$name` at prepare() time so existing migrations
 * and call sites work under bun without touching them.
 *
 * Strings and quoted identifiers are skipped — only unquoted identifiers
 * starting with `@` followed by a letter or `_` are translated. `?` and `:`
 * placeholders pass through untouched.
 */
function rewriteAtPlaceholders(sql: string): string {
  // Skip if there's no @ that could be a placeholder.
  if (!sql.includes('@')) return sql;
  // Match @name where name is [A-Za-z_][A-Za-z0-9_]* — but not inside single
  // or double-quoted strings or line comments. The state machine below
  // honours quoting so e.g. `'literal @name'` is preserved verbatim.
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      // Consume the quoted string verbatim.
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = sql[i];
        out += c;
        i += 1;
        if (c === quote) break;
        if (c === '\\' && i < n) { out += sql[i]; i += 1; }
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      // Line comment — consume to end of line.
      while (i < n && sql[i] !== '\n') { out += sql[i]; i += 1; }
      continue;
    }
    if (ch === '@') {
      // Peek next char — must be a letter or underscore to be a placeholder.
      const next = sql[i + 1];
      if (next && /[A-Za-z_]/.test(next)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
        out += '$' + sql.slice(i + 1, j);
        i = j;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function numberResult(value: number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`SQLite returned an integer outside JavaScript's safe range: ${value}`);
  }
  return n;
}

/**
 * bun:sqlite only accepts `$` or `:`-prefixed keys in named-parameter objects.
 * better-sqlite3 and node:sqlite additionally accept `@` and bare keys, and
 * the rest of the freellmapi server is written to those looser forms. This
 * normalises a single trailing object argument so existing call sites "just
 * work" under bun.
 *
 * Only the trailing-object form is rewritten — multi-argument positional
 * calls pass through unchanged.
 */
function translateNamedParams(params: unknown[]): unknown[] {
  if (params.length !== 1) return params;
  const last = params[0];
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return params;
  const obj = last as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return params;
  // If every key already starts with $ or :, leave it alone — the caller
  // already wrote bun-native named params.
  if (keys.every((k) => k.startsWith('$') || k.startsWith(':'))) return params;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const stripped = key.startsWith('@') ? key.slice(1) : key;
    out[`$${stripped}`] = obj[key];
  }
  return [out];
}

function wrapStatement(statement: BunSqliteStatement): DbStatement {
  return {
    get: (...params) => statement.get(...translateNamedParams(params)),
    all: (...params) => statement.all(...translateNamedParams(params)),
    run: (...params) => {
      const result = statement.run(...translateNamedParams(params));
      return {
        changes: result.changes,
        lastInsertRowid: typeof result.lastInsertRowid === 'bigint'
          ? numberResult(result.lastInsertRowid)
          : result.lastInsertRowid,
      };
    },
  };
}

/**
 * `bun:sqlite` adapter. Used when running under Bun ≥ 1.4, where
 * `bun:sqlite` ships as a built-in synchronous SQLite driver.
 *
 * Nested-transaction support is implemented with SAVEPOINTs to match the
 * behavior better-sqlite3 provides and the rest of the server depends on.
 */
export const bunSqliteFactory: DbFactory = (resolvedPath) => {
  const { Database } = loadBunSqlite();
  const raw = new Database(resolvedPath);
  let transactionDepth = 0;
  let savepointSequence = 0;

  const database: Db = {
    name: resolvedPath,
    memory: resolvedPath === ':memory:',
    prepare: (sql) => wrapStatement(raw.prepare(rewriteAtPlaceholders(sql))),
    exec: (sql) => raw.exec(rewriteAtPlaceholders(sql)),
    pragma: (source) => raw.prepare(`PRAGMA ${source}`).all(),
    close: () => raw.close(),
    transaction: <F extends (...args: any[]) => unknown>(fn: F): F => {
      const wrapped = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const outermost = transactionDepth === 0;
        const savepoint = `freellmapi_tx_${++savepointSequence}`;

        raw.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        transactionDepth += 1;

        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new Error('SQLite transaction callbacks must be synchronous');
          }
          raw.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            if (outermost) {
              raw.exec('ROLLBACK');
            } else {
              raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
            }
          } catch {
            // Preserve the original callback/commit error.
          }
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      };
      return wrapped as F;
    },
  };

  return database;
};

/** True when the current runtime is bun (has `Bun` global). */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

// Re-exported for unit tests in bun-sqlite.test.ts. Exported as a named export
// (rather than from a separate file) to keep the adapter self-contained.
export { rewriteAtPlaceholders };
