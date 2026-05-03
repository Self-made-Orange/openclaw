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

/**
 * Stub classifier — Phase 2 D2 placeholder.
 *
 * Phase 2 D5 will replace this with a real Anthropic/OpenAI call to the
 * `binding.router.agentId` agent. For now it just returns the fallback so
 * the dispatch path can be wired and tested without LLM cost.
 */
async function classifyMessageStub(_params: {
  text: string;
  cfg: OpenClawConfig;
  binding: AgentIntentBinding;
  timeoutMs: number;
}): Promise<{ agentId: string; reason: string; fellBack: boolean }> {
  // TODO(Phase 2 D5): replace with real classifier LLM call.
  return {
    agentId: resolveFallback(_params.cfg, _params.binding),
    reason: "stub-classifier-not-yet-implemented",
    fellBack: true,
  };
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
        classifyMessageStub({
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
