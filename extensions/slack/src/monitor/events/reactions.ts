import { promises as fs } from "node:fs";
import path from "node:path";
import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { enqueueSystemEvent, requestHeartbeatNow } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

// CLAW-FORK: `:+1:` / `:thumbsup:` 는 silent positive 로깅만 — LLM agent run
// 발화 안 하고 fast-path 으로 직접 wiki/_format-feedback/positive.md 에 append.
// 이유: positive feedback 은 응답 송출 없음 (silent logging) 이라서 agent 한테
// 맡기면 wake → heartbeat → kimi run (수십초 + 토큰) 만 낭비. 직접 파일 I/O 가
// 0 latency + 0 토큰. 구조 분석은 나중 §synth 패스에서 batch.
const POSITIVE_EMOJI = new Set(["+1", "thumbsup"]);

async function fastLogPositiveReaction(params: {
  channelLabel: string;
  channelId?: string;
  msgTs?: string;
  reactor: string;
  authorLabel?: string;
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
  const entry = `\n## ${stamp} | quick-log | reactor: ${params.reactor}\n- channel: \`${params.channelId ?? params.channelLabel}\`\n- msg ts: \`${params.msgTs ?? ""}\`\n- author: \`${params.authorLabel ?? ""}\`\n- block analysis: pending (synth)\n`;
  await fs.appendFile(positivePath, entry, "utf-8");
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
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorLabel = authorInfo?.name ?? event.item_user;

      // CLAW-FORK fast-path: :+1: silent logging. 첨부 송출 / 답글 / agent run
      // 모두 필요 없음 — 직접 file append 만 하고 0-latency 종료.
      // `removed` 는 무시 (이미 로깅된 entry 는 synth 가 dedupe / cleanup).
      if (action === "added" && POSITIVE_EMOJI.has(emojiLabel)) {
        try {
          await fastLogPositiveReaction({
            channelLabel: ingressContext.channelLabel,
            channelId: item.channel,
            msgTs: item.ts,
            reactor: actorLabel ?? "unknown",
            authorLabel,
          });
          ctx.runtime.log?.(
            `[claw-debug] reaction :+1: silent-logged (no wake): channel=${item.channel} msg=${item.ts}`,
          );
        } catch (err) {
          ctx.runtime.error?.(danger(`fast-path positive log failed: ${formatErrorMessage(err)}`));
        }
        return;
      }
      if (action === "removed" && POSITIVE_EMOJI.has(emojiLabel)) {
        // :+1: 토글 취소: 아무것도 안 함 (이미 silent-logged 된 entry 도 그대로).
        return;
      }

      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      enqueueSystemEvent(text, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
        // CLAW-FORK: carry the bot message ts as the thread parent so the wake
        // -driven heartbeat reply lands as a thread reply on the reacted message.
        // Without this, heartbeat delivery drops the inherited session thread_ts
        // and posts to the channel root.
        deliveryContext: {
          channel: "slack",
          to: item.channel,
          threadId: item.ts,
        },
      });
      // CLAW-FORK: reactions don't otherwise wake the agent — without this the
      // event sits in the queue until the next user message or HEARTBEAT.md
      // -driven heartbeat. Force an immediate heartbeat run so format-feedback
      // / saved-for-later promotion fires right away.
      requestHeartbeatNow({
        reason: "wake",
        sessionKey: ingressContext.sessionKey,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${formatErrorMessage(err)}`));
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_added">) => {
      // CLAW-FORK: temporary diagnostic — surface every reaction event as it
      // arrives so we can confirm Slack delivery vs internal drop.
      ctx.runtime.log?.(
        `[claw-debug] reaction_added arrived: emoji=${(event as SlackReactionEvent).reaction} actor=${(event as SlackReactionEvent).user} item.ts=${(event as SlackReactionEvent).item?.ts}`,
      );
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        ctx.runtime.log?.(`[claw-debug] reaction_added DROPPED by mismatched-slack-event guard`);
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      ctx.runtime.log?.(
        `[claw-debug] reaction_removed arrived: emoji=${(event as SlackReactionEvent).reaction} actor=${(event as SlackReactionEvent).user} item.ts=${(event as SlackReactionEvent).item?.ts}`,
      );
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        ctx.runtime.log?.(`[claw-debug] reaction_removed DROPPED by mismatched-slack-event guard`);
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );

  // CLAW-FORK: also log handler registration so we can verify it's actually wired.
  ctx.runtime.log?.(`[claw-debug] reaction handlers registered (added + removed)`);
}
