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
