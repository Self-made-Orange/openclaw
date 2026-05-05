/**
 * MCP tool: slack_read_channel
 *
 * Exposes Slack channel history (or thread replies) to bot sessions via the
 * fork's bundle MCP loopback. The tool resolves the requesting bot's account
 * from the channel id, then issues `conversations.history` /
 * `conversations.replies` using that account's `xoxb` token.
 *
 * Use case: cross-workspace bots (e.g. data-lime in a Slack workspace
 * different from the user's claude.ai OAuth) need to read their own
 * channel context. The `mcp__claude_ai_Slack__*` connector cannot reach
 * other workspaces, but the bot already has its own OAuth scope
 * (`channels:history`).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { Type, type Static } from "typebox";
import { listSlackAccountIds, mergeSlackAccountConfig } from "../accounts.js";
import { readSlackMessages } from "../actions.js";

export const SlackReadChannelSchema = Type.Object({
  channelId: Type.String({
    description: "Slack channel id (e.g. C0B2G12RCUQ).",
  }),
  threadTs: Type.Optional(
    Type.String({
      description:
        "Optional thread timestamp. When set, returns replies in that thread; otherwise returns recent channel messages.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: "Max messages to return (1-100, default 30).",
    }),
  ),
  oldest: Type.Optional(
    Type.String({
      description: "Optional Slack ts to filter messages newer than this.",
    }),
  ),
  latest: Type.Optional(
    Type.String({
      description: "Optional Slack ts to filter messages older than this.",
    }),
  ),
});

export type SlackReadChannelParams = Static<typeof SlackReadChannelSchema>;

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerSlackReadChannelTool(api: OpenClawPluginApi): void {
  if (!api.config) {
    api.logger.debug?.("[slack-tools] no config available, skipping read-channel tool");
    return;
  }
  const accountIds = listSlackAccountIds(api.config);
  if (accountIds.length === 0) {
    api.logger.debug?.("[slack-tools] no slack accounts, skipping read-channel tool");
    return;
  }

  api.registerTool(
    {
      name: "slack_read_channel",
      label: "Slack Read Channel",
      description:
        "Read recent Slack channel history (or replies in a specific thread) using the bot's own xoxb token. " +
        "Use when the bot needs context from its own workspace that is not already injected by threadInheritParent " +
        "(e.g. messages from other threads, channel root posts by other bots, historical discussion). " +
        "Returns up to `limit` messages (default 30) for the given channelId.",
      parameters: SlackReadChannelSchema,
      async execute(_toolCallId, params) {
        try {
          const p = params as SlackReadChannelParams;
          let resolvedAccountId: string | undefined;
          for (const accountId of accountIds) {
            const merged = mergeSlackAccountConfig(api.config!, accountId);
            const channels = merged.channels ?? {};
            if (channels[p.channelId]) {
              resolvedAccountId = accountId;
              break;
            }
          }
          if (!resolvedAccountId) {
            return jsonResult({
              error:
                "No Slack account in this gateway has the requested channelId in its channels config. " +
                `channelId=${p.channelId}.`,
            });
          }
          const result = await readSlackMessages(p.channelId, {
            cfg: api.config,
            accountId: resolvedAccountId,
            limit: p.limit ?? 30,
            threadId: p.threadTs,
            before: p.latest,
            after: p.oldest,
          });
          return jsonResult({
            accountId: resolvedAccountId,
            channelId: p.channelId,
            threadTs: p.threadTs,
            messages: result.messages,
            hasMore: result.hasMore,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ error: message });
        }
      },
    },
    { name: "slack_read_channel" },
  );

  api.logger.debug?.("[slack-tools] registered slack_read_channel tool");
}
