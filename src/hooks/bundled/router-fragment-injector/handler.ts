import path from "node:path";
import {
  filterBootstrapFilesForSession,
  loadExtraBootstrapFilesWithDiagnostics,
} from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import {
  isAgentBootstrapEvent,
  isMessagePreprocessedEvent,
  type HookHandler,
} from "../../hooks.js";

const HOOK_KEY = "router-fragment-injector";
const log = createSubsystemLogger(HOOK_KEY);

type RoutedType = "envelope" | "search" | "code" | "wiki" | "plain";
const VALID_TYPES: RoutedType[] = ["envelope", "search", "code", "wiki", "plain"];

const KEYWORD_RULES: Array<{ type: RoutedType; re: RegExp }> = [
  // Order matters — first match wins.
  {
    type: "envelope",
    re: /(만들어|정리해|비교|리포트|분석해|envelope|html|chart|graph|diagram|보고서|문서)/i,
  },
  { type: "search", re: /(검색|찾아|최신|뉴스|오늘|현재|어제|최근|search\b|news\b|today|recent)/i },
  {
    type: "code",
    re: /(코드|구현|refactor|리팩토|PR\b|타입스크립트|typescript|python|debug|버그|에러|exception|함수)/i,
  },
  { type: "wiki", re: /(wiki\b|vault\b|저장해|ingest\b|메모리|기록|note\b|노트)/i },
];

function classifyByKeyword(text: string): RoutedType {
  if (!text) return "plain";
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return "plain";
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { type: RoutedType; ts: number }>();

function pruneCache(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
  }
}

function cacheKeyFromConversationId(conversationId?: string): string | undefined {
  if (!conversationId) return undefined;
  return conversationId.toLowerCase();
}

function cacheKeyFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  // sessionKey shape e.g. "agent:main:slack:channel:c0atzba2ekx[:thread:...]" — pull the
  // chat/channel id segment so it lines up with conversationId stashed at preprocess time.
  const parts = sessionKey.toLowerCase().split(":");
  for (const seg of parts) {
    if (seg.length >= 8 && /^[a-z0-9]+$/i.test(seg)) {
      // best-effort: take the longest alnum chunk (slack channel/conv ids are long).
      // multiple candidates → pick the longest.
    }
  }
  // Heuristic: the conversationId is usually a long alnum token. Find the longest alnum segment.
  let best: string | undefined;
  for (const seg of parts) {
    if (/^[a-z0-9]{6,}$/i.test(seg) && (!best || seg.length > best.length)) best = seg;
  }
  return best;
}

const routerHook: HookHandler = async (event) => {
  if (isMessagePreprocessedEvent(event)) {
    const ctx = event.context;
    const text = ctx.bodyForAgent || ctx.body || "";
    const cacheKey = cacheKeyFromConversationId(ctx.conversationId);
    if (!text || !cacheKey) return;
    const now = Date.now();
    pruneCache(now);
    const type = classifyByKeyword(text);
    cache.set(cacheKey, { type, ts: now });
    log.debug(`classified message → ${type}`, {
      cacheKey,
      preview: text.slice(0, 60),
    });
    return;
  }

  if (isAgentBootstrapEvent(event)) {
    const ctx = event.context;
    const hookConfig = resolveHookConfig(ctx.cfg, HOOK_KEY);
    if (!hookConfig || hookConfig.enabled === false) return;
    const fragmentDir =
      typeof (hookConfig as Record<string, unknown>).fragmentDir === "string"
        ? ((hookConfig as Record<string, unknown>).fragmentDir as string)
        : "agents-fragments";
    const cacheKey = cacheKeyFromSessionKey(ctx.sessionKey);
    if (!cacheKey) return;
    const now = Date.now();
    pruneCache(now);
    const cached = cache.get(cacheKey);
    if (!cached) {
      log.debug("no cached type for session", { cacheKey, sessionKey: ctx.sessionKey });
      return;
    }
    const fragmentRel = `${fragmentDir}/AGENTS-${cached.type}.md`;
    try {
      const { files: extras, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(
        ctx.workspaceDir,
        [fragmentRel],
      );
      if (extras.length === 0) {
        log.debug(`fragment not found: ${fragmentRel}`, { diagnostics: diagnostics.length });
        return;
      }
      ctx.bootstrapFiles = filterBootstrapFilesForSession(
        [...ctx.bootstrapFiles, ...extras],
        ctx.sessionKey,
      );
      log.debug(`injected fragment ${path.basename(fragmentRel)}`, {
        type: cached.type,
        sessionKey: ctx.sessionKey,
      });
    } catch (err) {
      log.warn(`failed to load fragment ${fragmentRel}: ${String(err)}`);
    }
  }
};

export default routerHook;
