/**
 * Append-only writers for `user.md` (observed user preferences) and
 * `memory.md` (durable facts) under `~/.openclaw/memory/<agentId>/`.
 *
 * Both files use a flat bullet-list format with timestamps and source session
 * ids so they remain hand-readable / editable. No rotation — files are bounded
 * by usage volume per Phase 0 Decision 1.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { scrubForPersistence } from "./redact.js";

export interface MarkdownEntry {
  text: string;
  sessionId: string;
  /** ISO 8601 UTC. Defaults to now. */
  ts?: string;
}

export interface AppendOptions {
  /** Whether the agent has opted in to PII scrub. Bearer scrub always runs. */
  piiScrub: boolean;
}

function formatBullet(entry: MarkdownEntry, scrubbedText: string): string {
  const ts = entry.ts ?? new Date().toISOString();
  return `- ${ts} | ${entry.sessionId} | ${scrubbedText.replace(/\n/g, " ").trim()}\n`;
}

async function appendBullet(
  path: string,
  entry: MarkdownEntry,
  opts: AppendOptions,
): Promise<{ bearerHits: number; piiHits: number }> {
  const scrub = scrubForPersistence(entry.text, { pii: opts.piiScrub });
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, formatBullet(entry, scrub.text), "utf8");
  return { bearerHits: scrub.bearerHits, piiHits: scrub.piiHits };
}

export function appendUserPreference(
  agentMemoryDir: string,
  entry: MarkdownEntry,
  opts: AppendOptions,
): Promise<{ bearerHits: number; piiHits: number }> {
  return appendBullet(`${agentMemoryDir}/user.md`, entry, opts);
}

export function appendDurableFact(
  agentMemoryDir: string,
  entry: MarkdownEntry,
  opts: AppendOptions,
): Promise<{ bearerHits: number; piiHits: number }> {
  return appendBullet(`${agentMemoryDir}/memory.md`, entry, opts);
}

/** Returns the full file content or empty string if the file is missing. */
export async function readUserPreferences(agentMemoryDir: string): Promise<string> {
  try {
    return await readFile(`${agentMemoryDir}/user.md`, "utf8");
  } catch {
    return "";
  }
}

export async function readDurableFacts(agentMemoryDir: string): Promise<string> {
  try {
    return await readFile(`${agentMemoryDir}/memory.md`, "utf8");
  } catch {
    return "";
  }
}
