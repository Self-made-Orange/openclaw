import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { registerSlackReadChannelTool } from "./read-channel-tool.js";

/**
 * Register all Slack-side bundle MCP tools (`mcp__openclaw__slack_*`).
 *
 * Currently:
 *   - `slack_read_channel` — read channel history / thread replies via the
 *     bot's own xoxb token (works across workspaces; complements
 *     `mcp__claude_ai_Slack__*` connector that is bound to a single
 *     OAuth-ed workspace).
 */
export function registerSlackTools(api: OpenClawPluginApi): void {
  registerSlackReadChannelTool(api);
}
