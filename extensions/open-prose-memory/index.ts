/**
 * OpenProse Memory plugin entry — wires the SQLite-backed sessions store
 * into the runtime via the existing `agent_end` plugin hook.
 *
 * Phase 1 v1 scope:
 * - Plugin gate: `enabled` config key (default true).
 * - Per-pattern frontmatter gating (`memory: cross-session`) NOT yet enforced
 *   here — the runtime hook context does not surface pattern frontmatter
 *   today. v2 will plumb it through and short-circuit before persistence.
 * - Summarizer: passthroughSummarizer (first 1000 chars). Sonnet adapter
 *   follows once model selection plumbing is decided.
 * - Recall helper: bound but not yet injected into pattern bodies — that
 *   needs runtime-side wiring in a follow-up.
 */
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./runtime-api.js";
import { appendDurableFact } from "./src/markdown-store.js";
import { openSessionsStore, type SessionsStore } from "./src/store.js";
import { passthroughSummarizer, type Summarizer } from "./src/summarizer.js";

const PLUGIN_ID = "open-prose-memory";
const DEFAULT_AGENT_ID = "main";
const DEFAULT_SESSIONS_DB_CAP_MB = 1024;

interface PluginConfig {
  enabled: boolean;
  sessionsDbCapMB: number;
  redactPII: boolean;
  recallDefaultK: number;
}

function readPluginConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = (resolvePluginConfigObject(api.config, PLUGIN_ID) ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    sessionsDbCapMB:
      typeof raw.sessionsDbCapMB === "number" ? raw.sessionsDbCapMB : DEFAULT_SESSIONS_DB_CAP_MB,
    redactPII: Boolean(raw.redactPII),
    recallDefaultK: typeof raw.recallDefaultK === "number" ? raw.recallDefaultK : 5,
  };
}

interface AgentMemoryHandle {
  store: SessionsStore;
  summarizer: Summarizer;
  memoryDir: string;
}

/**
 * Per-agentId memory handle cache. Opens (and reuses) a SQLite store per
 * agent so the FTS5 prepared statements amortize across hook invocations.
 */
function buildHandleCache(api: OpenClawPluginApi): {
  get(agentId: string): Promise<AgentMemoryHandle>;
  closeAll(): Promise<void>;
} {
  const cache = new Map<string, AgentMemoryHandle>();
  return {
    async get(agentId: string): Promise<AgentMemoryHandle> {
      const existing = cache.get(agentId);
      if (existing) return existing;
      const agentDir = await resolveAgentDir(api, agentId);
      const memoryDir = `${agentDir}/memory`;
      const store = openSessionsStore(`${memoryDir}/sessions.db`);
      const handle: AgentMemoryHandle = {
        store,
        summarizer: passthroughSummarizer,
        memoryDir,
      };
      cache.set(agentId, handle);
      return handle;
    },
    async closeAll(): Promise<void> {
      for (const [, handle] of cache) {
        try {
          await handle.store.close();
        } catch {
          // Closing a SQLite handle with sidecar files in use is harmless.
        }
      }
      cache.clear();
    },
  };
}

/**
 * Best-effort transcript extraction from the agent_end event's `messages`
 * payload. The runtime-side type is `unknown[]`; we accept both raw strings
 * and message objects with a `text`/`content`/`body` field.
 */
function extractTranscript(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m === "string") {
      parts.push(m);
      continue;
    }
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const text = (obj.text ?? obj.content ?? obj.body ?? "") as unknown;
    if (typeof text === "string") {
      parts.push(text);
    } else if (Array.isArray(text)) {
      for (const seg of text) {
        if (typeof seg === "string") parts.push(seg);
        else if (seg && typeof seg === "object") {
          const segObj = seg as Record<string, unknown>;
          if (typeof segObj.text === "string") parts.push(segObj.text);
        }
      }
    }
  }
  return parts.join("\n");
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OpenProse Memory",
  description: "Cross-session memory recall for opt-in OpenProse patterns (Hermes hybrid Phase 1).",
  register(api: OpenClawPluginApi) {
    const config = readPluginConfig(api);
    if (!config.enabled) return;

    const handles = buildHandleCache(api);

    // Persist a compacted summary of every completed agent turn. Per-pattern
    // gating arrives in v2; for now we record everything and let the cap +
    // LRU eviction control disk pressure.
    api.on("agent_end", async (event, ctx) => {
      try {
        const agentId = ctx.agentId ?? DEFAULT_AGENT_ID;
        const sessionId = ctx.sessionId ?? ctx.sessionKey ?? `unknown-${Date.now()}`;
        const transcript = extractTranscript(event.messages ?? []);
        if (!transcript.trim()) return;

        const handle = await handles.get(agentId);
        const ts = new Date().toISOString();
        const summary = await handle.summarizer({
          agentId,
          sessionId,
          transcript,
          ts,
        });

        await handle.store.insert({
          sessionId,
          agentId,
          summary: summary.summary,
          ts,
          tokenUsage: summary.tokenUsage,
        });

        // Best-effort soft-cap enforcement after each insert. Cheap when
        // already under cap (single COUNT + size pragma).
        await handle.store.trimToCap(agentId, config.sessionsDbCapMB);

        if (!event.success && event.error) {
          // Stash failure context as a durable fact so future recall surfaces
          // it as a known landmine rather than a plain transcript hit.
          await appendDurableFact(
            handle.memoryDir,
            { text: `agent_end failure: ${event.error}`, sessionId, ts },
            { piiScrub: config.redactPII },
          );
        }
      } catch (err) {
        api.logger.warn(
          `${PLUGIN_ID}: agent_end persistence skipped: ${(err as Error)?.message ?? err}`,
        );
      }
    });

    api.on("gateway_stop", async () => {
      await handles.closeAll();
    });
  },
});
