import fsSync from "node:fs";
import path from "node:path";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackReplyBlocks } from "../reply-blocks.js";
import {
  buildOutputStaticUrl,
  buildTunnelUrl,
  ensureOutputStaticServer,
} from "./output-static-server.js";
// CLAW-FORK 2026-05-03 (Phase 6 D2-D3, multi-agent): reviewer agent call.
// First-iteration policy = log verdict only, do NOT block send. D4 chunk
// will add reject-branch (specialist retry / safe fallback).
import { callReviewer } from "./reviewer-call.js";
import { sendMessageSlack, type SlackSendIdentity } from "./send.runtime.js";

// CLAW-FORK: media staging dir, used to compute browser-direct URLs for
// uploaded artifacts.
//
// IMPORTANT: by the time `mediaUrl` reaches this delivery code, fork's
// `normalizeMediaPaths` has *copied* the original artifact (e.g. `~/output/foo.html`)
// into a per-message staging directory at `~/.openclaw/media/outbound/<basename>---<uuid>.<ext>`.
// We point the static server at the staging dir so the path that arrives here
// is directly servable. Verified 2026-04-26 — the staging dir persists across
// sessions (files from earlier in the day still present).
function resolveOutputRoot(): string {
  // Explicit override wins.
  const override = process.env.CLAW_OUTPUT_ROOT;
  if (override && path.isAbsolute(override)) return override;
  // Default: $HOME/.openclaw/media/outbound (where normalizeMediaPaths stages files).
  // Falling back to $HOME/output if env doesn't expose HOME for some reason.
  const home = process.env.HOME ?? process.cwd();
  return path.resolve(home, ".openclaw", "media", "outbound");
}

// Eagerly spawn the static server so the first artifact reply doesn't pay TCP
// listen latency. Safe no-op if already running. Failures are swallowed —
// `buildOutputStaticUrl` will retry the spawn on demand.
try {
  ensureOutputStaticServer(resolveOutputRoot());
} catch {
  /* spawn deferred */
}

export function readSlackReplyBlocks(payload: ReplyPayload) {
  return resolveSlackReplyBlocks(payload);
}

// CLAW-FORK 2026-05-03 (Phase 6, multi-agent): best-effort extract agentId
// from a payload. ReplyPayload doesn't carry agentId directly, but the
// dispatcher's sessionKey (`agent:<id>:...`) is sometimes attached as
// `payload.sessionKey` or `payload.metadata.sessionKey`. We just return the
// agentId or undefined — reviewer is fine with undefined.
function extractAgentIdFromPayload(payload: ReplyPayload): string | undefined {
  const sessionKey =
    (payload as { sessionKey?: unknown }).sessionKey ??
    (payload as { metadata?: { sessionKey?: unknown } }).metadata?.sessionKey;
  if (typeof sessionKey !== "string" || !sessionKey) return undefined;
  const match = sessionKey.match(/^agent:([a-z0-9_-]+):/i);
  return match ? match[1] : undefined;
}

// CLAW-FORK: 데코 이모지 (`📊` 차트, `📁` 폴더, `📎` 클립) 와 그 Slack 코드 형태
// (`:bar_chart:`, `:file_folder:`, `:paperclip:`) 를 응답 본문에서 제거.
// AGENTS.md / SOUL.md 에 prompt 룰로 막아도 Kimi 가 학습 bias 로 종종 출력.
// fork 단에서 마지막 안전장치로 정리.
const DECO_EMOJI_PATTERN = /(?:📊|📁|📎|🦮)\s?|:bar_chart:\s?|:file_folder:\s?|:paperclip:\s?/g;

function stripDecorativeEmoji(text: string): string {
  if (!text) return text;
  return text
    .replace(DECO_EMOJI_PATTERN, "")
    .replace(/^\s+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

// CLAW-FORK: process-wide dup guard. Last resort against the recurring
// "same blocks/media delivered twice within ~1.5s" symptom that survived the
// dispatch.ts deliveryTracker race fix (2026-04-27). Catches any code path
// that funnels into deliverReplies with identical content+target.
const RECENT_DELIVERY_TTL_MS = 8000;
const recentDeliveryFingerprints = new Map<string, number>();

function fingerprintReply(
  target: string,
  payload: ReplyPayload,
  slackBlocks: unknown[] | undefined,
): string {
  const reply = resolveSendableOutboundReplyParts(payload);
  const blocksKey = slackBlocks?.length ? JSON.stringify(slackBlocks).slice(0, 4000) : "";
  const mediaKey = (reply.mediaUrls ?? [])
    .map((u) => path.basename(u || ""))
    .sort()
    .join("|");
  const textKey = (reply.trimmedText ?? "").slice(0, 200);
  return `${target}|${textKey}|${mediaKey}|${blocksKey}`;
}

function pruneExpiredDeliveryFingerprints(now: number): void {
  for (const [key, expiresAt] of recentDeliveryFingerprints) {
    if (expiresAt <= now) {
      recentDeliveryFingerprints.delete(key);
    }
  }
}

function shouldSkipDuplicateReply(
  target: string,
  payload: ReplyPayload,
  slackBlocks: unknown[] | undefined,
  log?: (m: string) => void,
): boolean {
  const fp = fingerprintReply(target, payload, slackBlocks);
  const now = Date.now();
  pruneExpiredDeliveryFingerprints(now);
  // Hash for terse logging — full key can be 4KB+
  const fpHash = fp.length > 64 ? `${fp.slice(0, 32)}…(${fp.length}c)` : fp;
  if (recentDeliveryFingerprints.has(fp)) {
    log?.(`[claw-debug] dup-guard HIT: ${fpHash}`);
    return true;
  }
  log?.(`[claw-debug] dup-guard MISS (recording): ${fpHash}`);
  recentDeliveryFingerprints.set(fp, now + RECENT_DELIVERY_TTL_MS);
  return false;
}

// CLAW-FORK: detect Slack section.fields entries whose text is missing /
// empty / whitespace-only. Slack rejects those with `invalid_blocks
// must be more than 0 characters [json-pointer:/blocks/N/fields/M/text]`,
// which kills the entire delivery. Kimi occasionally produces such
// placeholder fields (observed 2026-04-27 23:02). Strip them before send.
function isEmptyFieldEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return true;
  const e = entry as { text?: unknown; type?: unknown };
  if (typeof e.text !== "string") return true;
  return e.text.trim().length === 0;
}

function sanitizeSlackBlocks(blocks: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(blocks)) return blocks;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return stripDecorativeEmoji(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        result[key] = visit(raw);
      }
      return result;
    }
    return value;
  };
  const visited = blocks.map(visit) as unknown[];
  // Second pass: drop empty section.fields entries; if a section ends up with
  // no text and no fields, drop the section entirely.
  const cleaned: unknown[] = [];
  for (const block of visited) {
    if (!block || typeof block !== "object") {
      cleaned.push(block);
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "section" && Array.isArray(b.fields)) {
      const filteredFields = (b.fields as unknown[]).filter((entry) => !isEmptyFieldEntry(entry));
      const sectionTextEmpty =
        !b.text ||
        typeof (b.text as { text?: unknown }).text !== "string" ||
        (b.text as { text: string }).text.trim().length === 0;
      if (filteredFields.length === 0 && sectionTextEmpty) {
        // Skip this section block entirely — Slack rejects empty sections.
        continue;
      }
      const next: Record<string, unknown> = { ...b };
      if (filteredFields.length > 0) {
        next.fields = filteredFields;
      } else {
        delete next.fields;
      }
      cleaned.push(next);
      continue;
    }
    cleaned.push(block);
  }
  return cleaned;
}

// CLAW-FORK: 채널 root 답변에 `<@<sender_id>>` 멘션 prefix 강제. thread 답변은
// thread 자체로 알림이 가므로 prefix 안 함. AGENTS.md/SKILL.md 의 prompt 룰을
// Kimi 가 무시하는 케이스가 있어 fork 단에서 보장.
function applyMentionPrefix(params: {
  text: string;
  blocks?: unknown[];
  senderId?: string;
  isThreadReply: boolean;
}): { text: string; blocks?: unknown[] } {
  if (params.isThreadReply || !params.senderId) {
    return { text: params.text, blocks: params.blocks };
  }
  const mention = `<@${params.senderId}>`;
  const hasMentionInText = params.text.includes(mention);
  const newText = hasMentionInText
    ? params.text
    : params.text
      ? `${mention} ${params.text}`
      : mention;
  if (!Array.isArray(params.blocks) || params.blocks.length === 0) {
    return { text: newText, blocks: params.blocks };
  }
  // CLAW-FORK 2026-05-03: 두 번 멘션 방지 — text 에 이미 멘션 있으면
  // blocks 에도 또 박지 않음. Slack 카드와 fallback text 가 동시에 보내질
  // 때 사용자는 둘 중 하나만 봄 (mrkdwn block 우선) — 어느 쪽에 1번 있으면
  // 충분. text 분기에서 이미 hasMentionInText 가 true 면 skip.
  if (hasMentionInText) {
    return { text: newText, blocks: params.blocks };
  }
  // 첫 번째 mrkdwn 텍스트 블록에 mention 한번 prepend (header 의 plain_text 는 건드리지 않음).
  let injected = false;
  const newBlocks = params.blocks.map((block) => {
    if (injected || !block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "section") {
      const t = b.text as Record<string, unknown> | undefined;
      if (t && t.type === "mrkdwn" && typeof t.text === "string" && !t.text.includes(mention)) {
        injected = true;
        return { ...b, text: { ...t, text: `${mention} ${t.text}` } };
      }
    }
    return block;
  });
  // 어떤 mrkdwn 블록에도 못 넣었으면 맨 앞에 새 section 삽입.
  if (!injected) {
    newBlocks.unshift({ type: "section", text: { type: "mrkdwn", text: mention } });
  }
  return { text: newText, blocks: newBlocks };
}

export async function deliverReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all" | "batched";
  identity?: SlackSendIdentity;
  // CLAW-FORK: 채널 root 답변일 때 멘션 prefix 추가하기 위해 호출자가 sender 의
  // Slack user id 를 넘긴다. thread 답변에는 사용 안 함 (thread 자체로 알림).
  senderId?: string;
}) {
  for (const payload of params.replies) {
    // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
    // must not force threading.
    const inlineReplyToId = params.replyToMode === "off" ? undefined : payload.replyToId;
    const threadTs = inlineReplyToId ?? params.replyThreadTs;
    let reply = resolveSendableOutboundReplyParts(payload);
    // CLAW-FORK 2026-05-03: changed from const to let so the format-guard
    // (~line 296+ for hasMedia path) can reassign with a rewritten RAW
    // Block Kit when Kimi emits sparse abstract shorthand.
    let slackBlocks = readSlackReplyBlocks(payload);

    // CLAW-FORK 2026-05-03 (Phase 6 D4, multi-agent): reviewer hook + reject branch.
    // Fired ONCE per reply payload, before any send-branch resolution, so
    // every outbound reply (text-only, blocks-only, media+blocks) gets
    // reviewed exactly once.
    //
    // D4 policy:
    // - approve (or fail-safe approve on reviewer error/timeout) → continue
    //   to normal send branches.
    // - reject → skip all send branches and post a 1-line safe fallback
    //   so the user knows the answer was withheld + can re-prompt.
    //
    // False-positive risk is mitigated by the reviewer's "when in doubt,
    // approve" rule + the fail-safe approve on every reviewer error path.
    {
      const draftReply =
        reply.trimmedText ||
        (typeof (payload as { text?: string }).text === "string"
          ? (payload as { text: string }).text
          : "");
      if (draftReply) {
        const toolCallNames = Array.isArray(
          (payload as { metadata?: { toolCallNames?: unknown } }).metadata?.toolCallNames,
        )
          ? (payload as { metadata: { toolCallNames: string[] } }).metadata.toolCallNames
          : undefined;
        try {
          const verdict = await callReviewer({
            agentId: extractAgentIdFromPayload(payload),
            isChannelRoot: !threadTs,
            draftReply,
            toolCallNames,
          });
          params.runtime.log?.(
            `[claw-debug] reviewer: verdict=${verdict.verdict} reason="${verdict.reason}" ${verdict.durationMs}ms${verdict.fellBack ? " (fallback)" : ""}`,
          );
          if (verdict.verdict === "reject") {
            const fallbackText =
              `_⚠️ 답변 검증에서 ` +
              `\`${verdict.reason.slice(0, 100)}\` 사유로 차단됐어. ` +
              `다시 요청해줘._`;
            const mentioned = applyMentionPrefix({
              text: fallbackText,
              blocks: undefined,
              senderId: params.senderId,
              isThreadReply: Boolean(threadTs),
            });
            await sendMessageSlack(params.target, mentioned.text, {
              cfg: params.cfg,
              token: params.token,
              threadTs,
              accountId: params.accountId,
              ...(params.identity ? { identity: params.identity } : {}),
            });
            params.runtime.log?.(
              `[claw-debug] reviewer: rejected reply withheld; sent fallback to ${params.target}`,
            );
            continue;
          }
        } catch {
          // Reviewer threw outside its own fail-safe (shouldn't happen) —
          // proceed with normal send to avoid blocking on a broken side-channel.
          params.runtime.log?.("[claw-debug] reviewer: unexpected throw; proceeding with send");
        }
      }
    }

    // CLAW-FORK 2026-05-03: codeblock-fence rescue.
    //
    // Gemini 2.5 Flash sometimes wraps the Block Kit JSON in a ```json
    // markdown codeblock instead of the required <openclaw-interactive> fence
    // (verified 2026-05-03 turns 12:03 + 12:05 — both wrapped 5-block RAW kits
    // in ```json so resolveSlackReplyBlocks couldn't see them, format-guard
    // then fell back to a sparse 3-block rewrite, AND raw JSON leaked into
    // the Slack message body). Detect the pattern, lift the blocks out, and
    // strip the codeblock from payload.text so the model's intended kit
    // survives intact and raw JSON doesn't pollute the chat.
    if (!slackBlocks || slackBlocks.length === 0) {
      const rawText = (payload as { text?: string }).text ?? "";
      const codeBlockMatch = rawText.match(
        /```(?:json)?\s*(\{[\s\S]*?"blocks"\s*:\s*\[[\s\S]*?\][\s\S]*?\})\s*```/,
      );
      if (codeBlockMatch) {
        try {
          const parsed = JSON.parse(codeBlockMatch[1]) as { blocks?: unknown };
          if (Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
            slackBlocks = parsed.blocks as typeof slackBlocks;
            const cleaned = rawText
              .replace(codeBlockMatch[0], "")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            (payload as { text?: string }).text = cleaned;
            // Re-resolve so reply.trimmedText / hasContent reflect the
            // stripped body — otherwise downstream guards see the original
            // text including the JSON dump.
            reply = resolveSendableOutboundReplyParts(payload);
            params.runtime.log?.(
              `[claw-debug] codeblock-fence-rescue: extracted ${parsed.blocks.length} blocks from json codeblock; stripped from text`,
            );
          }
        } catch {
          // not valid JSON, leave as-is
        }
      }
    }

    if (!reply.hasContent && !slackBlocks?.length) {
      continue;
    }
    // CLAW-FORK: process-wide content-hash dup guard (8s TTL). Catches
    // duplicate deliveries that bypass the dispatch.ts deliveryTracker.
    if (shouldSkipDuplicateReply(params.target, payload, slackBlocks, params.runtime.log)) {
      params.runtime.log?.(
        `[claw-debug] dup-guard: suppressed duplicate delivery to ${params.target}`,
      );
      continue;
    }

    // CLAW-FORK 2026-05-03: media-existence guard.
    //
    // Detect when the agent emits a Block Kit fence + MEDIA: directive that
    // points to a file it never actually wrote. Verified 2026-05-03 11:51 with
    // Gemini 2.5 Flash: agent skipped the Write/Bash steps for envelope.json +
    // outprint-render, but still emitted `MEDIA: output/tax-handling-...html`
    // and a 5-block RAW fence as if the file existed. Slack got a card pointing
    // at nothing — user 👎 was justified. Same instruction-following limitation
    // as Kimi K2.6; prompt-only rules (AGENTS.md #6 "첨부 거짓말 절대 금지")
    // are insufficient for both models.
    //
    // Strategy: scan raw `payload.text` for `MEDIA: <path>` and check
    // `reply.mediaUrls` for any path that doesn't exist on disk. If ALL
    // referenced media is missing, drop the misleading fence + send a
    // text-only fallback acknowledging the failure. If only some are missing,
    // pass through unchanged (mixed cases are rare and the existing
    // hallucination-guard log will still flag them).
    {
      const workspaceRoot =
        process.env.OPENCLAW_WORKSPACE || process.env.CLAW_AGENT_WORKSPACE || process.cwd();
      const resolveMediaPath = (raw: string): string => {
        if (path.isAbsolute(raw)) return raw;
        return path.resolve(workspaceRoot, raw);
      };
      const isMissing = (raw: string): boolean => {
        if (!raw || raw.startsWith("http://") || raw.startsWith("https://")) return false;
        try {
          return !fsSync.existsSync(resolveMediaPath(raw));
        } catch {
          return false;
        }
      };
      const parsedMissing = (reply.mediaUrls ?? []).filter(isMissing);
      const parsedTotal = (reply.mediaUrls ?? []).filter(
        (u) => u && !u.startsWith("http://") && !u.startsWith("https://"),
      ).length;
      const rawText = (payload as { text?: string }).text ?? "";
      const rawMediaPaths = Array.from(rawText.matchAll(/(?:^|\s)MEDIA:\s*([^\s<>]+)/g)).map(
        (m) => m[1],
      );
      const rawMissing = rawMediaPaths.filter(isMissing);
      // Trigger condition: text or parsed-mediaUrls referenced files, AND every
      // local-path reference was missing on disk. Avoid false positives when
      // some real attachments coexist with a stray fake reference.
      const allParsedMissing = parsedTotal > 0 && parsedMissing.length === parsedTotal;
      const allRawMissing = rawMediaPaths.length > 0 && rawMissing.length === rawMediaPaths.length;
      const fullyHallucinated =
        (parsedTotal === 0 && allRawMissing) || (parsedTotal > 0 && allParsedMissing);
      if (fullyHallucinated) {
        const allMissing = Array.from(new Set([...parsedMissing, ...rawMissing]));
        const cleanedText = (reply.trimmedText || "")
          .replace(/(?:^|\n)\s*MEDIA:\s*\S+\s*/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const fallbackText = cleanedText
          ? `${cleanedText}\n\n_(첨부 파일 만들지 못해서 텍스트로만 답해 — 다시 요청하면 envelope 부터 새로 만들게.)_`
          : `요청한 답변을 첨부로 만들지 못했어. 다시 요청해줘. (시도한 경로: ${allMissing[0]})`;
        const mentioned = applyMentionPrefix({
          text: fallbackText,
          blocks: undefined,
          senderId: params.senderId,
          isThreadReply: Boolean(threadTs),
        });
        await sendMessageSlack(params.target, mentioned.text, {
          cfg: params.cfg,
          token: params.token,
          threadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
        params.runtime.log?.(
          `[claw-debug] media-guard: dropped fake MEDIA path(s) (${allMissing.join(
            ", ",
          )}); sent text-only fallback to ${params.target}`,
        );
        continue;
      }
    }

    if (!reply.hasMedia && slackBlocks?.length) {
      const trimmed = reply.trimmedText;
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      // CLAW-FORK: 데코 이모지 strip + 채널 root 면 mention prefix.
      const sanitizedText = stripDecorativeEmoji(trimmed ?? "");
      const sanitizedBlocks = sanitizeSlackBlocks(slackBlocks);
      const mentioned = applyMentionPrefix({
        text: sanitizedText,
        blocks: sanitizedBlocks,
        senderId: params.senderId,
        isThreadReply: Boolean(threadTs),
      });
      // (Reviewer hook fires once at the top of the for-loop — D3.5.)
      await sendMessageSlack(params.target, mentioned.text, {
        cfg: params.cfg,
        token: params.token,
        threadTs,
        accountId: params.accountId,
        ...(mentioned.blocks?.length ? { blocks: mentioned.blocks as never } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
      });
      params.runtime.log?.(`delivered reply to ${params.target}`);
      continue;
    }

    // CLAW-FORK: media + blocks 동시 송출 — 2-message flow.
    //
    // Slack API 제약상 단일 chat.postMessage 로 blocks + file 못 끼움. 우리는:
    //   ① 첫 메시지 = blocks (header/section/fields) + actions (브라우저에서 열기 버튼)
    //   ② 첨부 파일 = ①의 thread 안에 caption 메시지로
    //
    // 첨부가 thread 로 빠지면 채널 노이즈 줄어들고, button 은 첫 메시지 안에
    // 같이 묶여서 사용자가 "이 답변 = 한 메시지" 로 인식하기 좋음.
    if (reply.hasMedia && slackBlocks?.length) {
      const trimmedSummary = reply.trimmedText;
      const summaryIsSilent =
        trimmedSummary && isSilentReplyText(trimmedSummary, SILENT_REPLY_TOKEN);

      // CLAW-FORK 2026-05-03: format-guard for HTML/PDF attachment Slack cards.
      //
      // Kimi K2.6 ignores the slack-response/SKILL.md 5-block RAW template
      // (header/section/divider/section.fields/context) and emits an abstract
      // shorthand fence — typically `{interactive: {text, buttons}}` or
      // `{blocks: [{type:"text"}, {type:"buttons"}]}`. Upstream converts both
      // into a sparse 1~2-block Slack array (just a section + maybe an actions
      // block of external URL buttons), losing the proper card structure.
      //
      // Detect the sparse pattern and rewrite to RAW: header (from filename) +
      // section (preserve text) + context (file basename). External-URL
      // buttons inside the original actions block are dropped — the fork
      // auto-adds the "🌐 브라우저에서 열기" button below.
      //
      // Verified 2026-05-03: prompt-only rules (AGENTS.md + skill) failed to
      // change Kimi behavior; this guard is the deterministic floor.
      const RAW_BLOCK_TYPES = new Set(["header", "divider", "context", "image", "input", "table"]);
      const sparseShorthand = (() => {
        if (!slackBlocks || slackBlocks.length === 0) return false;
        // Already RAW (has header / divider / context / image / table) — accept as-is.
        const hasRichRaw = slackBlocks.some((b) => {
          const t = (b as { type?: unknown })?.type;
          return typeof t === "string" && RAW_BLOCK_TYPES.has(t);
        });
        if (hasRichRaw) return false;
        // Section with `fields` array also counts as proper RAW (4-section template).
        const hasFieldsSection = slackBlocks.some((b) => {
          const obj = b as { type?: unknown; fields?: unknown };
          return obj?.type === "section" && Array.isArray(obj.fields) && obj.fields.length > 0;
        });
        if (hasFieldsSection) return false;
        // Otherwise: at most a single section + an actions block = sparse shorthand.
        return slackBlocks.length <= 3;
      })();
      if (sparseShorthand) {
        const candidatePath = reply.mediaUrls.find(Boolean) ?? "";
        const fileBaseRaw = candidatePath ? (candidatePath.split("/").pop() ?? "") : "";
        const fileBase = fileBaseRaw.replace(/\.[^.]+$/, "");
        const titleHint =
          fileBase
            .replace(/-+\d{6,}-?\d{0,4}.*$/, "")
            .replace(/[-_]+/g, " ")
            .trim()
            .slice(0, 150) || "Output";
        // Extract any text content from the existing sparse blocks.
        const extractedTexts: string[] = [];
        for (const b of slackBlocks) {
          const obj = b as Record<string, unknown>;
          if (obj?.type === "section") {
            const t = obj.text as { text?: unknown } | undefined;
            if (typeof t?.text === "string") extractedTexts.push(t.text);
          }
        }
        const fallbackText = trimmedSummary ?? "";
        const summaryClean =
          (extractedTexts.join("\n").trim() || fallbackText).slice(0, 2900) || "(첨부 파일 참고)";
        const rewrittenBlocks: unknown[] = [
          { type: "header", text: { type: "plain_text", text: titleHint, emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: summaryClean } },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `\`${fileBaseRaw || "output"}\`` }],
          },
        ];
        slackBlocks = rewrittenBlocks as typeof slackBlocks;
        params.runtime.log?.(
          `[claw-debug] format-guard: rewrote sparse abstract slackBlocks to RAW (file=${fileBaseRaw}, summary=${summaryClean.slice(0, 60).replace(/\n/g, " ")}…)`,
        );
      }

      // CLAW-FORK: browser-action URL 사전 계산.
      //   1. Cloudflared tunnel URL (public https, 어디서나) — primary
      //   2. 로컬 static URL (PC only) — fallback
      //   업로드 후의 Slack `permalink` 는 button 을 첫 메시지에 묶으려면 미리
      //   필요한데 아직 업로드 안 했으니 못 씀. tunnel + local 만 사용.
      const outputRoot = resolveOutputRoot();
      const browserUrls: string[] = [];
      params.runtime.log?.(
        `[claw-debug] browser-button: outputRoot=${outputRoot} mediaUrls=${JSON.stringify(reply.mediaUrls)}`,
      );
      for (const mediaUrl of reply.mediaUrls) {
        if (!mediaUrl) continue;
        const isLocalPath =
          mediaUrl.startsWith("/") || mediaUrl.startsWith("./") || mediaUrl.startsWith("../");
        if (!isLocalPath) continue;
        const resolvedFilePath = path.resolve(mediaUrl);
        const tunnelUrl = buildTunnelUrl(resolvedFilePath, outputRoot);
        const localStaticUrl = buildOutputStaticUrl(resolvedFilePath, outputRoot);
        const chosen = tunnelUrl ?? localStaticUrl;
        params.runtime.log?.(
          `[claw-debug] browser-button: mediaUrl=${mediaUrl} tunnel=${tunnelUrl ? "yes" : "no"} local=${localStaticUrl ? "yes" : "no"} → chosen=${chosen ?? "<none>"}`,
        );
        if (chosen) browserUrls.push(chosen);
      }

      // CLAW-FORK: blocks 에 actions 블록 append.
      // action_id `claw_open_browser:<i>` 는 interactions.block-actions.ts 가
      // 클릭 시 message mutation 을 skip 하는 시그널. Slack 이 button payload 에
      // url 필드를 안 보내서 url 기반 검출 불가, action_id 가 유일한 시그널.
      // CLAW-FORK: blocks 에서 데코 이모지 (`📊`/`📁`/`📎`) strip 한 다음 actions
      // 부착. 사용자 prompt 룰만으로는 Kimi 가 종종 무시.
      const sanitizedBlocks = sanitizeSlackBlocks(slackBlocks) as typeof slackBlocks;
      const blocksWithActions = browserUrls.length
        ? [
            ...sanitizedBlocks,
            {
              type: "actions",
              elements: browserUrls.slice(0, 5).map((url, i) => ({
                type: "button" as const,
                action_id: `claw_open_browser:${i}`,
                text: {
                  type: "plain_text" as const,
                  text: browserUrls.length === 1 ? "🌐 브라우저에서 열기" : `🌐 파일 ${i + 1}`,
                },
                url,
              })),
            },
          ]
        : sanitizedBlocks;
      // 채널 root 면 첫 message 의 blocks 에 mention prefix 주입.
      const mentioned = applyMentionPrefix({
        text: "",
        blocks: blocksWithActions,
        senderId: params.senderId,
        isThreadReply: Boolean(threadTs),
      });
      const finalFirstBlocks = (mentioned.blocks ?? blocksWithActions) as typeof slackBlocks;

      params.runtime.log?.(
        `[claw-debug] split-send: hasMedia=true blockCount=${blocksWithActions.length} buttons=${browserUrls.length} summaryLen=${trimmedSummary?.length ?? 0} silent=${Boolean(summaryIsSilent)} mediaCount=${reply.mediaUrls.length}`,
      );

      // ① blocks + actions 메시지 송출. messageId 캡처해서 file 의 thread 부모로 사용.
      // CLAW-FORK: text 필드를 빈 문자열로 비움. trimmedSummary (예: "📊 ...만들었어.")
      // 는 blocks 의 헤더와 정보 중복이라 사용자가 "메시지 텍스트 + 카드" 두 번
      // 보는 셈. blocks 있을 때 Slack 은 text 가 비어있으면 알림 미리보기를
      // 자동으로 blocks 에서 합성. 사용자 요청 (2026-04-26): "이 메세지는 노출
      // 안해도 될 것 같아."
      let firstMessageTs: string | undefined;
      if (!summaryIsSilent) {
        const firstResp = await sendMessageSlack(params.target, "", {
          cfg: params.cfg,
          token: params.token,
          threadTs,
          accountId: params.accountId,
          blocks: finalFirstBlocks as never,
          ...(params.identity ? { identity: params.identity } : {}),
        });
        firstMessageTs = firstResp.messageId;
        params.runtime.log?.(
          `[claw-debug] delivered reply (blocks+actions, text-suppressed) to ${params.target} ts=${firstMessageTs} summarySuppressed=${trimmedSummary?.length ?? 0}chars`,
        );
      }

      // ② 파일을 thread 안에 caption 으로 송출.
      // - 이미 thread 안 메시지 (threadTs 이미 있음): 같은 thread 유지
      // - 아니면 위에서 보낸 첫 메시지의 ts 를 새 thread 부모로 사용
      const fileThreadTs = threadTs ?? firstMessageTs;
      const mediaCaption = "📎 첨부 파일";
      for (const mediaUrl of reply.mediaUrls) {
        if (!mediaUrl) continue;
        await sendMessageSlack(params.target, mediaCaption, {
          cfg: params.cfg,
          token: params.token,
          mediaUrl,
          threadTs: fileThreadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      }
      params.runtime.log?.(
        `[claw-debug] delivered media to ${params.target} threadTs=${fileThreadTs ?? "<none>"}`,
      );
      continue;
    }

    const delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: !reply.hasMedia
        ? (value) => {
            const trimmed = value.trim();
            if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
              return [];
            }
            return [trimmed];
          }
        : undefined,
      sendText: async (trimmed) => {
        await sendMessageSlack(params.target, trimmed, {
          cfg: params.cfg,
          token: params.token,
          threadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        await sendMessageSlack(params.target, caption ?? "", {
          cfg: params.cfg,
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      },
    });
    if (delivered !== "empty") {
      params.runtime.log?.(`delivered reply to ${params.target}`);
    }
  }
}

export type SlackRespondFn = (payload: {
  text: string;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied: boolean;
  isThreadReply?: boolean;
}): string | undefined {
  const planner = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasReplied,
    isThreadReply: params.isThreadReply,
  });
  return planner.use();
}

type SlackReplyDeliveryPlan = {
  peekThreadTs: () => string | undefined;
  nextThreadTs: () => string | undefined;
  markSent: () => void;
};

function createSlackReplyReferencePlanner(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied?: boolean;
  isThreadReply?: boolean;
}) {
  // Older/internal callers may not pass explicit thread classification. Keep
  // genuine thread replies sticky, but do not let Slack's auto-populated
  // top-level thread_ts override the configured replyToMode.
  const effectiveIsThreadReply =
    params.isThreadReply ??
    Boolean(params.incomingThreadTs && params.incomingThreadTs !== params.messageTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    replyToMode: effectiveMode,
    existingId: params.incomingThreadTs,
    startId: params.messageTs,
    hasReplied: params.hasReplied,
  });
}

export function createSlackReplyDeliveryPlan(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasRepliedRef: { value: boolean };
  isThreadReply?: boolean;
}): SlackReplyDeliveryPlan {
  const replyReference = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasRepliedRef.value,
    isThreadReply: params.isThreadReply,
  });
  return {
    peekThreadTs: () => replyReference.peek(),
    nextThreadTs: () => replyReference.use(),
    markSent: () => {
      replyReference.markSent();
      params.hasRepliedRef.value = replyReference.hasReplied();
    },
  };
}

export async function deliverSlackSlashReplies(params: {
  replies: ReplyPayload[];
  respond: SlackRespondFn;
  ephemeral: boolean;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const messages: string[] = [];
  const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
  for (const payload of params.replies) {
    const reply = resolveSendableOutboundReplyParts(payload);
    const text =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const combined = [text ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined];
    const chunks = markdownChunks.flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    for (const chunk of chunks) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const text of messages) {
    await params.respond({ text, response_type: responseType });
  }
}
