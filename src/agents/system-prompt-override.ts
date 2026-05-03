import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentConfig } from "./agent-scope.js";

const log = createSubsystemLogger("system-prompt-override");

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// CLAW-FORK 2026-05-03 (Phase 1, multi-agent design):
// Allow systemPromptOverride to point to a markdown file via the prefix
// `<file:...>` (or `file:...`). Tilde (`~/`) is expanded. The file is
// read synchronously and the contents replace the directive. Cached by
// (path + mtimeMs) so changes are picked up on file-write without a restart,
// but unchanged paths skip disk I/O. Falls back to the original string if
// the file is missing/unreadable so misconfig doesn't blank the prompt.
type CacheEntry = { mtimeMs: number; content: string };
const fileCache = new Map<string, CacheEntry>();

function expandTilde(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function tryResolveFileDirective(value: string): string | undefined {
  // Match `<file:...>` (preferred — distinct from prose) or bare `file:...`.
  const angle = value.match(/^<file:([^>]+)>$/);
  const bare = !angle && value.startsWith("file:") ? value.slice(5) : undefined;
  const raw = angle ? angle[1] : bare;
  if (!raw) return undefined;
  const filePath = path.resolve(expandTilde(raw.trim()));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    log.warn(`systemPromptOverride file not found, falling back to raw value: ${filePath}`, {
      err: String(err),
    });
    return undefined;
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (content.length === 0) {
      log.warn(`systemPromptOverride file is empty: ${filePath}`);
      return undefined;
    }
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
    log.debug(`systemPromptOverride loaded from file (${content.length} chars): ${filePath}`);
    return content;
  } catch (err) {
    log.warn(`systemPromptOverride read failed: ${filePath}`, { err: String(err) });
    return undefined;
  }
}

function materializeOverride(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const fileResolved = tryResolveFileDirective(value);
  return fileResolved ?? value;
}

export function resolveSystemPromptOverride(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): string | undefined {
  const config = params.config;
  if (!config) {
    return undefined;
  }
  const agentOverride = trimNonEmpty(
    params.agentId ? resolveAgentConfig(config, params.agentId)?.systemPromptOverride : undefined,
  );
  if (agentOverride) {
    return materializeOverride(agentOverride);
  }
  return materializeOverride(trimNonEmpty(config.agents?.defaults?.systemPromptOverride));
}
