/**
 * Recall helper exposed to pattern bodies via plugin SDK. Activation gate
 * (only fires for patterns with `memory: cross-session` frontmatter) lives
 * in the runtime, not in the helper, so plugins do not re-check.
 *
 * Phase 1 scaffold returns `[]` until the SQLite-backed store ships.
 */
import type { RecallHelper, RecallOptions, RecallResult } from "openclaw/plugin-sdk/memory";
import { openSessionsStore } from "./store.js";

export interface RecallContext {
  agentId: string;
  agentMemoryDir: string;
  defaultK: number;
}

/**
 * Build a RecallHelper bound to the given agent context.
 */
export function buildRecallHelper(ctx: RecallContext): RecallHelper {
  const store = openSessionsStore(`${ctx.agentMemoryDir}/sessions.db`);
  return async (query: string, opts?: RecallOptions): Promise<RecallResult[]> => {
    const k = opts?.k ?? ctx.defaultK;
    const agentId = opts?.agentId ?? ctx.agentId;
    const hits = await store.recall(query, { agentId, k, minScore: opts?.minScore });
    return hits.map((h) => ({
      sessionId: h.sessionId,
      summary: h.summary,
      score: h.score,
      ts: h.ts,
    }));
  };
}
