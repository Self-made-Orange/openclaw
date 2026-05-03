// CLAW-FORK 2026-05-03 (Phase 6 D2-D3, multi-agent design):
// Reviewer agent caller. Cheap LLM (Moonshot Kimi K2.6 via direct fetch)
// inspects each draft outbound reply against the universal Discipline rules
// before send. Returns {verdict, reason}.
//
// Why direct fetch (instead of fork's spawn or claude-cli subprocess):
// - spawnSubagentDirect: result is async-via-inbox, dispatcher can't easily
//   block on it.
// - claude-cli subprocess: --bare requires ANTHROPIC_API_KEY; without --bare
//   it loads vault context / MCP / hooks → too heavy + ignores classifier prompt.
// - Direct Moonshot fetch (OpenAI-compatible): ~500ms one-shot, MOONSHOT_API_KEY
//   already present at ~/.openclaw/.env. Trivial to swap to a different
//   provider later by changing endpoint+model.
//
// Fail-safe: any error / timeout / parse failure → approve (do NOT block
// the user-visible reply on a side-channel quality check).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

const log = {
  debug: (msg: string) => logVerbose(`[reviewer] ${msg}`),
  warn: (msg: string) => logVerbose(`[reviewer] WARN ${msg}`),
};

const REVIEWER_TIMEOUT_MS = 8_000;
const MOONSHOT_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";
// Moonshot's public API only accepts `moonshot-v1-*` model names — the
// `kimi-k2*` aliases that the fork uses internally are translated by fork's
// provider routing (which we bypass with this direct fetch). 8k context is
// plenty for the verdict task.
const MOONSHOT_MODEL = "moonshot-v1-8k";

export type ReviewerVerdict = {
  verdict: "approve" | "reject";
  reason: string;
  /** Total reviewer call latency in ms. */
  durationMs: number;
  /** Whether the reviewer fell back to "approve" due to error/timeout/parse-fail. */
  fellBack: boolean;
  /** Raw text from the LLM, for debugging. */
  raw?: string;
};

export type ReviewerCallParams = {
  agentId?: string;
  isChannelRoot: boolean;
  draftReply: string;
  toolCallNames?: string[];
};

let cachedApiKey: string | undefined | null;

function readEnvFileLine(envPath: string, key: string): string | undefined {
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      if (k !== key) continue;
      let v = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes if present.
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function resolveMoonshotApiKey(): string | undefined {
  if (cachedApiKey !== undefined) return cachedApiKey ?? undefined;
  const envKey = process.env.MOONSHOT_API_KEY?.trim();
  if (envKey) {
    cachedApiKey = envKey;
    return envKey;
  }
  // Fork-side fallback: ~/.openclaw/.env (loaded by fork bootstrap normally,
  // but reviewer-call.ts may be reached before that load completes during
  // restart). Read once, cache.
  const home = process.env.HOME ?? os.homedir();
  const envFile = path.join(home, ".openclaw", ".env");
  const fileKey = readEnvFileLine(envFile, "MOONSHOT_API_KEY");
  if (fileKey) {
    cachedApiKey = fileKey;
    return fileKey;
  }
  cachedApiKey = null;
  return undefined;
}

function buildUserPrompt(params: ReviewerCallParams): string {
  const tools = params.toolCallNames?.length ? params.toolCallNames.join(", ") : "(none)";
  return `=== AGENT ===
agentId: ${params.agentId ?? "unknown"}
isChannelRoot: ${params.isChannelRoot}
=== DRAFT REPLY ===
${params.draftReply}
=== TOOL CALLS THIS TURN ===
${tools}
=== END ===`;
}

function loadReviewerSystemPrompt(): string | undefined {
  const home = process.env.HOME ?? os.homedir();
  const filePath = path.join(home, ".openclaw", "agents", "reviewer", "SYSTEM.md");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function approveFallback(durationMs: number, reason: string, raw?: string): ReviewerVerdict {
  return {
    verdict: "approve",
    reason,
    durationMs,
    fellBack: true,
    raw,
  };
}

function tryParseVerdict(raw: string): { verdict: "approve" | "reject"; reason: string } | null {
  // Tolerate code-block wrapping the model loves to add.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // Find first { ... } JSON object.
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
    const verdictRaw = typeof parsed.verdict === "string" ? parsed.verdict.toLowerCase() : "";
    const verdict =
      verdictRaw === "approve" ? "approve" : verdictRaw === "reject" ? "reject" : null;
    if (!verdict) return null;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    return { verdict, reason };
  } catch {
    return null;
  }
}

export async function callReviewer(params: ReviewerCallParams): Promise<ReviewerVerdict> {
  const start = Date.now();
  const apiKey = resolveMoonshotApiKey();
  if (!apiKey) {
    log.debug("MOONSHOT_API_KEY missing — reviewer skipped (auto-approve)");
    return approveFallback(0, "no-api-key");
  }
  const systemPrompt = loadReviewerSystemPrompt();
  if (!systemPrompt) {
    log.debug("reviewer SYSTEM.md missing — reviewer skipped (auto-approve)");
    return approveFallback(Date.now() - start, "no-system-prompt");
  }
  const userPrompt = buildUserPrompt(params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEWER_TIMEOUT_MS);
  try {
    const resp = await fetch(MOONSHOT_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MOONSHOT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.0,
        max_tokens: 200,
      }),
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log.warn(`reviewer HTTP ${resp.status}; auto-approve. body=${body.slice(0, 200)}`);
      return approveFallback(Date.now() - start, `http-${resp.status}`);
    }
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      log.warn("reviewer returned empty content; auto-approve");
      return approveFallback(Date.now() - start, "empty-content");
    }
    const parsed = tryParseVerdict(text);
    if (!parsed) {
      log.warn(`reviewer JSON parse failed; auto-approve. raw=${text.slice(0, 200)}`);
      return approveFallback(Date.now() - start, "parse-fail", text);
    }
    return {
      verdict: parsed.verdict,
      reason: parsed.reason || "(no reason given)",
      durationMs: Date.now() - start,
      fellBack: false,
      raw: text,
    };
  } catch (err) {
    clearTimeout(timer);
    log.warn(`reviewer call failed; auto-approve. err=${String(err)}`);
    return approveFallback(Date.now() - start, `error: ${String(err).slice(0, 100)}`);
  }
}
