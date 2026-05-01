// CLAW-FORK 2026-04-30: RLHF Stage 2 — thread followup buttons + click handler.
//
// First retry attempt was rolled back based on a faulty hang diagnosis (mis-
// reading idle heartbeat behavior). Heartbeat fires only on active turns,
// not idle — so 0-log windows after restart are normal when no user messages
// are queued. This minimum-scope retry omits Stage 3 (modal) and Stage 4
// (saved-for-later synthesis) — adding those once the basic flow is verified.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { SlackActionMiddlewareArgs } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import { WebClient } from "@slack/web-api";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  SLACK_FEEDBACK_BAD_ACTION_ID,
  SLACK_FEEDBACK_GOOD_ACTION_ID,
  SLACK_FEEDBACK_UNDO_ACTION_ID,
} from "../../reply-action-ids.js";

const FEEDBACK_LOG_DIR =
  process.env.OPENCLAW_FORMAT_FEEDBACK_DIR ??
  `${process.env.HOME ?? "/home/self-made-orange"}/openclaw-ws/wiki/_format-feedback`;
const FEEDBACK_MIN_TEXT_LEN = 100;

// Inline (avoid import cycle with monitor/replies.ts which transitively
// pulls in dispatch.ts).
function readSlackReplyBlocksInline(payload: ReplyPayload): unknown[] | undefined {
  const channelData = (payload as { channelData?: { slack?: { blocks?: unknown[] } } }).channelData;
  return channelData?.slack?.blocks;
}

export function shouldPostFeedbackButtons(payload: ReplyPayload): boolean {
  if (payload.isError) return false;
  const reply = resolveSendableOutboundReplyParts(payload);
  if (reply.hasMedia) return true;
  const blocks = readSlackReplyBlocksInline(payload);
  if (blocks?.length) return true;
  return reply.trimmedText.length >= FEEDBACK_MIN_TEXT_LEN;
}

export async function postFeedbackButtonsInThread(params: {
  token: string;
  channelId: string;
  threadTs: string;
  log?: (msg: string) => void;
}): Promise<void> {
  if (!params.threadTs) return;
  const client = new WebClient(params.token);
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "actions",
      block_id: `openclaw_feedback:${params.threadTs}`,
      elements: [
        {
          type: "button",
          action_id: SLACK_FEEDBACK_GOOD_ACTION_ID,
          text: { type: "plain_text", text: "👍 좋은 답" },
          value: params.threadTs,
        },
        {
          type: "button",
          action_id: SLACK_FEEDBACK_BAD_ACTION_ID,
          text: { type: "plain_text", text: "👎 다시" },
          value: params.threadTs,
        },
      ],
    },
  ];
  try {
    await client.chat.postMessage({
      channel: params.channelId,
      thread_ts: params.threadTs,
      text: "이 답변 어떻게?",
      blocks,
    });
    params.log?.(`[claw-debug] feedback-followup: posted in thread ${params.threadTs}`);
  } catch (err) {
    params.log?.(
      `[claw-debug] feedback-followup: failed for thread ${params.threadTs}: ${(err as Error)?.message ?? err}`,
    );
  }
}

export async function handleFeedbackButtonClick(params: {
  args: SlackActionMiddlewareArgs;
  actionId: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const body = params.args.body as Record<string, unknown>;
  const user = body.user as { id?: string; username?: string } | undefined;
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string; thread_ts?: string } | undefined;
  const action = params.args.action as { value?: string } | undefined;
  const userId = user?.id ?? "unknown";
  const userName = user?.username ?? userId;
  const channelId = channel?.id;
  const buttonMessageTs = message?.ts;
  const threadTs = message?.thread_ts ?? action?.value;
  const isGood = params.actionId === SLACK_FEEDBACK_GOOD_ACTION_ID;
  const fileName = isGood ? "positive.md" : "negative.md";
  const emoji = isGood ? "👍" : "👎";
  const isoTs = new Date().toISOString();
  const line = `- ${isoTs} | thread=${threadTs ?? "?"} | by=${userName} (${userId}) | ${emoji}\n`;
  try {
    await mkdir(FEEDBACK_LOG_DIR, { recursive: true });
    await appendFile(`${FEEDBACK_LOG_DIR}/${fileName}`, line, "utf8");
    params.log?.(
      `[claw-debug] feedback-click: ${emoji} appended to ${fileName} (thread=${threadTs}, by=${userId})`,
    );
  } catch (err) {
    params.log?.(`[claw-debug] feedback-click: append failed: ${(err as Error)?.message ?? err}`);
  }
  if (channelId && buttonMessageTs) {
    try {
      const client = params.args.client as WebClient | undefined;
      if (client) {
        const category = isGood ? "positive" : "negative";
        const undoValue = `${threadTs ?? "?"}:${category}`;
        await client.chat.update({
          channel: channelId,
          ts: buttonMessageTs,
          text: `${emoji} <@${userId}>`,
          blocks: [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${emoji} <@${userId}> ${isGood ? "좋은 답으로 표시" : "보완 필요로 표시"}`,
                },
              ],
            },
            {
              type: "actions",
              block_id: `openclaw_feedback_undo:${threadTs ?? "?"}`,
              elements: [
                {
                  type: "button",
                  action_id: SLACK_FEEDBACK_UNDO_ACTION_ID,
                  text: { type: "plain_text", text: "↶ 취소" },
                  value: undoValue,
                },
              ],
            },
          ],
        });
      }
    } catch (err) {
      params.log?.(
        `[claw-debug] feedback-click: chat.update failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

// Undo handler — invoked from interactions.block-actions.ts short-circuit when
// SLACK_FEEDBACK_UNDO_ACTION_ID matches. Removes the most recent matching line
// from the corresponding feedback file, then restores the original 👍/👎 buttons.
export async function handleFeedbackUndoClick(params: {
  args: SlackActionMiddlewareArgs;
  log?: (msg: string) => void;
}): Promise<void> {
  const body = params.args.body as Record<string, unknown>;
  const user = body.user as { id?: string; username?: string } | undefined;
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string; thread_ts?: string } | undefined;
  const action = params.args.action as { value?: string } | undefined;
  const userId = user?.id ?? "unknown";
  const channelId = channel?.id;
  const buttonMessageTs = message?.ts;
  const value = action?.value ?? "";
  const colonIdx = value.lastIndexOf(":");
  const threadTs = colonIdx > 0 ? value.slice(0, colonIdx) : value;
  const category = colonIdx > 0 ? value.slice(colonIdx + 1) : "";
  const fileName =
    category === "positive" ? "positive.md" : category === "negative" ? "negative.md" : "";
  if (!fileName || !threadTs) {
    params.log?.(`[claw-debug] feedback-undo: invalid value="${value}"`);
    return;
  }

  // Remove most recent line matching `thread=<ts>` AND `(<userId>)`.
  let removed = false;
  try {
    const filePath = `${FEEDBACK_LOG_DIR}/${fileName}`;
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (ln.includes(`thread=${threadTs}`) && ln.includes(`(${userId})`)) {
        lines.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (removed) {
      await writeFile(filePath, lines.join("\n"), "utf8");
      params.log?.(
        `[claw-debug] feedback-undo: removed line from ${fileName} (thread=${threadTs}, by=${userId})`,
      );
    } else {
      params.log?.(
        `[claw-debug] feedback-undo: no matching line in ${fileName} (thread=${threadTs}, by=${userId})`,
      );
    }
  } catch (err) {
    params.log?.(`[claw-debug] feedback-undo: file edit failed: ${(err as Error)?.message ?? err}`);
  }

  // Restore original 👍/👎 buttons.
  if (channelId && buttonMessageTs) {
    try {
      const client = params.args.client as WebClient | undefined;
      if (client) {
        await client.chat.update({
          channel: channelId,
          ts: buttonMessageTs,
          text: "이 답변 어떻게?",
          blocks: [
            {
              type: "actions",
              block_id: `openclaw_feedback:${threadTs}`,
              elements: [
                {
                  type: "button",
                  action_id: SLACK_FEEDBACK_GOOD_ACTION_ID,
                  text: { type: "plain_text", text: "👍 좋은 답" },
                  value: threadTs,
                },
                {
                  type: "button",
                  action_id: SLACK_FEEDBACK_BAD_ACTION_ID,
                  text: { type: "plain_text", text: "👎 다시" },
                  value: threadTs,
                },
              ],
            },
          ],
        });
      }
    } catch (err) {
      params.log?.(`[claw-debug] feedback-undo: restore failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
