// Slack plugin module implements replies behavior.
import type { MessageMetadata } from "@slack/types";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  chunkMarkdownTextWithMode,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";
import {
  deliverTextOrMediaReply,
  getReplyPayloadMetadata,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackReplyBlocks } from "../reply-blocks.js";
// CLAW-FORK (ported to v2026.6.6 base): outbound-response reviewer agent call.
// Filter-mode: reject appends a footer + records the reject; never blocks send.
import { callReviewer, recordReviewerReject } from "./reviewer-call.js";
import { sendMessageSlack, type SlackSendIdentity } from "./send.runtime.js";

export function readSlackReplyBlocks(payload: ReplyPayload) {
  return resolveSlackReplyBlocks(payload);
}

// CLAW-FORK (Phase 6, multi-agent): best-effort extract agentId from a payload.
// ReplyPayload doesn't carry agentId directly, but the dispatcher's sessionKey
// (`agent:<id>:...`) is sometimes attached as `payload.sessionKey` or
// `payload.metadata.sessionKey`. We just return the agentId or undefined —
// reviewer is fine with undefined.
function extractAgentIdFromPayload(payload: ReplyPayload): string | undefined {
  const sessionKey =
    (payload as { sessionKey?: unknown }).sessionKey ??
    (payload as { metadata?: { sessionKey?: unknown } }).metadata?.sessionKey;
  if (typeof sessionKey !== "string" || !sessionKey) return undefined;
  const match = sessionKey.match(/^agent:([a-z0-9_-]+):/i);
  return match ? match[1] : undefined;
}

export function resolveDeliveredSlackReplyThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  payloadReplyToId?: string;
  replyThreadTs?: string;
}): string | undefined {
  // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
  // must not force threading.
  const inlineReplyToId = params.replyToMode === "off" ? undefined : params.payloadReplyToId;
  return inlineReplyToId ?? params.replyThreadTs;
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
  metadata?: MessageMetadata;
}) {
  for (const payload of params.replies) {
    if (payload.isReasoning === true) {
      continue;
    }
    const threadTs = resolveDeliveredSlackReplyThreadTs({
      replyToMode: params.replyToMode,
      payloadReplyToId: payload.replyToId,
      replyThreadTs: params.replyThreadTs,
    });
    let reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);

    // CLAW-FORK (Phase 6 D4, multi-agent; ported to v2026.6.6 base): reviewer
    // hook. Fired ONCE per reply payload, before any send-branch resolution,
    // so every outbound reply (text-only, blocks, media) is reviewed exactly
    // once.
    //
    // Filter (not gate) policy: full-block reject is data-loss for the user.
    // On reject we SHIP the answer + append a small footer + record the reject
    // for later prompt iteration. Reviewer error/timeout → fail-safe approve.
    {
      const draftReply =
        reply.trimmedText ||
        (typeof (payload as { text?: string }).text === "string"
          ? (payload as { text: string }).text
          : "");
      if (draftReply) {
        // Tool call names are stamped on the payload's metadata (WeakMap-backed)
        // by dispatch-from-config.ts.
        const toolCallNames = getReplyPayloadMetadata(payload)?.toolCallNames;
        // Skip reviewer for direct-to-user agents where the user reviews
        // outputs themselves (e.g. self-improve via branch diff, data-analyst
        // bots against external dashboards). Read from per-agent
        // `agents.list[].responseReviewer: "off"` config.
        const reviewerAgentId = extractAgentIdFromPayload(payload);
        const reviewerPolicy = reviewerAgentId
          ? params.cfg.agents?.list?.find((entry) => entry.id === reviewerAgentId)?.responseReviewer
          : undefined;
        if (reviewerAgentId && reviewerPolicy === "off") {
          params.runtime.log?.(
            `[claw-debug] reviewer: skipped for ${reviewerAgentId} (agents.list[].responseReviewer=off)`,
          );
        } else
          try {
            const verdict = await callReviewer({
              agentId: reviewerAgentId,
              isChannelRoot: !threadTs,
              draftReply,
              toolCallNames,
            });
            params.runtime.log?.(
              `[claw-debug] reviewer: verdict=${verdict.verdict} reason="${verdict.reason}" ${verdict.durationMs}ms${verdict.fellBack ? " (fallback)" : ""}`,
            );
            if (verdict.verdict === "reject") {
              recordReviewerReject({
                ts: new Date().toISOString(),
                agentId: reviewerAgentId,
                draftReply,
                reason: verdict.reason,
                durationMs: verdict.durationMs,
              });
              const footer = `\n\n_⚠️ reviewer: ${verdict.reason.slice(0, 200)}_`;
              const mut = payload as { text?: string };
              if (typeof mut.text === "string" && mut.text) {
                mut.text = `${mut.text}${footer}`;
              } else {
                mut.text = `${draftReply}${footer}`;
              }
              // Re-resolve so reply.trimmedText / hasContent reflect the
              // footer-suffixed body for the downstream send branches.
              reply = resolveSendableOutboundReplyParts(payload);
              params.runtime.log?.(
                `[claw-debug] reviewer: appended reject footer (${verdict.reason.slice(0, 60)}) — proceeding with send`,
              );
            }
          } catch {
            // Reviewer threw outside its own fail-safe (shouldn't happen) —
            // proceed with normal send to avoid blocking on a broken side-channel.
            params.runtime.log?.("[claw-debug] reviewer: unexpected throw; proceeding with send");
          }
      }
    }

    if (!reply.hasContent && !slackBlocks?.length) {
      continue;
    }

    if (!reply.hasMedia && slackBlocks?.length) {
      const trimmed = reply.trimmedText;
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      await sendMessageSlack(params.target, trimmed, {
        cfg: params.cfg,
        token: params.token,
        threadTs,
        accountId: params.accountId,
        ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      });
      params.runtime.log?.(`delivered reply to ${params.target}`);
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
          ...(params.metadata ? { metadata: params.metadata } : {}),
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
          ...(params.metadata ? { metadata: params.metadata } : {}),
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
  blocks?: ReturnType<typeof readSlackReplyBlocks>;
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
  const messages: Array<{ text: string; blocks?: ReturnType<typeof readSlackReplyBlocks> }> = [];
  const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
  for (const payload of params.replies) {
    if (payload.isReasoning === true) {
      continue;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);
    const text =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    if (slackBlocks?.length && !reply.hasMedia) {
      messages.push({ text: text ?? "", blocks: slackBlocks });
      continue;
    }
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
      messages.push({ text: chunk });
    }
  }

  if (messages.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const message of messages) {
    await params.respond({ ...message, response_type: responseType });
  }
}
