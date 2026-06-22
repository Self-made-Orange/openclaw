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

// CLAW-FORK 2026-06-13 (MED-5): fence regexes are now imported from the shared
// core module (single source of truth) so this cron-announce parser and the
// reply path (src/auto-reply/reply/reply-delivery.ts) can no longer diverge on
// closing-fence handling. Previously this file used a looser close
// (`([\s\S]*?)```` with no required newline, no `openclaw-blocks` alias,
// case-sensitive); we now share the stricter `\n```` form.
import {
  getAngleInteractiveRe,
  getInteractiveFenceRe,
  getJsonBlockKitFenceRe,
  getJsonInteractiveFenceRe,
} from "openclaw/plugin-sdk/interactive-fence";

// CLAW-FORK 2026-06-22: angle-bracket fence body 파서 (관대).
function parseLenientBlockKitBody(body: string): unknown[] {
  const grab = (parsed: unknown): unknown[] =>
    Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { blocks?: unknown })?.blocks)
        ? (parsed as { blocks: unknown[] }).blocks
        : [];
  const trimmed = (body || "").trim();
  try {
    return grab(JSON.parse(trimmed));
  } catch {
    const so = trimmed.indexOf("{");
    const sa = trimmed.indexOf("[");
    const start = sa !== -1 && (so === -1 || sa < so) ? sa : so;
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      try {
        return grab(JSON.parse(trimmed.slice(start, end + 1)));
      } catch {
        return [];
      }
    }
    return [];
  }
}

// CLAW-FORK 2026-06-21: 알려진 Slack block type — lenient rescue 검증용.
const KNOWN_SLACK_BLOCK_TYPES = new Set([
  "section",
  "header",
  "divider",
  "context",
  "actions",
  "image",
  "input",
  "table",
  "rich_text",
  "video",
  "file",
  "call",
]);
function looksLikeSlackBlocks(blocks: unknown[]): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.every(
    (b) =>
      b !== null &&
      typeof b === "object" &&
      typeof (b as { type?: unknown }).type === "string" &&
      KNOWN_SLACK_BLOCK_TYPES.has((b as { type: string }).type),
  );
}

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
  // CLAW-FORK 2026-06-21: lenient — ```json fence with a Slack blocks shape.
  const hasBlockKitFallback =
    text.includes("```") &&
    /"blocks"\s*:|"type"\s*:\s*"(section|header|divider|context|actions|table|rich_text|image)"/.test(
      text,
    );
  const hasAngleInteractive = /<openclaw-(?:interactive|blocks)>/i.test(text);
  if (!hasOpenclawFence && !hasJsonFallback && !hasBlockKitFallback && !hasAngleInteractive) {
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

  stripped = stripped.replace(getInteractiveFenceRe(), (match, body: string) => {
    try {
      rawBlocks = rawBlocks.concat(collectFromParsed(JSON.parse(body)));
      return "";
    } catch {
      return match;
    }
  });

  if (hasJsonFallback) {
    stripped = stripped.replace(getJsonInteractiveFenceRe(), (match, body: string) => {
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

  // CLAW-FORK 2026-06-21: lenient Block Kit rescue (cron announce path).
  // ```json {"blocks":[...]} 또는 bare [block,...] 을 검증 후 변환. 코드 예시
  // (blocks 아님) 는 looksLikeSlackBlocks 실패로 그대로 둔다.
  if (hasBlockKitFallback) {
    stripped = stripped.replace(getJsonBlockKitFenceRe(), (match, body: string) => {
      try {
        const parsed = JSON.parse(body) as unknown;
        const blocks = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { blocks?: unknown })?.blocks)
            ? (parsed as { blocks: unknown[] }).blocks
            : [];
        if (!looksLikeSlackBlocks(blocks)) return match;
        rawBlocks = rawBlocks.concat(blocks);
        return "";
      } catch {
        return match;
      }
    });
  }

  // CLAW-FORK 2026-06-22: angle-bracket fence `<openclaw-interactive>{json}</…>`.
  if (hasAngleInteractive) {
    stripped = stripped.replace(getAngleInteractiveRe(), (match, body: string) => {
      const blocks = parseLenientBlockKitBody(body);
      if (!looksLikeSlackBlocks(blocks)) return match;
      rawBlocks = rawBlocks.concat(blocks);
      return "";
    });
  }

  return {
    text: stripped.replace(/\n{3,}/g, "\n\n").trim(),
    rawBlocks,
  };
}
