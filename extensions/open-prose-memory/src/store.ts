/**
 * SQLite + FTS5 store for compacted session summaries.
 *
 * Phase 1 scaffold — interface only. Implementation lands in a follow-up
 * commit once the SQLite dependency choice (better-sqlite3 vs node:sqlite)
 * is settled and the cold-start budget impact is measured.
 *
 * Row schema (planned):
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

class NotImplementedStore implements SessionsStore {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async insert(_row: SessionRow): Promise<void> {
    throw new Error("SessionsStore.insert: SQLite backend not yet implemented (Phase 1 follow-up)");
  }
  async recall(): Promise<RecallHit[]> {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async trimToCap(_agentId: string, _capMB: number): Promise<{ dropped: number }> {
    return { dropped: 0 };
  }
  async close(): Promise<void> {}
}

/**
 * Returns a no-op store. Real SQLite-backed store ships next; until then
 * recall returns `[]` so opt-in patterns stay safe.
 */
export function openSessionsStore(_dbPath: string): SessionsStore {
  return new NotImplementedStore();
}
