// Slack plugin module implements reactions behavior.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { allowListMatches, normalizeAllowListLower } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

// CLAW-FORK: positive emoji aliases — silent logging fast-path.
// `:+1:` / `:thumbsup:` (👍) — 표준 thumbs up
// `:white_check_mark:` (✅) — "확인" / "동의" / "approved" 의미로 흔히 쓰임
// `:heavy_check_mark:` (✔) — 같은 ✓ 계열
// `:ok_hand:` (👌) — 한국어권에서 thumbs up 대체로 자주 사용
// `:heart:` (❤️) — strong positive 시그널
// LLM agent run 발화 안 하고 fast-path 으로 직접
// wiki/_format-feedback/positive.md 에 append. 0 latency + 0 토큰.
const POSITIVE_EMOJI = new Set([
  "+1",
  "thumbsup",
  "white_check_mark",
  "heavy_check_mark",
  "ok_hand",
  "heart",
]);

// CLAW-FORK: block sequence + char counts derivation for §positive entries.
// Slack Block Kit block 을 SKILL.md §positive 가 기대하는 짧은 label 로 압축.
// 알 수 없는 type 은 그대로 통과 (downstream 클러스터링이 처리).
function summarizeBlockSig(block: { type?: string; fields?: unknown[] }): string {
  const type = block.type ?? "unknown";
  if (type === "section" && Array.isArray(block.fields) && block.fields.length > 0) {
    return `section.fields(${block.fields.length})`;
  }
  return type;
}

// header/section/context 만 의미 있는 text 추출. rich_text 등 복잡 block 은
// JSON length 로 근사. 정확한 char count 가 아니라 형태 신호 용도.
function extractBlockText(block: {
  type?: string;
  text?: { text?: string };
  fields?: Array<{ text?: string }>;
  elements?: Array<{ type?: string; text?: string }>;
}): string {
  const parts: string[] = [];
  if (block.text?.text) parts.push(block.text.text);
  if (Array.isArray(block.fields)) {
    for (const f of block.fields) {
      if (f?.text) parts.push(f.text);
    }
  }
  if (Array.isArray(block.elements)) {
    for (const e of block.elements) {
      if ((e?.type === "mrkdwn" || e?.type === "plain_text") && e.text) parts.push(e.text);
    }
  }
  return parts.join("");
}

type SlackMessageBlocksLike = {
  text?: string;
  blocks?: Array<Record<string, unknown>>;
};

async function fetchBotMessageBlocks(params: {
  client: SlackWebClient;
  channelId: string;
  msgTs: string;
}): Promise<SlackMessageBlocksLike | undefined> {
  try {
    const response = (await params.client.conversations.history({
      channel: params.channelId,
      latest: params.msgTs,
      oldest: params.msgTs,
      inclusive: true,
      limit: 1,
    })) as { messages?: SlackMessageBlocksLike[] };
    return response.messages?.[0];
  } catch {
    return undefined;
  }
}

async function fastLogPositiveReaction(params: {
  channelLabel: string;
  channelId?: string;
  msgTs?: string;
  reactor: string;
  authorLabel?: string;
  client?: SlackWebClient;
}): Promise<void> {
  const home = process.env.HOME;
  if (!home) return;
  const positivePath = path.resolve(home, "wiki/_format-feedback/positive.md");
  // 파일이 아직 없거나 디렉토리 누락이면 silent skip — 사용자가 vault 셋업 하면
  // 자연스럽게 동작 시작. 굳이 만들지 않음.
  try {
    await fs.access(positivePath);
  } catch {
    return;
  }
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const stamp = `${yyyy}-${mm}-${dd} ${hh}:${min}`;

  // 봇 메시지 재조회 → block sequence + char counts. 실패하면 약식 fallback.
  // LLM 호출 없음 — 0 추가 토큰. slack API 1회만 추가.
  let blockSequenceLine = "";
  let charCountsLine = "";
  if (params.client && params.channelId && params.msgTs) {
    const message = await fetchBotMessageBlocks({
      client: params.client,
      channelId: params.channelId,
      msgTs: params.msgTs,
    });
    if (message) {
      const blocks = Array.isArray(message.blocks) ? message.blocks : [];
      if (blocks.length > 0) {
        const sequence = blocks.map((b) => summarizeBlockSig(b)).join(" → ");
        blockSequenceLine = `- block sequence: \`${sequence}\`\n`;
      }
      const textLen = (message.text ?? "").length;
      const blocksTextLen = blocks.reduce((acc, b) => acc + extractBlockText(b).length, 0);
      if (textLen > 0 || blocksTextLen > 0) {
        charCountsLine = `- char counts: text=${textLen}, blocks_text=${blocksTextLen}\n`;
      }
    }
  }

  const entry = `\n## ${stamp} | quick-log | reactor: ${params.reactor}\n- channel: \`${params.channelId ?? params.channelLabel}\`\n- msg ts: \`${params.msgTs ?? ""}\`\n- author: \`${params.authorLabel ?? ""}\`\n${blockSequenceLine}${charCountsLine}- block analysis: pending (synth)\n`;
  await fs.appendFile(positivePath, entry, "utf-8");
}

function shouldEmitSlackReactionNotification(params: {
  ctx: SlackMonitorContext;
  event: SlackReactionEvent;
  actorName?: string;
}) {
  const { ctx, event, actorName } = params;
  if (ctx.reactionMode === "off") {
    return false;
  }
  if (ctx.reactionMode === "own") {
    return Boolean(ctx.botUserId && event.item_user === ctx.botUserId);
  }
  if (ctx.reactionMode === "allowlist") {
    const allowList = normalizeAllowListLower(ctx.reactionAllowlist);
    if (allowList.length === 0) {
      return false;
    }
    return allowListMatches({
      allowList,
      id: event.user,
      name: actorName,
      allowNameMatching: ctx.allowNameMatching,
    });
  }
  return ctx.reactionMode === "all";
}

export function registerSlackReactionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleReactionEvent = async (event: SlackReactionEvent, action: string) => {
    try {
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }
      if (ctx.reactionMode === "off") {
        return;
      }
      if (ctx.reactionMode === "own" && (!ctx.botUserId || event.item_user !== ctx.botUserId)) {
        return;
      }
      trackEvent?.();

      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: event.user,
        channelId: item.channel,
        eventKind: "reaction",
      });
      if (!ingressContext) {
        return;
      }

      const actorInfoPromise: Promise<{ name?: string } | undefined> = event.user
        ? ctx.resolveUserName(event.user)
        : Promise.resolve(undefined);
      const authorInfoPromise: Promise<{ name?: string } | undefined> = event.item_user
        ? ctx.resolveUserName(event.item_user)
        : Promise.resolve(undefined);
      const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);

      // CLAW-FORK fast-path: positive emoji on the bot's own message → silent
      // logging. 첨부 송출 / 답글 / agent run 모두 필요 없음 — 직접 file append
      // 만 하고 0-latency 종료 (no agent dispatch, 0 토큰).
      // `removed` 는 무시 (이미 로깅된 entry 는 synth 가 dedupe / cleanup).
      const isOwnMessage = Boolean(ctx.botUserId && event.item_user === ctx.botUserId);
      const fastEmojiLabel = event.reaction ?? "emoji";
      if (isOwnMessage && POSITIVE_EMOJI.has(fastEmojiLabel)) {
        if (action === "added") {
          try {
            await fastLogPositiveReaction({
              channelLabel: ingressContext.channelLabel,
              channelId: item.channel,
              msgTs: item.ts,
              reactor: actorInfo?.name ?? event.user ?? "unknown",
              authorLabel: authorInfo?.name ?? event.item_user,
              client: ctx.app.client,
            });
            ctx.runtime.log?.(
              `[claw-debug] reaction :+1: silent-logged (no wake): channel=${item.channel} msg=${item.ts}`,
            );
          } catch (err) {
            ctx.runtime.error?.(
              danger(`fast-path positive log failed: ${formatErrorMessage(err)}`),
            );
          }
        }
        // :+1: 토글 취소 (removed): 아무것도 안 함 (이미 silent-logged 된 entry 도 그대로).
        return;
      }

      if (
        !shouldEmitSlackReactionNotification({
          ctx,
          event,
          actorName: actorInfo?.name,
        })
      ) {
        return;
      }
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      enqueueSystemEvent(text, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${formatErrorMessage(err)}`));
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_added">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );
}
