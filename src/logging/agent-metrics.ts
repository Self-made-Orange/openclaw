// CLAW-FORK 2026-05-03 (Phase 4 D1, multi-agent design):
// Per-agent metrics writer. Every completed dispatch turn writes a single
// JSONL line to `~/.openclaw/state/agent-metrics.jsonl` so we can later
// answer questions like:
//   - which agentId answered the most turns this week?
//   - p50/p95 latency per agent?
//   - what % of turns hit `binding.intent` (cache hit vs miss vs fallback)?
//   - which intent reasons fire most often?
//
// Format: one JSON object per line. Schema below. Append-only, no rotation
// in v0 (rotate later if file grows past ~100 MB; expect <5 MB for months
// of single-user fork ops).

import fs from "node:fs";
import path from "node:path";

const METRICS_PATH_OVERRIDE = "OPENCLAW_AGENT_METRICS_PATH";

export type AgentMetricsRecord = {
  /** ISO-8601 with millis. */
  ts: string;
  /** Resolved agentId at the time the message finished (post intent-router). */
  agentId?: string;
  /** Routing source — `binding.intent`, `binding.peer`, `default`, etc. */
  matchedBy?: string;
  /** When matchedBy === "binding.intent": classifier reason + cached/fellBack flags. */
  intentReason?: string;
  /** Channel name (slack / telegram / discord / ...) */
  channel: string;
  /** Slack channel id / Telegram chat id / etc. */
  chatId?: string;
  /** Provider message id, if available. */
  messageId?: string;
  /** Outcome of the dispatch — completed/skipped/error. */
  outcome: "completed" | "skipped" | "error";
  /** Total dispatch duration in ms (queued → delivered). */
  durationMs?: number;
  /** When outcome === "skipped": short reason (duplicate/silent/etc.). */
  reason?: string;
  /** When outcome === "error": short error message. */
  error?: string;
};

let resolvedMetricsPath: string | undefined;

function resolveMetricsPath(): string {
  if (resolvedMetricsPath) return resolvedMetricsPath;
  const override = process.env[METRICS_PATH_OVERRIDE];
  if (override && override.trim()) {
    resolvedMetricsPath = override.trim();
  } else {
    const home = process.env.HOME ?? process.cwd();
    resolvedMetricsPath = path.join(home, ".openclaw", "state", "agent-metrics.jsonl");
  }
  try {
    fs.mkdirSync(path.dirname(resolvedMetricsPath), { recursive: true });
  } catch {
    // ignore — write step will surface the error if the dir really can't be created.
  }
  return resolvedMetricsPath;
}

/**
 * Best-effort append. Failure to write must NEVER throw — observability is
 * a side-channel, not a critical path. The dispatcher continues regardless.
 */
export function recordAgentMetrics(record: AgentMetricsRecord): void {
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    // Cyclic input or non-serializable values → drop silently.
    return;
  }
  try {
    fs.appendFileSync(resolveMetricsPath(), line, { encoding: "utf8" });
  } catch {
    // ignore — disk full, permissions, etc. Must not break dispatch.
  }
}
