import fs from "node:fs";
import path from "node:path";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { BlockReplyContext, ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import { createBlockReplyContentKey } from "./block-reply-pipeline.js";
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
const INTERACTIVE_FENCE_RE = /```openclaw-(?:interactive|blocks)\s*\n([\s\S]*?)\n```\s*/gi;

// CLAW-FORK fallback: Kimi sometimes emits the dispatch *output* schema inside a
// `json` (or untyped) fence instead of the expected `openclaw-interactive`
// fence. We rescue these by detecting the `"type":"openclaw-interactive"`
// signature in any fenced JSON block.
const JSON_INTERACTIVE_FENCE_RE =
  /```(?:json|jsonc|javascript|js)?\s*\n(\{[\s\S]*?"type"\s*:\s*"openclaw-interactive"[\s\S]*?\})\s*\n```\s*/gi;

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
      logVerbose(`[claw-debug] fence: invalid JSON (${(err as Error).message})`);
    }
  };
  stripped = stripped.replace(INTERACTIVE_FENCE_RE, (_match, body: string) => {
    handleBody(body);
    return "";
  });
  if (hasJsonFallback) {
    stripped = stripped.replace(JSON_INTERACTIVE_FENCE_RE, (_match, body: string) => {
      handleBody(body);
      logVerbose(`[claw-debug] fence: rescued json-fenced openclaw-interactive payload`);
      return "";
    });
  }
  stripped = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: stripped,
    ...(abstractBlocks.length > 0 ? { interactive: { blocks: abstractBlocks } } : {}),
    ...(rawBlocks.length > 0 ? { rawSlackBlocks: rawBlocks } : {}),
  };
}

// CLAW-FORK: hallucinated-file detector + auto-attach.
//
// Symptom we're addressing (observed 2026-04-26): Kimi K2.6 occasionally writes
// "📁 output/foo.html" or ":file_folder: output/bar.html" into the response body
// or Block Kit context elements, **without** actually calling the Write tool.
// User sees a "file" reference but there's nothing to click — also no permalink,
// no action button. The 3-step rule in AGENTS.md §"Query Response Flow" #6
// covers it on the prompt side, but compliance is non-deterministic.
//
// What this guard does (deterministic):
//   1. Scan response text + Block Kit string fields for `output/<file>.<ext>`
//      patterns (html/pdf/png/jpg/jpeg/svg/md, plus emoji-code prefixes like
//      `:file_folder:` / `📁 ` / `MEDIA:` not yet stripped).
//   2. Resolve each candidate against vault root (cwd parent) and cwd.
//   3. If file exists and isn't already in `mediaUrls` → add it. The downstream
//      normalizeMediaPaths picks it up and uploads, restoring the file +
//      action-button experience even when the model skipped the MEDIA directive.
//   4. If file is missing → log a warning (`hallucinated-output-path`). Don't
//      mutate text/blocks here to avoid shape corruption; the prompt rule plus
//      logging is enough to spot the issue.

const HALLUCINATION_PATH_RE =
  /(?:📁|:file_folder:|:paperclip:|📎|MEDIA:|^|\s|>)\s*((?:\.\.\/)?(?:output|\.\.\/output)\/[^\s'"<>`)\]]+\.(?:html|pdf|png|jpg|jpeg|svg|md))/gim;

function collectStringsFromBlocks(blocks: unknown[], out: string[]): void {
  for (const block of blocks) {
    if (typeof block === "string") {
      out.push(block);
    } else if (block && typeof block === "object") {
      for (const value of Object.values(block as Record<string, unknown>)) {
        if (typeof value === "string") {
          out.push(value);
        } else if (Array.isArray(value)) {
          collectStringsFromBlocks(value, out);
        } else if (value && typeof value === "object") {
          collectStringsFromBlocks([value], out);
        }
      }
    }
  }
}

function resolveOutputCandidate(candidate: string): string | undefined {
  const cleaned = candidate.trim().replace(/^\.\.\//, "");
  if (!cleaned) return undefined;
  const cwd = process.cwd();
  // CLAW-FORK: agents resolve `output/...` relative to their workspace dir
  // (~/openclaw-ws/output/...), not cwd. Add that to candidates so the
  // hallucination-guard doesn't drop renderer output. CLAW_AGENT_WORKSPACE
  // env can override.
  const workspace =
    process.env.CLAW_AGENT_WORKSPACE ||
    (process.env.HOME ? path.resolve(process.env.HOME, "openclaw-ws") : "");
  const candidates = [
    path.resolve(cwd, "..", cleaned),
    path.resolve(cwd, cleaned),
    path.resolve(cwd, "..", "..", cleaned),
    ...(workspace ? [path.resolve(workspace, cleaned)] : []),
  ];
  for (const abs of candidates) {
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return abs;
      }
    } catch {
      // ignore stat errors and try next candidate
    }
  }
  return undefined;
}

function detectHallucinatedFiles(params: {
  text?: string;
  blocks?: unknown[];
  existingMediaUrls?: string[];
}): { autoAttach: string[]; missing: string[] } {
  const sources: string[] = [];
  if (params.text) sources.push(params.text);
  if (params.blocks?.length) collectStringsFromBlocks(params.blocks, sources);
  const seen = new Set<string>();
  const autoAttach: string[] = [];
  const missing: string[] = [];
  const existing = new Set((params.existingMediaUrls ?? []).map((u) => u.trim()));
  for (const src of sources) {
    if (!src.includes("output/") && !src.includes("output\\")) continue;
    let m: RegExpExecArray | null;
    HALLUCINATION_PATH_RE.lastIndex = 0;
    while ((m = HALLUCINATION_PATH_RE.exec(src)) !== null) {
      const candidate = m[1];
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      // Skip if already covered by an explicit MEDIA directive (existing url).
      const alreadyAttached = Array.from(existing).some((u) =>
        u.endsWith(candidate.replace(/^\.\.\//, "")),
      );
      if (alreadyAttached) continue;
      const resolved = resolveOutputCandidate(candidate);
      if (resolved) {
        autoAttach.push(resolved);
      } else {
        missing.push(candidate);
      }
    }
  }
  return { autoAttach, missing };
}

export function normalizeReplyPayloadDirectives(params: {
  payload: ReplyPayload;
  currentMessageId?: string;
  silentToken?: string;
  trimLeadingWhitespace?: boolean;
  parseMode?: ReplyDirectiveParseMode;
}): { payload: ReplyPayload; isSilent: boolean } {
  const parseMode = params.parseMode ?? "always";
  const silentToken = params.silentToken ?? SILENT_REPLY_TOKEN;
  const sourceText = params.payload.text ?? "";

  const shouldParse =
    parseMode === "always" ||
    (parseMode === "auto" &&
      (sourceText.includes("[[") ||
        /media:/i.test(sourceText) ||
        sourceText.includes(silentToken)));

  const parsed = shouldParse
    ? parseReplyDirectives(sourceText, {
        currentMessageId: params.currentMessageId,
        silentToken,
      })
    : undefined;

  let text = parsed ? parsed.text || undefined : params.payload.text || undefined;
  if (params.trimLeadingWhitespace && text) {
    text = text.trimStart() || undefined;
  }

  // CLAW-FORK: pull out interactive fence after directive parsing.
  let interactive = params.payload.interactive;
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
  }

  let mediaUrls = params.payload.mediaUrls ?? parsed?.mediaUrls;

  // CLAW-FORK: detect output/<file>.<ext> mentions in body or blocks. If the
  // file actually exists, auto-attach (rescues compliance lapses where Kimi
  // forgot the MEDIA directive). If missing, log a warning so we can spot
  // hallucinations in the gateway log.
  const detectionText = text;
  const detectionBlocks = injectedRawSlackBlocks ?? [];
  const detection = detectHallucinatedFiles({
    text: detectionText,
    blocks: detectionBlocks,
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

  // CLAW-FORK 2026-05-03: format-guard for HTML/PDF attachment responses.
  //
  // Kimi K2.6 frequently emits two banned shorthand fence forms instead of the
  // 5-block RAW Slack Block Kit (header/section/divider/section.fields/context)
  // that the slack-response skill mandates for media-attached replies:
  //
  //   1. {"interactive": {"text": "...", "buttons": [...]}}        — root has no `blocks`
  //   2. {"blocks": [{"type": "text", ...}, {"type": "buttons"}]}  — only abstract types
  //
  // Both render as a near-empty Slack card next to the attachment. Prompt-only
  // rules in AGENTS.md + slack-response/SKILL.md proved insufficient (verified
  // 2026-05-03: bot violated the rules within minutes of tightening both files).
  // This guard rewrites at dispatch time AFTER MEDIA: directive is parsed and
  // mediaUrls is populated by the hallucination-guard auto-attach above.
  //
  // Rewrite output: a 3-block RAW kit (header + section.text + context with file
  // path). Skips divider+fields because synthesizing meaningful field content from
  // the shorthand text isn't reliable. Banned external-URL buttons in the fence
  // are dropped — fork still auto-adds the "🌐 브라우저에서 열기" button for the
  // attachment file.
  const hasMediaForGuard = Boolean(mediaUrl) || Boolean(mediaUrls && mediaUrls.length > 0);
  if (interactive && hasMediaForGuard) {
    const ABSTRACT_BLOCK_TYPES = new Set(["text", "buttons", "select"]);
    const interactiveObj = interactive as { blocks?: unknown[] } & Record<string, unknown>;
    const interactiveBlocks = Array.isArray(interactiveObj.blocks)
      ? (interactiveObj.blocks as Array<Record<string, unknown>>)
      : undefined;
    const isShorthandObject =
      !interactiveBlocks &&
      (typeof interactiveObj.text === "string" || Array.isArray(interactiveObj.buttons));
    const isAbstractBlocksOnly =
      interactiveBlocks &&
      interactiveBlocks.length > 0 &&
      interactiveBlocks.every((b) => {
        const t = (b as { type?: unknown })?.type;
        return typeof t === "string" && ABSTRACT_BLOCK_TYPES.has(t);
      });
    if (isShorthandObject || isAbstractBlocksOnly) {
      const candidatePath = String(mediaUrl ?? mediaUrls?.[0] ?? "");
      const fileBaseRaw = path.basename(candidatePath);
      const fileBase = fileBaseRaw.replace(/\.[^.]+$/, "");
      const titleHint =
        fileBase
          .replace(/-+\d{6,}-?\d{0,4}$/, "")
          .replace(/[-_]+/g, " ")
          .trim()
          .slice(0, 150) || "Output";
      let summary = "";
      if (typeof interactiveObj.text === "string") {
        summary = interactiveObj.text;
      } else if (interactiveBlocks) {
        summary = interactiveBlocks
          .filter((b) => (b as { type?: string }).type === "text")
          .map((b) => String((b as { text?: unknown }).text ?? ""))
          .filter(Boolean)
          .join("\n");
      }
      if (!summary && text) {
        summary = text;
      }
      const summaryClean =
        summary
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n")
          .slice(0, 2900) || "(첨부 파일 참고)";
      const rewrittenBlocks: unknown[] = [
        {
          type: "header",
          text: { type: "plain_text", text: titleHint, emoji: true },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: summaryClean },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `\`${fileBaseRaw}\`` }],
        },
      ];
      injectedRawSlackBlocks = [...(injectedRawSlackBlocks ?? []), ...rewrittenBlocks];
      // Drop the abstract interactive so we don't double-render with the RAW
      // blocks injected into channelData.slack.blocks below.
      interactive = undefined;
      logVerbose(
        `[claw-debug] format-guard: rewrote abstract shorthand to RAW Block Kit (file=${fileBaseRaw}, summary=${summaryClean.slice(0, 60).replace(/\n/g, " ")}…)`,
      );
    }
  }

  // CLAW-FORK: auto-synthesize a minimal Block Kit section when a media
  // attachment exists but the agent did not emit an `openclaw-interactive`
  // fence. Slack already renders the file as an attachment with download UX,
  // but a 1~2-line summary above it makes "what is this file" explicit
  // without depending on agent compliance. This is the deterministic
  // fallback that complements the prompt-level fence guidance.
  const hasMediaForSynth = Boolean(mediaUrl) || Boolean(mediaUrls && mediaUrls.length > 0);
  logVerbose(
    `[claw-debug] normalize: hasInteractive=${Boolean(interactive)} hasMedia=${hasMediaForSynth} textLen=${text?.length ?? 0}`,
  );
  if (!interactive && hasMediaForSynth && text) {
    const summary = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 2)
      .join(" ")
      .trim();
    if (summary) {
      interactive = {
        blocks: [{ type: "text", text: summary.slice(0, 2000) }],
      };
      logVerbose(`[claw-debug] auto-synthesized interactive section: ${summary.slice(0, 80)}`);
    } else {
      logVerbose(`[claw-debug] skipped auto-synthesize: empty summary`);
    }
  }

  // CLAW-FORK: merge raw Slack blocks into channelData.slack.blocks if any.
  let mergedChannelData = params.payload.channelData;
  if (injectedRawSlackBlocks && injectedRawSlackBlocks.length > 0) {
    const baseChannelData =
      params.payload.channelData && typeof params.payload.channelData === "object"
        ? (params.payload.channelData as Record<string, unknown>)
        : {};
    const baseSlack =
      baseChannelData.slack &&
      typeof baseChannelData.slack === "object" &&
      !Array.isArray(baseChannelData.slack)
        ? (baseChannelData.slack as Record<string, unknown>)
        : {};
    const existingBlocks = Array.isArray(baseSlack.blocks) ? (baseSlack.blocks as unknown[]) : [];
    mergedChannelData = {
      ...baseChannelData,
      slack: {
        ...baseSlack,
        blocks: [...existingBlocks, ...injectedRawSlackBlocks],
      },
    };
    logVerbose(
      `[claw-debug] channelData.slack.blocks injected: existing=${existingBlocks.length} added=${injectedRawSlackBlocks.length}`,
    );
  }

  return {
    payload: {
      ...params.payload,
      text,
      mediaUrls,
      mediaUrl,
      ...(interactive ? { interactive } : {}),
      ...(mergedChannelData ? { channelData: mergedChannelData } : {}),
      replyToId: params.payload.replyToId ?? parsed?.replyToId,
      replyToTag: params.payload.replyToTag || parsed?.replyToTag,
      replyToCurrent: params.payload.replyToCurrent || parsed?.replyToCurrent,
      audioAsVoice: Boolean(params.payload.audioAsVoice || parsed?.audioAsVoice),
    },
    isSilent: parsed?.isSilent ?? false,
  };
}

function carryReplyPayloadMetadata(source: ReplyPayload, target: ReplyPayload): ReplyPayload {
  const metadata = getReplyPayloadMetadata(source);
  return metadata ? setReplyPayloadMetadata(target, metadata) : target;
}

async function sendDirectBlockReply(params: {
  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => Promise<void> | void;
  directlySentBlockKeys: Set<string>;
  trackingPayload: ReplyPayload;
  payload: ReplyPayload;
}) {
  params.directlySentBlockKeys.add(createBlockReplyContentKey(params.trackingPayload));
  await params.onBlockReply(params.payload);
}

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
}): (payload: ReplyPayload) => Promise<void> {
  return async (payload) => {
    const { text, skip } = params.normalizeStreamingText(payload);
    if (skip && !resolveSendableOutboundReplyParts(payload).hasMedia) {
      return;
    }

    const implicitCurrentMessageAllowed =
      payload.replyToCurrent === true
        ? true
        : payload.replyToCurrent === false
          ? false
          : params.replyThreading?.implicitCurrentMessage !== "deny";

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
    });

    const mediaNormalizedPayload = params.normalizeMediaPaths
      ? await params.normalizeMediaPaths(normalized.payload)
      : normalized.payload;
    const blockPayload = carryReplyPayloadMetadata(
      payload,
      params.applyReplyToMode(mediaNormalizedPayload),
    );
    const blockHasMedia = resolveSendableOutboundReplyParts(blockPayload).hasMedia;

    // Skip empty payloads unless they have audioAsVoice flag (need to track it).
    if (!blockPayload.text && !blockHasMedia && !blockPayload.audioAsVoice) {
      return;
    }
    if (normalized.isSilent && !blockHasMedia) {
      return;
    }

    if (blockPayload.text) {
      void params.typingSignals.signalTextDelta(blockPayload.text).catch((err) => {
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
        trackingPayload: blockPayload,
        payload: blockPayload,
      });
    } else if (blockHasMedia && !blockPayload.text) {
      // Media-only block replies (for example orphaned tool attachments) are not reconstructible
      // from the assistant's final text, so they still need a direct fallback when streaming is off.
      await sendDirectBlockReply({
        onBlockReply: params.onBlockReply,
        directlySentBlockKeys: params.directlySentBlockKeys,
        trackingPayload: blockPayload,
        payload: blockPayload,
      });
    }
    // When streaming is disabled entirely, text-only blocks are accumulated in final text.
  };
}
