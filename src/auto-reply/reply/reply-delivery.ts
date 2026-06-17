/** Normalizes reply directives and delivers block replies through streaming or direct paths. */
import path from "node:path";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { copyReplyPayloadMetadata, isReplyPayloadStatusNotice } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { BlockReplyContext, ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
import {
  applyMediaFormatGuard,
  detectHallucinatedFiles,
  mergeSlackBlocksIntoChannelData,
  readSlackBlocksFromChannelData,
} from "./delivery-guards.js";
import { getInteractiveFenceRe, getJsonInteractiveFenceRe } from "./interactive-fence-regex.js";
import { parseReplyDirectives } from "./reply-directives.js";
import { applyReplyTagsToPayload, isRenderablePayload } from "./reply-payloads.js";
import type { TypingSignaler } from "./typing-mode.js";

export type ReplyDirectiveParseMode = "always" | "auto" | "never";

// CLAW-FORK: extract abstract InteractiveReply OR raw Slack Block Kit from
// agent text. Agent emits a fenced JSON block with language tag
// `openclaw-interactive` (or alias `openclaw-blocks`). The parser strips the
// fence from text and routes:
//   - blocks of type {text|buttons|select}        → payload.interactive (abstract, channel-agnostic)
//   - blocks of richer Slack types (header/section/divider/image/context/...)
//     → payload.channelData.slack.blocks (raw passthrough, Slack-only but full Block Kit)
// Body forms accepted:
//   { "blocks": [...] }
//   { "attachments": [{ "blocks": [...], ... }] }
//
// CLAW-FORK 2026-06-13 (MED-5): regexes now come from the shared
// interactive-fence-regex module so the slack cron path
// (extensions/slack/src/extract-claw-fence.ts) and this reply path can no longer
// diverge on closing-fence handling.

const ABSTRACT_BLOCK_TYPES = new Set(["text", "buttons", "select"]);

type ClawInteractiveBlock =
  | { type: "text"; text: string }
  | {
      type: "buttons";
      buttons: Array<{ label: string; value?: string; url?: string; style?: string }>;
    }
  | { type: "select"; placeholder?: string; options: Array<{ label: string; value: string }> };

type ClawInteractive = { blocks: ClawInteractiveBlock[] };

function sanitizeClawButtonUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function sanitizeClawButton(
  raw: unknown,
): { label: string; value?: string; url?: string; style?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { label?: unknown; value?: unknown; url?: unknown; style?: unknown };
  if (typeof r.label !== "string") return undefined;
  const url = sanitizeClawButtonUrl(r.url);
  const value = typeof r.value === "string" ? r.value : undefined;
  if (!url && !value) return undefined; // Slack rejects buttons with neither url nor value.
  return {
    label: r.label,
    ...(value ? { value } : {}),
    ...(url ? { url } : {}),
    ...(typeof r.style === "string" ? { style: r.style } : {}),
  };
}

function isClawInteractiveBlock(value: unknown): value is ClawInteractiveBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as { type?: unknown };
  if (block.type === "text") {
    return typeof (value as { text?: unknown }).text === "string";
  }
  if (block.type === "buttons") {
    const rawButtons = (value as { buttons?: unknown }).buttons;
    if (!Array.isArray(rawButtons)) return false;
    const sanitized = rawButtons
      .map((b) => sanitizeClawButton(b))
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (sanitized.length === 0) return false;
    // mutate in place so the caller sees only sanitized entries (Slack-safe).
    (value as { buttons: typeof sanitized }).buttons = sanitized;
    return true;
  }
  if (block.type === "select") {
    const options = (value as { options?: unknown }).options;
    return (
      Array.isArray(options) &&
      options.every(
        (o) =>
          Boolean(o) &&
          typeof o === "object" &&
          typeof (o as { label?: unknown }).label === "string" &&
          typeof (o as { value?: unknown }).value === "string",
      )
    );
  }
  return false;
}

function extractFenceBlocksFromBody(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  // CLAW-FORK: unwrap the dispatch output schema. Kimi sometimes emits
  // `{type:"openclaw-interactive", payload:{interactive,channelData:{slack:{blocks:[...]}}}}`
  // (the runtime output shape) instead of the expected fence body
  // `{blocks:[...]}`. Detect and reach into payload.channelData.slack.blocks
  // / payload.interactive.blocks transparently.
  const wrapped = body as {
    type?: unknown;
    payload?: {
      interactive?: { blocks?: unknown };
      channelData?: { slack?: { blocks?: unknown; attachments?: unknown } };
    };
  };
  if (
    wrapped.type === "openclaw-interactive" &&
    wrapped.payload &&
    typeof wrapped.payload === "object"
  ) {
    const inner = wrapped.payload;
    const collected: unknown[] = [];
    const slackBlocks = inner.channelData?.slack?.blocks;
    if (Array.isArray(slackBlocks)) {
      collected.push(...slackBlocks);
    }
    const slackAttachments = inner.channelData?.slack?.attachments;
    if (Array.isArray(slackAttachments)) {
      for (const att of slackAttachments) {
        if (att && typeof att === "object" && Array.isArray((att as { blocks?: unknown }).blocks)) {
          collected.push(...(att as { blocks: unknown[] }).blocks);
        }
      }
    }
    if (collected.length === 0 && inner.interactive && Array.isArray(inner.interactive.blocks)) {
      collected.push(...inner.interactive.blocks);
    }
    if (collected.length > 0) return collected;
  }
  const root = body as { blocks?: unknown; attachments?: unknown };
  const collected: unknown[] = [];
  if (Array.isArray(root.blocks)) {
    collected.push(...root.blocks);
  }
  if (Array.isArray(root.attachments)) {
    for (const att of root.attachments) {
      if (att && typeof att === "object" && Array.isArray((att as { blocks?: unknown }).blocks)) {
        collected.push(...(att as { blocks: unknown[] }).blocks);
      }
    }
  }
  return collected;
}

function classifyFenceBlocks(blocks: unknown[]): "abstract" | "raw" | "empty" {
  let abstractCount = 0;
  let rawCount = 0;
  for (const b of blocks) {
    if (b && typeof b === "object") {
      const type = (b as { type?: unknown }).type;
      if (typeof type === "string") {
        if (ABSTRACT_BLOCK_TYPES.has(type)) abstractCount += 1;
        else rawCount += 1;
      }
    }
  }
  if (abstractCount === 0 && rawCount === 0) return "empty";
  // mixed → treat as raw (Slack Block Kit native is more expressive). Abstract types
  // are subset of valid Slack types in practice anyway.
  return rawCount > 0 ? "raw" : "abstract";
}

function extractClawInteractive(text: string): {
  text: string;
  interactive?: ClawInteractive;
  rawSlackBlocks?: unknown[];
} {
  if (!text) {
    return { text };
  }
  const hasOpenclawFence = text.includes("```openclaw-");
  // CLAW-FORK fallback: also rescue ```json fences that contain the dispatch
  // output schema (`"type":"openclaw-interactive"`).
  const hasJsonFallback = /"type"\s*:\s*"openclaw-interactive"/i.test(text);
  if (!hasOpenclawFence && !hasJsonFallback) {
    return { text };
  }
  let stripped = text;
  let abstractBlocks: ClawInteractiveBlock[] = [];
  let rawBlocks: unknown[] = [];
  // CLAW-FORK: track fence JSON parse failures so a malformed fence never
  // produces a silently-empty reply (see fallback below).
  let parseFailed = false;
  const handleBody = (body: string): void => {
    try {
      const parsed = JSON.parse(body) as unknown;
      const blocks = extractFenceBlocksFromBody(parsed);
      if (blocks.length === 0) return;
      const klass = classifyFenceBlocks(blocks);
      if (klass === "abstract") {
        const validated = blocks.filter(isClawInteractiveBlock);
        abstractBlocks = abstractBlocks.concat(validated);
        logVerbose(
          `[claw-debug] fence: abstract blocks=${validated.length} types=${validated.map((b) => b.type).join(",")}`,
        );
      } else if (klass === "raw") {
        rawBlocks = rawBlocks.concat(blocks);
        const types = blocks
          .map((b) =>
            b && typeof b === "object" ? String((b as { type?: unknown }).type ?? "?") : "?",
          )
          .join(",");
        logVerbose(`[claw-debug] fence: raw Slack blocks=${blocks.length} types=${types}`);
      }
    } catch (err) {
      parseFailed = true;
      logVerbose(`[claw-debug] fence: invalid JSON (${(err as Error).message})`);
    }
  };
  stripped = stripped.replace(getInteractiveFenceRe(), (_match, body: string) => {
    handleBody(body);
    return "";
  });
  if (hasJsonFallback) {
    stripped = stripped.replace(getJsonInteractiveFenceRe(), (_match, body: string) => {
      handleBody(body);
      logVerbose(`[claw-debug] fence: rescued json-fenced openclaw-interactive payload`);
      return "";
    });
  }
  stripped = stripped.replace(/\n{3,}/g, "\n\n").trim();
  // CLAW-FORK: if the ONLY content was a malformed fence (parse failed, no blocks
  // extracted, and no surrounding text survived), don't deliver silence. Emit a
  // clean notice instead of dropping the message or leaking raw fence JSON.
  if (!stripped && abstractBlocks.length === 0 && rawBlocks.length === 0 && parseFailed) {
    stripped = "응답 형식 오류로 내용을 표시하지 못했어요. (관리자 로그 확인 필요)";
  }
  return {
    text: stripped,
    ...(abstractBlocks.length > 0 ? { interactive: { blocks: abstractBlocks } } : {}),
    ...(rawBlocks.length > 0 ? { rawSlackBlocks: rawBlocks } : {}),
  };
}

// CLAW-FORK: "stranded Block Kit" guard.
// 봇이 Block Kit JSON 을 ```json ... ``` 같은 평문 코드블록 안에 넣고 끝내면
// Slack 은 그걸 코드 텍스트로만 보여줘 — 사용자한테는 "렌더 안 됨" 사고.
// 어제(2026-06-17) main 채널에서 정확히 이 패턴 발생 + 봇이 "보냈습니다" 로
// 거짓 보고함. 여기서 패턴을 감지해 응답 끝에 한 줄 안내를 자동 추가한다.
// 자동 송출 변환은 의도 모호(코드 예시 vs 송출 의도) 라 하지 않는다.
const BLOCK_KIT_KEY_RE =
  /"blocks"\s*:\s*\[|"type"\s*:\s*"(header|section|table|divider|actions|context)"/;
const FENCED_CODE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
function detectStrandedBlockKit(text: string): boolean {
  if (!text || !text.includes("```")) return false;
  FENCED_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCED_CODE_RE.exec(text)) !== null) {
    if (BLOCK_KIT_KEY_RE.test(m[1])) return true;
  }
  return false;
}

/** Parses inline reply directives into payload fields and silent-reply state. */
export function normalizeReplyPayloadDirectives(params: {
  payload: ReplyPayload;
  currentMessageId?: string;
  silentToken?: string;
  trimLeadingWhitespace?: boolean;
  parseMode?: ReplyDirectiveParseMode;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
}): { payload: ReplyPayload; isSilent: boolean } {
  const parseMode = params.parseMode ?? "always";
  const silentToken = params.silentToken ?? SILENT_REPLY_TOKEN;
  const sourceText = params.payload.text ?? "";

  const shouldParse =
    parseMode === "always" ||
    (parseMode === "auto" &&
      (sourceText.includes("[[") ||
        (params.extractMediaDirectives !== false && /media:/i.test(sourceText)) ||
        (params.extractMarkdownImages === true && /!\[[^\]]*]\(/.test(sourceText)) ||
        sourceText.includes(silentToken)));

  const parsed = shouldParse
    ? parseReplyDirectives(sourceText, {
        currentMessageId: params.currentMessageId,
        silentToken,
        extractMarkdownImages: params.extractMarkdownImages,
        extractMediaDirectives: params.extractMediaDirectives,
      })
    : undefined;

  let text = parsed ? parsed.text || undefined : params.payload.text || undefined;
  if (params.trimLeadingWhitespace && text) {
    text = text.trimStart() || undefined;
  }

  // CLAW-FORK: pull out interactive fence after directive parsing.
  let interactive = params.payload.interactive;
  let channelData = params.payload.channelData;
  let injectedRawSlackBlocks: unknown[] | undefined;
  if (text) {
    const extracted = extractClawInteractive(text);
    text = extracted.text || undefined;
    if (!interactive && extracted.interactive) {
      // ClawInteractive button.style is `string` (loose); InteractiveReply expects
      // the strict InteractiveButtonStyle enum. Runtime validators downstream
      // already coerce/validate, so the cast here is safe.
      interactive = extracted.interactive as unknown as typeof interactive;
    }
    if (extracted.rawSlackBlocks && extracted.rawSlackBlocks.length > 0) {
      injectedRawSlackBlocks = extracted.rawSlackBlocks;
    }
    // CLAW-FORK: 가드 — Block Kit JSON 이 ```json 코드블록에 stranded 됐고
    // 그게 실제 Block Kit 으로 변환된 블록(interactive/rawSlackBlocks) 도 없으면
    // 사용자한테 "코드블록일 뿐 렌더 안 됨" 한 줄 안내를 자동 추가.
    if (text && !interactive && !injectedRawSlackBlocks && detectStrandedBlockKit(text)) {
      text =
        text +
        "\n\n_⚠️ Block Kit JSON 이 코드블록 안에 평문으로 표시됐어요 — Slack 이 렌더하지 않습니다. 실제로 송출하려면 `mcp__openclaw__message` 의 `blocks` 파라미터로 보내야 해요._";
      logVerbose(`[claw-debug] stranded-block-kit guard fired (length=${text.length})`);
    }
  }

  // CLAW-FORK: merge fence-extracted raw Slack blocks into channelData.slack.blocks.
  if (injectedRawSlackBlocks && injectedRawSlackBlocks.length > 0) {
    channelData = mergeSlackBlocksIntoChannelData(channelData, injectedRawSlackBlocks);
    logVerbose(
      `[claw-debug] channelData.slack.blocks injected: added=${injectedRawSlackBlocks.length}`,
    );
  }

  let mediaUrls = params.payload.mediaUrls ?? parsed?.mediaUrls;

  // CLAW-FORK: detect output/<file>.<ext> mentions in body or blocks. If the
  // file actually exists, auto-attach (rescues compliance lapses where Kimi
  // forgot the MEDIA directive). If missing, log a warning so we can spot
  // hallucinations in the gateway log. See delivery-guards.ts for details.
  const detection = detectHallucinatedFiles({
    text,
    blocks: readSlackBlocksFromChannelData(channelData),
    existingMediaUrls: mediaUrls,
  });
  if (detection.autoAttach.length > 0) {
    mediaUrls = [...(mediaUrls ?? []), ...detection.autoAttach];
    logVerbose(
      `[claw-debug] hallucination-guard auto-attached files: ${detection.autoAttach
        .map((p) => path.basename(p))
        .join(", ")}`,
    );
  }
  if (detection.missing.length > 0) {
    logVerbose(
      `[claw-debug] hallucination-guard missing files (path mentioned but not on disk): ${detection.missing.join(
        ", ",
      )}`,
    );
  }

  const mediaUrl = params.payload.mediaUrl ?? parsed?.mediaUrl ?? mediaUrls?.[0];

  // CLAW-FORK 2026-05-03: format-guard — rewrite banned abstract shorthand
  // (interactive without raw blocks) to a 3-block RAW Block Kit card when a
  // media attachment is present. See delivery-guards.ts for full rationale.
  const formatGuard = applyMediaFormatGuard({ interactive, text, mediaUrl, mediaUrls });
  if (formatGuard) {
    channelData = mergeSlackBlocksIntoChannelData(channelData, formatGuard.rewrittenBlocks);
    // Drop the abstract interactive so we don't double-render with the RAW
    // blocks injected into channelData.slack.blocks.
    interactive = undefined;
    logVerbose(
      `[claw-debug] format-guard: rewrote abstract shorthand to RAW Block Kit (file=${formatGuard.fileBaseRaw}, summary=${formatGuard.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
    );
  }

  return {
    payload: copyReplyPayloadMetadata(params.payload, {
      ...params.payload,
      text,
      mediaUrls,
      mediaUrl,
      ...(interactive ? { interactive } : {}),
      ...(channelData ? { channelData } : {}),
      replyToId: params.payload.replyToId ?? parsed?.replyToId,
      replyToTag: params.payload.replyToTag || parsed?.replyToTag,
      replyToCurrent: params.payload.replyToCurrent || parsed?.replyToCurrent,
      audioAsVoice: Boolean(params.payload.audioAsVoice || parsed?.audioAsVoice),
    }),
    isSilent: parsed?.isSilent ?? false,
  };
}

async function sendDirectBlockReply(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  directlySentBlockKeys: Set<string>;
  directlySentBlockPayloads: Array<ReplyPayload | undefined>;
  trackingPayload: ReplyPayload;
  payload: ReplyPayload;
}) {
  const deliveryIndex = params.directlySentBlockPayloads.length;
  params.directlySentBlockPayloads.push(undefined);
  await params.onBlockReply(params.payload);
  params.directlySentBlockKeys.add(createBlockReplyContentKey(params.trackingPayload));
  if (!isReplyPayloadStatusNotice(params.trackingPayload)) {
    params.directlySentBlockPayloads[deliveryIndex] = params.trackingPayload;
  }
}

/** Creates the handler used for assistant block replies during streaming/tool phases. */
export function createBlockReplyDeliveryHandler(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  normalizeStreamingText: (payload: ReplyPayload) => { text?: string; skip: boolean };
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  typingSignals: TypingSignaler;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  directlySentBlockKeys: Set<string>;
  directlySentBlockPayloads: Array<ReplyPayload | undefined>;
}): (payload: ReplyPayload) => Promise<void> {
  return async (payload) => {
    const { text, skip } = params.normalizeStreamingText(payload);
    if (skip && !hasOutboundReplyContent({ ...payload, text: undefined })) {
      return;
    }

    const implicitCurrentMessageAllowed =
      payload.replyToCurrent === true
        ? true
        : payload.replyToCurrent === false
          ? false
          : params.replyThreading?.implicitCurrentMessage !== "deny";
    // Reply-to-current is implicit for block replies unless per-turn threading disables it.

    const taggedPayload = applyReplyTagsToPayload(
      {
        ...payload,
        text,
        mediaUrl: payload.mediaUrl ?? payload.mediaUrls?.[0],
        replyToId:
          payload.replyToId ??
          (implicitCurrentMessageAllowed ? params.currentMessageId : undefined),
      },
      params.currentMessageId,
    );

    // Let through payloads with audioAsVoice flag even if empty (need to track it).
    if (!isRenderablePayload(taggedPayload) && !payload.audioAsVoice) {
      return;
    }

    const normalized = normalizeReplyPayloadDirectives({
      payload: taggedPayload,
      currentMessageId: params.currentMessageId,
      silentToken: SILENT_REPLY_TOKEN,
      trimLeadingWhitespace: true,
      parseMode: "auto",
      extractMediaDirectives: false,
    });

    const mediaNormalizedPayload = params.normalizeMediaPaths
      ? await params.normalizeMediaPaths(normalized.payload)
      : normalized.payload;
    if (normalized.isSilent) {
      mediaNormalizedPayload.text = undefined;
    }
    const blockPayload = copyReplyPayloadMetadata(
      payload,
      params.applyReplyToMode(mediaNormalizedPayload),
    );
    const blockHasNonTextContent = hasOutboundReplyContent({ ...blockPayload, text: undefined });

    // Skip empty payloads unless they have audioAsVoice flag (need to track it).
    if (!blockPayload.text && !blockHasNonTextContent && !blockPayload.audioAsVoice) {
      return;
    }
    if (normalized.isSilent && !blockHasNonTextContent) {
      return;
    }

    if (blockPayload.text) {
      void params.typingSignals.signalTextDelta(blockPayload.text).catch((err: unknown) => {
        logVerbose(`block reply typing signal failed: ${String(err)}`);
      });
    }

    // Use pipeline if available (block streaming enabled), otherwise send directly.
    if (params.blockStreamingEnabled && params.blockReplyPipeline) {
      params.blockReplyPipeline.enqueue(blockPayload);
    } else if (params.blockStreamingEnabled) {
      // Send directly when flushing before tool execution (no pipeline but streaming enabled).
      // Track sent key to avoid duplicate in final payloads.
      await sendDirectBlockReply({
        onBlockReply: params.onBlockReply,
        directlySentBlockKeys: params.directlySentBlockKeys,
        directlySentBlockPayloads: params.directlySentBlockPayloads,
        trackingPayload: blockPayload,
        payload: blockPayload,
      });
    } else if (blockHasNonTextContent) {
      await sendDirectBlockReply({
        onBlockReply: params.onBlockReply,
        directlySentBlockKeys: params.directlySentBlockKeys,
        directlySentBlockPayloads: params.directlySentBlockPayloads,
        trackingPayload: blockPayload,
        payload: blockPayload,
      });
    }
    // When streaming is disabled entirely, text-only blocks are accumulated in final text.
  };
}
