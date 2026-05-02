/**
 * Bearer-token redaction. Always-on per Phase 0 Decision 1: leaking a token
 * has unbounded blast radius and the recall cost is near zero (tokens are
 * noise, not signal).
 *
 * The set below covers the bearer formats most likely to appear in pattern
 * transcripts. Patterns scrub before any persistence call.
 */
const BEARER_PATTERNS: ReadonlyArray<RegExp> = [
  /xox[bp]-[A-Za-z0-9-]{10,}/g, // Slack bot/user tokens
  /xapp-[0-9A-Za-z-]{10,}/g, // Slack app-level tokens
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI/Anthropic style
  /ghp_[A-Za-z0-9]{30,}/g, // GitHub personal access tokens
  /ghs_[A-Za-z0-9]{30,}/g, // GitHub server tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ntn_[A-Za-z0-9]{30,}/g, // Notion integration tokens
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PATs
];

const REDACTED_PLACEHOLDER = "[REDACTED-TOKEN]";

/**
 * Replace bearer tokens with a fixed placeholder. Returns the redacted string
 * and the count of redactions performed (useful for audit logging).
 */
export function redactBearerTokens(input: string): { text: string; count: number } {
  let count = 0;
  let text = input;
  for (const pattern of BEARER_PATTERNS) {
    text = text.replace(pattern, () => {
      count += 1;
      return REDACTED_PLACEHOLDER;
    });
  }
  return { text, count };
}

/**
 * PII patterns. Off by default per Phase 0 Decision 1; opt-in via
 * `memory.redactPII: true` in agent config.
 */
const PII_PATTERNS: ReadonlyArray<RegExp> = [
  // Email
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Phone (E.164 + common locale)
  /\+?[1-9]\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
];

const REDACTED_PII = "[REDACTED-PII]";

export function redactPII(input: string): { text: string; count: number } {
  let count = 0;
  let text = input;
  for (const pattern of PII_PATTERNS) {
    text = text.replace(pattern, () => {
      count += 1;
      return REDACTED_PII;
    });
  }
  // Luhn-validated credit-card pass (separate because rejection requires logic).
  text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnValid(digits)) return match;
    count += 1;
    return REDACTED_PII;
  });
  return { text, count };
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Composed scrub used by the persistence layer. Bearer pass always runs;
 * PII pass runs only when the agent has opted in.
 */
export function scrubForPersistence(
  input: string,
  opts: { pii: boolean },
): { text: string; bearerHits: number; piiHits: number } {
  const bearer = redactBearerTokens(input);
  if (!opts.pii) {
    return { text: bearer.text, bearerHits: bearer.count, piiHits: 0 };
  }
  const pii = redactPII(bearer.text);
  return { text: pii.text, bearerHits: bearer.count, piiHits: pii.count };
}
