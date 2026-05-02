import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDurableFact,
  appendUserPreference,
  readDurableFacts,
  readUserPreferences,
} from "./markdown-store.js";

describe("markdown-store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "openclaw-mem-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends a user preference bullet", async () => {
    await appendUserPreference(
      dir,
      { text: "prefers terse answers", sessionId: "s-1", ts: "2026-05-02T00:00:00Z" },
      { piiScrub: false },
    );
    const content = await readUserPreferences(dir);
    expect(content).toBe("- 2026-05-02T00:00:00Z | s-1 | prefers terse answers\n");
  });

  it("appends multiple bullets without losing earlier ones", async () => {
    await appendDurableFact(
      dir,
      { text: "vault is at /home/.../vault", sessionId: "s-1", ts: "2026-05-02T00:00:00Z" },
      { piiScrub: false },
    );
    await appendDurableFact(
      dir,
      { text: "bot uses kimi-k2.6 primary", sessionId: "s-2", ts: "2026-05-02T00:01:00Z" },
      { piiScrub: false },
    );
    const content = await readDurableFacts(dir);
    expect(content.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("scrubs bearer tokens before persisting (always-on)", async () => {
    await appendUserPreference(
      dir,
      {
        text: "uses Slack token xoxb-1234567890-abcdefghij in agent config",
        sessionId: "s-1",
        ts: "2026-05-02T00:00:00Z",
      },
      { piiScrub: false },
    );
    const content = await readUserPreferences(dir);
    expect(content).toContain("[REDACTED-TOKEN]");
    expect(content).not.toContain("xoxb-1234567890");
  });

  it("normalizes newlines in entry text into one bullet line", async () => {
    await appendDurableFact(
      dir,
      { text: "line one\nline two", sessionId: "s-1", ts: "2026-05-02T00:00:00Z" },
      { piiScrub: false },
    );
    const content = await readDurableFacts(dir);
    expect(content.match(/\n/g)?.length).toBe(1); // only the trailing newline
  });

  it("returns empty string for missing files", async () => {
    expect(await readUserPreferences(dir)).toBe("");
    expect(await readDurableFacts(dir)).toBe("");
  });
});
