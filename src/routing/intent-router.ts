// CLAW-FORK 2026-05-03 (Phase 2, multi-agent design):
// Intent-router classifier — picks which specialist agent should answer a
// given inbound message. Invoked by `dispatch-from-config.ts` when
// `resolveAgentRoute()` returns the synthetic `INTENT_PENDING_AGENT_ID`
// sentinel (i.e., the inbound matched an `AgentIntentBinding` tier).
//
// SKELETON ONLY (Phase 2 D2). The actual classifier LLM call is stubbed —
// returns the configured `fallbackAgentId` (or "main") so the dispatch path
// can be wired up end-to-end without paying any LLM cost. Phase 2 D5 swaps
// the stub for a real cheap-model call.
//
// Cache strategy: per-(channel, peerId, text-hash) TTL cache, default 300s.
// In-flight de-duplication so concurrent inbound to the same channel don't
// double-classify (R2 in design doc).

import { createHash } from "node:crypto";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { INTENT_PENDING_AGENT_ID, type AgentIntentBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("intent-router");

const DEFAULT_CACHE_TTL_SEC = 300;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_FALLBACK_AGENT_ID = "main";

export type IntentRouterDecision = {
  /** Real agentId the dispatcher should route to. NEVER `INTENT_PENDING_AGENT_ID`. */
  agentId: string;
  /** Why this agent was chosen — for logging. */
  reason: string;
  /** Whether the decision came from the in-process cache. */
  cached: boolean;
  /** Whether the call hit the timeout / errored / used a fallback. */
  fellBack: boolean;
};

type CacheEntry = {
  decision: IntentRouterDecision;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<IntentRouterDecision>>();

function pruneExpired(now: number): void {
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

function buildCacheKey(params: {
  channel: string;
  accountId?: string;
  peerId?: string;
  text: string;
  routerAgentId: string;
}): string {
  const hash = createHash("sha1");
  hash.update(params.routerAgentId);
  hash.update("\x00");
  hash.update(params.channel);
  hash.update("\x00");
  hash.update(params.accountId ?? "");
  hash.update("\x00");
  hash.update(params.peerId ?? "");
  hash.update("\x00");
  hash.update(params.text);
  return hash.digest("hex");
}

function validateAgentId(cfg: OpenClawConfig, candidate: string): boolean {
  if (candidate === INTENT_PENDING_AGENT_ID) return false;
  const known = new Set(listAgentIds(cfg));
  if (!known.has(candidate)) return false;
  return true;
}

function resolveFallback(cfg: OpenClawConfig, binding: AgentIntentBinding): string {
  const candidate = binding.router.fallbackAgentId ?? DEFAULT_FALLBACK_AGENT_ID;
  if (validateAgentId(cfg, candidate)) return candidate;
  // Nuclear fallback — agents.list is empty or fallback misconfigured.
  // listAgentIds() always returns at least "main" (DEFAULT_AGENT_ID) per
  // agent-scope-config.ts behavior, so this should be safe.
  const known = listAgentIds(cfg);
  return known[0] ?? "main";
}

// CLAW-FORK 2026-05-03 (Phase 2 D5a, multi-agent design):
// Rule-based keyword classifier. First-iteration cheap path (latency 0,
// LLM cost 0) that gets the dispatch loop end-to-end testable. The LLM
// classifier upgrade lands as a follow-up D5+ chunk that swaps the body
// of `classifyMessage` while keeping the same return shape.
//
// Order matters — first match wins. Tighter/more-specific rules go higher
// (envelope > search > code > wiki > envelope_quick > default).
type ClassifierRule = {
  /** Target agentId. Must exist in cfg.agents.list[] or fallback engages. */
  agentId: string;
  /** Why this matched — surfaced as `decision.reason` for log/`/agents trace`. */
  reason: string;
  /** Regex tested against the inbound text. */
  re: RegExp;
};

const KEYWORD_RULES: ClassifierRule[] = [
  // High-signal "make me a thing" requests → envelope/HTML pipeline.
  {
    agentId: "envelope",
    reason: "keyword:envelope (만들어/정리/비교/리포트/분석/chart/diagram)",
    re: /(만들어|정리해|비교해|리포트|분석해|envelope|html|chart|graph|diagram|보고서|문서로)/i,
  },
  // Time-sensitive / external entity → search agent.
  {
    agentId: "search",
    reason: "keyword:search (검색/뉴스/오늘/최신)",
    re: /(검색해|찾아줘|최신|뉴스|오늘|어제|최근|search\b|news\b|today)/i,
  },
  // Code work — repo edits, refactors, debug.
  {
    agentId: "code",
    reason: "keyword:code (코드/refactor/구현/debug)",
    re: /(코드\b|구현해|refactor|리팩토|PR\b|타입스크립트|typescript|python|debug|버그|에러|exception)/i,
  },
  // Vault / knowledge management.
  {
    agentId: "wiki",
    reason: "keyword:wiki (vault/저장/ingest/메모리)",
    re: /(wiki\b|vault\b|저장해|ingest\b|메모리|기록해|note\b|노트)/i,
  },
  // Quick acknowledgements / short FYI → envelope (cheap haiku) by length.
  // Applied last because it's a length heuristic rather than content.
];

const SHORT_ACK_LIMIT_CHARS = 30;
const SHORT_ACK_AGENT_ID = "envelope";

function classifyByKeyword(
  cfg: OpenClawConfig,
  binding: AgentIntentBinding,
  text: string,
): { agentId: string; reason: string; fellBack: boolean } {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return {
      agentId: resolveFallback(cfg, binding),
      reason: "empty-text → fallback",
      fellBack: true,
    };
  }
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(trimmed)) {
      return { agentId: rule.agentId, reason: rule.reason, fellBack: false };
    }
  }
  // Length heuristic — short ack-style messages.
  if (trimmed.length <= SHORT_ACK_LIMIT_CHARS) {
    return {
      agentId: SHORT_ACK_AGENT_ID,
      reason: `short-ack (≤${SHORT_ACK_LIMIT_CHARS} chars)`,
      fellBack: false,
    };
  }
  return {
    agentId: resolveFallback(cfg, binding),
    reason: "no-keyword-match → fallback",
    fellBack: true,
  };
}

async function classifyMessage(params: {
  text: string;
  cfg: OpenClawConfig;
  binding: AgentIntentBinding;
  timeoutMs: number;
}): Promise<{ agentId: string; reason: string; fellBack: boolean }> {
  // Rule-based — synchronous in spirit but kept async for the LLM upgrade.
  return classifyByKeyword(params.cfg, params.binding, params.text);
}

export type ResolveIntentAgentParams = {
  cfg: OpenClawConfig;
  binding: AgentIntentBinding;
  channel: string;
  accountId?: string;
  peerId?: string;
  text: string;
};

/**
 * Resolve an inbound message to a real agentId via the intent-router agent.
 *
 * Caching, in-flight dedupe, validation, and fallback are all handled here.
 * The dispatcher just calls this when it sees `INTENT_PENDING_AGENT_ID`.
 */
export async function resolveIntentAgent(
  params: ResolveIntentAgentParams,
): Promise<IntentRouterDecision> {
  const cacheTtlSec = params.binding.router.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC;
  const timeoutMs = params.binding.router.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheKey = buildCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    peerId: params.peerId,
    text: params.text,
    routerAgentId: params.binding.router.agentId,
  });

  const now = Date.now();
  pruneExpired(now);

  // Cache hit — fast path.
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    log.debug(`cache hit → ${cached.decision.agentId} (${cached.decision.reason})`, {
      cacheKey: cacheKey.slice(0, 12),
    });
    return { ...cached.decision, cached: true };
  }

  // In-flight dedupe — concurrent inbound to same key awaits the first.
  const pending = inflight.get(cacheKey);
  if (pending) {
    log.debug("awaiting in-flight classifier", { cacheKey: cacheKey.slice(0, 12) });
    return pending;
  }

  const promise = (async (): Promise<IntentRouterDecision> => {
    try {
      const result = await Promise.race([
        classifyMessage({
          text: params.text,
          cfg: params.cfg,
          binding: params.binding,
          timeoutMs,
        }),
        new Promise<{ agentId: string; reason: string; fellBack: boolean }>((_, reject) =>
          setTimeout(() => reject(new Error("intent-router timeout")), timeoutMs).unref(),
        ),
      ]);
      const validated = validateAgentId(params.cfg, result.agentId)
        ? result.agentId
        : resolveFallback(params.cfg, params.binding);
      const decision: IntentRouterDecision = {
        agentId: validated,
        reason:
          validated === result.agentId
            ? result.reason
            : `${result.reason} (invalid agentId, used fallback)`,
        cached: false,
        fellBack: result.fellBack || validated !== result.agentId,
      };
      cache.set(cacheKey, {
        decision,
        expiresAt: Date.now() + cacheTtlSec * 1_000,
      });
      log.debug(`classified → ${decision.agentId} (${decision.reason})`, {
        cacheKey: cacheKey.slice(0, 12),
      });
      return decision;
    } catch (err) {
      const fallback = resolveFallback(params.cfg, params.binding);
      const decision: IntentRouterDecision = {
        agentId: fallback,
        reason: `classifier-error: ${String(err instanceof Error ? err.message : err)}`,
        cached: false,
        fellBack: true,
      };
      log.warn(`classifier failed, used fallback → ${fallback}`, { err: String(err) });
      // Negative cache for a short window so we don't hammer the failing
      // classifier on every retry. Half the configured TTL, capped at 60s.
      cache.set(cacheKey, {
        decision,
        expiresAt: Date.now() + Math.min(cacheTtlSec * 500, 60_000),
      });
      return decision;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * Find an `AgentIntentBinding` matching the inbound channel/peer, if any.
 * Used by `resolve-route.ts` to know whether to surface the
 * `INTENT_PENDING_AGENT_ID` sentinel.
 *
 * Returns the FIRST matching intent binding (peer-specific match preferred
 * over channel-only by config ordering — caller should sort accordingly).
 */
export function findIntentBinding(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  peerId?: string;
}): AgentIntentBinding | undefined {
  const bindings = params.cfg.bindings;
  if (!Array.isArray(bindings)) return undefined;
  const channel = params.channel.toLowerCase();
  for (const b of bindings) {
    if (b.type !== "intent") continue;
    if (b.match.channel.toLowerCase() !== channel) continue;
    // Account scope (optional)
    if (b.match.accountId && params.accountId && b.match.accountId !== params.accountId) continue;
    // Peer scope (optional) — if binding scopes to a peer, inbound peer must match.
    if (b.match.peer) {
      if (!params.peerId) continue;
      if (b.match.peer.id !== params.peerId) continue;
    }
    return b;
  }
  return undefined;
}

// Test-only escape hatch. Not exported from package index — only the test file imports it.
export function __resetIntentRouterCacheForTesting(): void {
  cache.clear();
  inflight.clear();
}
