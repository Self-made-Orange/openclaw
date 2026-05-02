/**
 * Memory hooks and types for the Hermes hybrid self-improvement layer.
 *
 * Activation: pattern frontmatter must declare `memory: cross-session` for
 * recall to fire, or `evolve: true` for trace capture / skill proposal.
 * Patterns without these flags run unchanged.
 *
 * See `docs/plan/hermes-hybrid-self-improvement-phase-0-alignment.md` for the
 * locked Phase 0 contracts that govern these types (storage layout, retention,
 * redaction, hook timeout).
 *
 * @since 0.1.0
 */

/**
 * Per-tool-call summary captured during a pattern run.
 * Identity is the canonical tool name (e.g. "Bash", "Read"), not the
 * provider-specific id.
 */
export interface ToolCallSummary {
  identity: string;
  ok: boolean;
  errorMessage?: string;
  /** 0 for the first attempt, 1+ for retries of the same logical call. */
  retryIndex: number;
}

/**
 * Trace record passed to {@link OnPatternCompleteHook}. Persistent stores
 * (SQLite, JSONL traces) consume this; do not mutate.
 */
export interface PatternTrace {
  agentId: string;
  patternId: string;
  sessionId: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  /** ISO 8601 UTC. */
  endedAt: string;
  outcome: "success" | "failure" | "abort";
  toolCalls: ToolCallSummary[];
  tokenUsage: {
    input: number;
    output: number;
    cacheHit: number;
  };
  /** SHA-256 of the final composed prompt; used for dedupe and trigger heuristics. */
  promptHash: string;
  /** Present iff `outcome !== "success"`. */
  errorMessage?: string;
  /** Echoed pattern frontmatter so the hook does not re-read the source file. */
  patternFlags: {
    memory?: "cross-session";
    evolve?: boolean;
  };
}

/**
 * Pattern-completion lifecycle hook. The runtime invokes registered hooks
 * sequentially with a per-hook 10s timeout. Hooks that need longer (e.g.
 * summarizer LLM calls) MUST queue work to a background worker rather than
 * block here. Hook failures are logged and do not propagate.
 */
export type OnPatternCompleteHook = (trace: PatternTrace) => Promise<void>;

export interface RecallOptions {
  /** Top-k results to return. Default 5. */
  k?: number;
  /** Override the active agent. Defaults to the current pattern's agent id. */
  agentId?: string;
  /** Minimum FTS5 bm25 score (lower = stricter). Default 0 (no floor). */
  minScore?: number;
}

export interface RecallResult {
  sessionId: string;
  summary: string;
  /** FTS5 bm25 score (lower = better match). */
  score: number;
  /** ISO 8601 UTC of the source session's end time. */
  ts: string;
}

/**
 * Runtime helper exposed to pattern bodies. Returns `[]` for patterns whose
 * frontmatter does not declare `memory: cross-session`. The activation gate
 * lives in the runtime, not in the helper, so plugins do not need to re-check.
 */
export type RecallHelper = (query: string, opts?: RecallOptions) => Promise<RecallResult[]>;
