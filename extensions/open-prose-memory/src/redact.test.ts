import { describe, expect, it } from "vitest";
import { redactBearerTokens, redactPII, scrubForPersistence } from "./redact.js";

describe("redactBearerTokens", () => {
  it("scrubs Slack bot tokens", () => {
    const result = redactBearerTokens("token=xoxb-1234567890-abcdefghij rest of line");
    expect(result.text).toBe("token=[REDACTED-TOKEN] rest of line");
    expect(result.count).toBe(1);
  });

  it("scrubs OpenAI/Anthropic-style sk- tokens", () => {
    const result = redactBearerTokens(
      "Authorization: Bearer sk-abcdef0123456789ABCDEF0123456789xyz",
    );
    expect(result.text).toContain("[REDACTED-TOKEN]");
    expect(result.count).toBe(1);
  });

  it("scrubs GitHub PATs", () => {
    const result = redactBearerTokens("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result.text).toBe("[REDACTED-TOKEN]");
    expect(result.count).toBe(1);
  });

  it("scrubs Notion integration tokens", () => {
    const result = redactBearerTokens("ntn_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result.text).toBe("[REDACTED-TOKEN]");
    expect(result.count).toBe(1);
  });

  it("counts multiple hits in one pass", () => {
    const result = redactBearerTokens(
      "first xoxb-111-aaaaaaaaaa second xoxb-222-bbbbbbbbbb third xoxb-333-cccccccccc",
    );
    expect(result.count).toBe(3);
  });

  it("leaves non-token strings untouched", () => {
    const result = redactBearerTokens("just a regular sentence about sk things");
    expect(result.text).toBe("just a regular sentence about sk things");
    expect(result.count).toBe(0);
  });
});

describe("redactPII", () => {
  it("scrubs emails", () => {
    const result = redactPII("contact me at jane@example.com please");
    expect(result.text).toBe("contact me at [REDACTED-PII] please");
    expect(result.count).toBe(1);
  });

  it("scrubs E.164 phones", () => {
    const result = redactPII("+12025550123 is the number");
    expect(result.text).toContain("[REDACTED-PII]");
  });

  it("scrubs Luhn-valid credit cards", () => {
    // 4111-1111-1111-1111 is the canonical Luhn-valid test number.
    const result = redactPII("card: 4111 1111 1111 1111 expires next month");
    expect(result.text).toContain("[REDACTED-PII]");
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  // Note: 16-digit space-grouped sequences match the phone regex too, so they
  // will be scrubbed regardless of CC Luhn validity. Tighter phone regex (or
  // context-aware prefix) is a follow-up; for the Phase 1 scaffold the broad
  // false-positive is preferred over leaking a real CC.
  it("scrubs 16-digit space-grouped sequences via phone OR cc match", () => {
    const result = redactPII("order id: 1234 5678 9012 3456 placed today");
    expect(result.text).toContain("[REDACTED-PII]");
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("leaves short numeric ids untouched", () => {
    const result = redactPII("ticket #4421 status open");
    expect(result.text).toBe("ticket #4421 status open");
    expect(result.count).toBe(0);
  });
});

describe("scrubForPersistence", () => {
  it("always scrubs bearer tokens regardless of pii flag", () => {
    const off = scrubForPersistence("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", {
      pii: false,
    });
    expect(off.text).toContain("[REDACTED-TOKEN]");
    expect(off.bearerHits).toBe(1);
    expect(off.piiHits).toBe(0);
  });

  it("only scrubs PII when pii=true", () => {
    const input = "email jane@example.com and ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const off = scrubForPersistence(input, { pii: false });
    expect(off.text).toContain("jane@example.com");
    expect(off.text).toContain("[REDACTED-TOKEN]");
    expect(off.piiHits).toBe(0);

    const on = scrubForPersistence(input, { pii: true });
    expect(on.text).toContain("[REDACTED-PII]");
    expect(on.text).toContain("[REDACTED-TOKEN]");
    expect(on.piiHits).toBe(1);
    expect(on.bearerHits).toBe(1);
  });
});
