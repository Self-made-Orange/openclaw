/**
 * SQLite + FTS5 store for compacted session summaries.
 *
 * Backed by `node:sqlite` (Node 22.5+ builtin) via the project-wide
 * `requireNodeSqlite()` wrapper. No new native dependency.
 *
 * Schema:
 *
 * ```sql
 * CREATE TABLE sessions (
 *   session_id     TEXT PRIMARY KEY,
 *   agent_id       TEXT NOT NULL,
 *   pattern_id     TEXT,
 *   summary        TEXT NOT NULL,    -- LLM-compacted, post-redact
 *   ts             TEXT NOT NULL,    -- ISO 8601 UTC of session end
 *   last_recall_ts TEXT,             -- updated on each recall hit (LRU eviction)
 *   token_in       INTEGER,
 *   token_out      INTEGER
 * );
 * CREATE VIRTUAL TABLE sessions_fts USING fts5(
 *   summary,
 *   content='sessions',
 *   content_rowid='rowid'
 * );
 * ```
 */
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

const requireFn = createRequire(import.meta.url);

function loadNodeSqlite(): typeof import("node:sqlite") {
  try {
    return requireFn("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    throw new Error(
      `node:sqlite is unavailable. open-prose-memory requires Node 22.5+ with the SQLite builtin (or set OPENCLAW_PROSE_MEMORY_DISABLE_SQLITE=1 to use the no-op store).`,
      { cause: err },
    );
  }
}

export interface SessionRow {
  sessionId: string;
  agentId: string;
  patternId?: string;
  summary: string;
  /** ISO 8601 UTC. */
  ts: string;
  tokenUsage?: { input: number; output: number };
}

export interface RecallHit {
  sessionId: string;
  summary: string;
  /** FTS5 bm25 score (lower = better match). */
  score: number;
  ts: string;
}

export interface SessionsStore {
  insert(row: SessionRow): Promise<void>;
  /** FTS5-backed lookup. Updates `last_recall_ts` on hits for LRU eviction. */
  recall(
    query: string,
    opts: { agentId: string; k: number; minScore?: number },
  ): Promise<RecallHit[]>;
  /** Drop oldest rows by `last_recall_ts` until total size is under `capMB * 1024 * 1024`. */
  trimToCap(agentId: string, capMB: number): Promise<{ dropped: number }>;
  close(): Promise<void>;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface PreparedStatements {
  insert: StatementSync;
  recall: StatementSync;
  touchRecall: StatementSync;
  countRows: StatementSync;
  dbSize: StatementSync;
  dropOldest: StatementSync;
}

class SqliteSessionsStore implements SessionsStore {
  private readonly db: DatabaseSync;
  private readonly stmts: PreparedStatements;
  private readonly dbPath: string;

  constructor(db: DatabaseSync, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.stmts = {
      insert: db.prepare(
        "INSERT OR REPLACE INTO sessions (session_id, agent_id, pattern_id, summary, ts, last_recall_ts, token_in, token_out) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
      ),
      // bm25() returns lower-is-better. Filter by minScore (upper bound).
      recall: db.prepare(
        "SELECT s.session_id AS sessionId, s.summary AS summary, s.ts AS ts, bm25(sessions_fts) AS score FROM sessions_fts JOIN sessions s ON s.rowid = sessions_fts.rowid WHERE sessions_fts MATCH ? AND s.agent_id = ? ORDER BY score ASC LIMIT ?",
      ),
      touchRecall: db.prepare("UPDATE sessions SET last_recall_ts = ? WHERE session_id = ?"),
      countRows: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?"),
      dbSize: db.prepare(
        "SELECT (page_count * page_size) AS bytes FROM pragma_page_count, pragma_page_size",
      ),
      dropOldest: db.prepare(
        // last_recall_ts NULL sorts first (never recalled = drop first), then oldest.
        "DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions WHERE agent_id = ? ORDER BY (last_recall_ts IS NULL) DESC, last_recall_ts ASC, ts ASC LIMIT ?)",
      ),
    };
  }

  async insert(row: SessionRow): Promise<void> {
    this.stmts.insert.run(
      row.sessionId,
      row.agentId,
      row.patternId ?? null,
      row.summary,
      row.ts,
      row.tokenUsage?.input ?? null,
      row.tokenUsage?.output ?? null,
    );
  }

  async recall(
    query: string,
    opts: { agentId: string; k: number; minScore?: number },
  ): Promise<RecallHit[]> {
    const matchExpr = sanitizeFtsQuery(query);
    if (!matchExpr) return [];
    const rows = this.stmts.recall.all(matchExpr, opts.agentId, opts.k) as Array<{
      sessionId: string;
      summary: string;
      ts: string;
      score: number;
    }>;
    const filtered =
      opts.minScore == null ? rows : rows.filter((r) => r.score <= (opts.minScore as number));
    if (filtered.length > 0) {
      const now = new Date().toISOString();
      for (const hit of filtered) {
        this.stmts.touchRecall.run(now, hit.sessionId);
      }
    }
    return filtered;
  }

  async trimToCap(agentId: string, capMB: number): Promise<{ dropped: number }> {
    const capBytes = capMB * 1024 * 1024;
    let dropped = 0;
    // Drop in batches of 100 to keep statements small. Bail when under cap.
    while (true) {
      const sizeRow = this.stmts.dbSize.get() as { bytes: number | bigint };
      const bytes = typeof sizeRow.bytes === "bigint" ? Number(sizeRow.bytes) : sizeRow.bytes;
      if (bytes <= capBytes) break;
      const countRow = this.stmts.countRows.get(agentId) as { n: number | bigint };
      const remaining = typeof countRow.n === "bigint" ? Number(countRow.n) : countRow.n;
      if (remaining === 0) break;
      const batch = Math.min(100, remaining);
      const result = this.stmts.dropOldest.run(agentId, batch);
      const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
      dropped += changes;
      if (changes === 0) break;
    }
    if (dropped > 0) {
      this.db.exec("VACUUM");
    }
    return { dropped };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class NoopSessionsStore implements SessionsStore {
  async insert(): Promise<void> {}
  async recall(): Promise<RecallHit[]> {
    return [];
  }
  async trimToCap(): Promise<{ dropped: number }> {
    return { dropped: 0 };
  }
  async close(): Promise<void> {}
}

/**
 * FTS5 reserves several characters; passing them raw breaks the MATCH parser.
 * Strip them and quote each whitespace-separated token so the user query
 * acts as a phrase-list ("foo bar" -> "foo" OR "bar").
 */
function sanitizeFtsQuery(input: string): string {
  // Drop chars FTS5 treats as syntax: " * - + ^ ( ) :
  const cleaned = input.replace(/["*\-+^():]/g, " ").trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id     TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      pattern_id     TEXT,
      summary        TEXT NOT NULL,
      ts             TEXT NOT NULL,
      last_recall_ts TEXT,
      token_in       INTEGER,
      token_out      INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_agent_ts ON sessions(agent_id, ts);
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      summary,
      content='sessions',
      content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS sessions_fts_insert AFTER INSERT ON sessions BEGIN
      INSERT INTO sessions_fts (rowid, summary) VALUES (new.rowid, new.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_fts_delete AFTER DELETE ON sessions BEGIN
      DELETE FROM sessions_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_fts_update AFTER UPDATE OF summary ON sessions BEGIN
      DELETE FROM sessions_fts WHERE rowid = old.rowid;
      INSERT INTO sessions_fts (rowid, summary) VALUES (new.rowid, new.summary);
    END;
  `);
}

/**
 * Open the SQLite-backed sessions store. `dbPath` is created (with parent
 * dirs) if missing, with strict 0o700 / 0o600 modes per Phase 0 Decision 1.
 *
 * Set env `OPENCLAW_PROSE_MEMORY_DISABLE_SQLITE=1` to fall back to the no-op
 * store (useful for environments lacking node:sqlite or for diagnostics).
 */
export function openSessionsStore(dbPath: string): SessionsStore {
  if (process.env.OPENCLAW_PROSE_MEMORY_DISABLE_SQLITE === "1") {
    return new NoopSessionsStore();
  }
  const sqlite = loadNodeSqlite();
  mkdirSync(dirname(dbPath), { recursive: true, mode: DIR_MODE });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  ensureSchema(db);
  try {
    chmodSync(dbPath, FILE_MODE);
  } catch {
    // Filesystems without POSIX modes (e.g. WSL/9p) silently ignore — that's fine.
  }
  return new SqliteSessionsStore(db, dbPath);
}
