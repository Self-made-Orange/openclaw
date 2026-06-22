/**
 * CLAW-FORK 2026-06-13 (MED-5): single source of truth for the
 * `openclaw-interactive` fence regexes.
 *
 * Previously two parsers carried slightly different copies:
 *   - src/auto-reply/reply/reply-delivery.ts (reply path)
 *   - extensions/slack/src/extract-claw-fence.ts (cron announce path)
 * The closing-fence newline handling differed (the slack copy used a loose
 * `([\s\S]*?)```` close with no required `\n`, and lacked the `openclaw-blocks`
 * alias / case-insensitive flag), so the same agent text could parse
 * differently depending on which path delivered it.
 *
 * Both paths now import these helpers. We standardise on the STRICTER form:
 * a newline is required immediately before the closing ``` fence.
 *
 * The returned RegExp objects carry the global flag and are therefore stateful
 * (they track `lastIndex`). Each call returns a FRESH instance so callers never
 * share `lastIndex` across concurrent uses.
 */

/** Matches ```openclaw-interactive | ```openclaw-blocks fenced JSON bodies. */
export function getInteractiveFenceRe(): RegExp {
  return /```openclaw-(?:interactive|blocks)\s*\n([\s\S]*?)\n```\s*/gi;
}

/**
 * Fallback: rescue dispatch-output payloads emitted inside a plain `json`
 * (or untyped / js) fence that carry the `"type":"openclaw-interactive"`
 * signature instead of the dedicated fence tag.
 */
export function getJsonInteractiveFenceRe(): RegExp {
  return /```(?:json|jsonc|javascript|js)?\s*\n(\{[\s\S]*?"type"\s*:\s*"openclaw-interactive"[\s\S]*?\})\s*\n```\s*/gi;
}

/**
 * CLAW-FORK 2026-06-21: lenient rescue. Agents repeatedly emit Slack Block Kit
 * as a plain ```json fence (or untyped fence) containing either
 *   { "blocks": [ ... ] }   or   [ {type:...}, {type:...} ]   (bare array)
 * instead of the dedicated ```openclaw-interactive fence. The cron announce
 * path then leaks raw JSON as code text (no render). This regex captures those
 * two shapes so the parser can validate the body as real Slack blocks and
 * convert. Validation (every element has a known Slack block `type`) happens in
 * the parser to keep false positives low — a JSON code *example* that isn't a
 * blocks list won't match the type check and is left as-is.
 */
export function getJsonBlockKitFenceRe(): RegExp {
  return /```(?:json|jsonc|javascript|js)?\s*\n(\{\s*"blocks"\s*:\s*\[[\s\S]*?\]\s*\}|\[\s*\{[\s\S]*?\}\s*\])\s*\n```\s*/gi;
}
