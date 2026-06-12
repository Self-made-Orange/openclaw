/**
 * CLAW-FORK 2026-05-09: extract `<openclaw-interactive>` fence from text
 *
 * The auto-reply path (src/auto-reply/reply/reply-delivery.ts) already strips
 * this fence before the slack adapter's normalizePayload runs. The cron
 * announce path (src/cron/isolated-agent/delivery-dispatch.ts) does NOT — it
 * passes the agent's raw text straight to deliverOutboundPayloads, so the
 * JSON gets dumped to the Slack channel as plain mrkdwn (broken UX).
 *
 * Putting fence extraction inside the slack-channel adapter (compile pass)
 * covers BOTH paths uniformly: reply path becomes a no-op (text already
 * stripped), cron path gets blocks lifted + text emptied.
 *
 * The parser only handles RAW Slack Block Kit (`{ "blocks": [...] }`). Abstract
 * fence blocks (the openclaw-interactive abstract schema with `{ type: "..." }`
 * envelopes) stay handled in reply-delivery.ts so we don't duplicate the
 * abstract validator across packages.
 */

const INTERACTIVE_FENCE_RE = /```openclaw-interactive\s*\n([\s\S]*?)```/g;
const JSON_INTERACTIVE_FENCE_RE = /```json\s*\n([\s\S]*?)```/g;

export interface FenceExtractionResult {
  text: string;
  rawBlocks: unknown[];
}

export function extractClawInteractiveFence(text: string): FenceExtractionResult {
  if (!text) {
    return { text, rawBlocks: [] };
  }
  const hasOpenclawFence = text.includes("```openclaw-");
  const hasJsonFallback = /"type"\s*:\s*"openclaw-interactive"/i.test(text);
  if (!hasOpenclawFence && !hasJsonFallback) {
    return { text, rawBlocks: [] };
  }

  let stripped = text;
  let rawBlocks: unknown[] = [];

  const collectFromParsed = (parsed: unknown): unknown[] => {
    if (!parsed || typeof parsed !== "object") return [];
    const obj = parsed as Record<string, unknown>;
    const blocks = obj.blocks;
    if (!Array.isArray(blocks)) return [];
    // Only treat as RAW Slack blocks if at least one block looks like a real
    // Slack block (has a `type` string and isn't an abstract fence envelope).
    const looksRaw = blocks.some(
      (b) =>
        b !== null && typeof b === "object" && typeof (b as { type?: unknown }).type === "string",
    );
    return looksRaw ? blocks : [];
  };

  stripped = stripped.replace(INTERACTIVE_FENCE_RE, (match, body: string) => {
    try {
      rawBlocks = rawBlocks.concat(collectFromParsed(JSON.parse(body)));
      return "";
    } catch {
      return match;
    }
  });

  if (hasJsonFallback) {
    stripped = stripped.replace(JSON_INTERACTIVE_FENCE_RE, (match, body: string) => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed && parsed.type === "openclaw-interactive") {
          rawBlocks = rawBlocks.concat(collectFromParsed(parsed));
          return "";
        }
      } catch {
        // ignore
      }
      return match;
    });
  }

  return {
    text: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    rawBlocks,
  };
}
