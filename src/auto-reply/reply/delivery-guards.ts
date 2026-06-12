/** CLAW-FORK delivery guards: hallucinated-file detector + media format-guard. */
import fs from "node:fs";
import path from "node:path";

// CLAW-FORK: hallucinated-file detector + auto-attach.
//
// Symptom we're addressing (observed 2026-04-26): Kimi K2.6 occasionally writes
// "📁 output/foo.html" or ":file_folder: output/bar.html" into the response body
// or Block Kit context elements, **without** actually calling the Write tool.
// User sees a "file" reference but there's nothing to click — also no permalink,
// no action button. The 3-step rule in AGENTS.md §"Query Response Flow" #6
// covers it on the prompt side, but compliance is non-deterministic.
//
// What this guard does (deterministic):
//   1. Scan response text + Block Kit string fields for `output/<file>.<ext>`
//      patterns (html/pdf/png/jpg/jpeg/svg/md, plus emoji-code prefixes like
//      `:file_folder:` / `📁 ` / `MEDIA:` not yet stripped).
//   2. Resolve each candidate against vault root (cwd parent) and cwd.
//   3. If file exists and isn't already in `mediaUrls` → add it. The downstream
//      normalizeMediaPaths picks it up and uploads, restoring the file +
//      action-button experience even when the model skipped the MEDIA directive.
//   4. If file is missing → log a warning (`hallucinated-output-path`). Don't
//      mutate text/blocks here to avoid shape corruption; the prompt rule plus
//      logging is enough to spot the issue.

const HALLUCINATION_PATH_RE =
  /(?:📁|:file_folder:|:paperclip:|📎|MEDIA:|^|\s|>)\s*((?:\.\.\/)?(?:output|\.\.\/output)\/[^\s'"<>`)\]]+\.(?:html|pdf|png|jpg|jpeg|svg|md))/gim;

function collectStringsFromBlocks(blocks: unknown[], out: string[]): void {
  for (const block of blocks) {
    if (typeof block === "string") {
      out.push(block);
    } else if (block && typeof block === "object") {
      for (const value of Object.values(block as Record<string, unknown>)) {
        if (typeof value === "string") {
          out.push(value);
        } else if (Array.isArray(value)) {
          collectStringsFromBlocks(value, out);
        } else if (value && typeof value === "object") {
          collectStringsFromBlocks([value], out);
        }
      }
    }
  }
}

function resolveOutputCandidate(candidate: string): string | undefined {
  const cleaned = candidate.trim().replace(/^\.\.\//, "");
  if (!cleaned) return undefined;
  const cwd = process.cwd();
  // CLAW-FORK: agents resolve `output/...` relative to their workspace dir
  // (~/openclaw-ws/output/...), not cwd. Add that to candidates so the
  // hallucination-guard doesn't drop renderer output. CLAW_AGENT_WORKSPACE
  // env can override.
  const workspace =
    process.env.CLAW_AGENT_WORKSPACE ||
    (process.env.HOME ? path.resolve(process.env.HOME, "openclaw-ws") : "");
  const candidates = [
    path.resolve(cwd, "..", cleaned),
    path.resolve(cwd, cleaned),
    path.resolve(cwd, "..", "..", cleaned),
    ...(workspace ? [path.resolve(workspace, cleaned)] : []),
  ];
  for (const abs of candidates) {
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return abs;
      }
    } catch {
      // ignore stat errors and try next candidate
    }
  }
  return undefined;
}

export function detectHallucinatedFiles(params: {
  text?: string;
  blocks?: unknown[];
  existingMediaUrls?: string[];
}): { autoAttach: string[]; missing: string[] } {
  const sources: string[] = [];
  if (params.text) sources.push(params.text);
  if (params.blocks?.length) collectStringsFromBlocks(params.blocks, sources);
  const seen = new Set<string>();
  const autoAttach: string[] = [];
  const missing: string[] = [];
  const existing = new Set((params.existingMediaUrls ?? []).map((u) => u.trim()));
  for (const src of sources) {
    if (!src.includes("output/") && !src.includes("output\\")) continue;
    let m: RegExpExecArray | null;
    HALLUCINATION_PATH_RE.lastIndex = 0;
    while ((m = HALLUCINATION_PATH_RE.exec(src)) !== null) {
      const candidate = m[1];
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      // Skip if already covered by an explicit MEDIA directive (existing url).
      const alreadyAttached = Array.from(existing).some((u) =>
        u.endsWith(candidate.replace(/^\.\.\//, "")),
      );
      if (alreadyAttached) continue;
      const resolved = resolveOutputCandidate(candidate);
      if (resolved) {
        autoAttach.push(resolved);
      } else {
        missing.push(candidate);
      }
    }
  }
  return { autoAttach, missing };
}

// CLAW-FORK 2026-05-03: format-guard for HTML/PDF attachment responses.
//
// Kimi K2.6 frequently emits two banned shorthand fence forms instead of the
// 5-block RAW Slack Block Kit (header/section/divider/section.fields/context)
// that the slack-response skill mandates for media-attached replies:
//
//   1. {"interactive": {"text": "...", "buttons": [...]}}        — root has no `blocks`
//   2. {"blocks": [{"type": "text", ...}, {"type": "buttons"}]}  — only abstract types
//
// Both render as a near-empty Slack card next to the attachment. Prompt-only
// rules in AGENTS.md + slack-response/SKILL.md proved insufficient (verified
// 2026-05-03: bot violated the rules within minutes of tightening both files).
// This guard rewrites at dispatch time AFTER MEDIA: directive is parsed and
// mediaUrls is populated by the hallucination-guard auto-attach above.
//
// Rewrite output: a 3-block RAW kit (header + section.text + context with file
// path). Skips divider+fields because synthesizing meaningful field content from
// the shorthand text isn't reliable. Banned external-URL buttons in the fence
// are dropped — fork still auto-adds the "🌐 브라우저에서 열기" button for the
// attachment file.
export function applyMediaFormatGuard(params: {
  interactive: unknown;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): { rewrittenBlocks: unknown[]; summary: string; fileBaseRaw: string } | undefined {
  const { interactive, text, mediaUrl, mediaUrls } = params;
  const hasMediaForGuard = Boolean(mediaUrl) || Boolean(mediaUrls && mediaUrls.length > 0);
  if (!interactive || !hasMediaForGuard) return undefined;
  const ABSTRACT_BLOCK_TYPES = new Set(["text", "buttons", "select"]);
  const interactiveObj = interactive as { blocks?: unknown[] } & Record<string, unknown>;
  const interactiveBlocks = Array.isArray(interactiveObj.blocks)
    ? (interactiveObj.blocks as Array<Record<string, unknown>>)
    : undefined;
  const isShorthandObject =
    !interactiveBlocks &&
    (typeof interactiveObj.text === "string" || Array.isArray(interactiveObj.buttons));
  const isAbstractBlocksOnly =
    interactiveBlocks &&
    interactiveBlocks.length > 0 &&
    interactiveBlocks.every((b) => {
      const t = (b as { type?: unknown })?.type;
      return typeof t === "string" && ABSTRACT_BLOCK_TYPES.has(t);
    });
  if (!isShorthandObject && !isAbstractBlocksOnly) return undefined;
  const candidatePath = String(mediaUrl ?? mediaUrls?.[0] ?? "");
  const fileBaseRaw = path.basename(candidatePath);
  const fileBase = fileBaseRaw.replace(/\.[^.]+$/, "");
  const titleHint =
    fileBase
      .replace(/-+\d{6,}-?\d{0,4}$/, "")
      .replace(/[-_]+/g, " ")
      .trim()
      .slice(0, 150) || "Output";
  let summary = "";
  if (typeof interactiveObj.text === "string") {
    summary = interactiveObj.text;
  } else if (interactiveBlocks) {
    summary = interactiveBlocks
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => String((b as { text?: unknown }).text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  if (!summary && text) {
    summary = text;
  }
  const summaryClean =
    summary
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 2900) || "(첨부 파일 참고)";
  const rewrittenBlocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: titleHint, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summaryClean },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `\`${fileBaseRaw}\`` }],
    },
  ];
  return { rewrittenBlocks, summary: summaryClean, fileBaseRaw };
}

/** CLAW-FORK: append raw Slack blocks into payload.channelData.slack.blocks. */
export function mergeSlackBlocksIntoChannelData(
  channelData: Record<string, unknown> | undefined,
  blocks: unknown[],
): Record<string, unknown> {
  const baseChannelData = channelData && typeof channelData === "object" ? channelData : {};
  const baseSlack =
    baseChannelData.slack &&
    typeof baseChannelData.slack === "object" &&
    !Array.isArray(baseChannelData.slack)
      ? (baseChannelData.slack as Record<string, unknown>)
      : {};
  const existingBlocks = Array.isArray(baseSlack.blocks) ? (baseSlack.blocks as unknown[]) : [];
  return {
    ...baseChannelData,
    slack: {
      ...baseSlack,
      blocks: [...existingBlocks, ...blocks],
    },
  };
}

/** CLAW-FORK: read existing raw Slack blocks from channelData for hallucination scanning. */
export function readSlackBlocksFromChannelData(
  channelData: Record<string, unknown> | undefined,
): unknown[] {
  const slack = channelData?.slack;
  if (slack && typeof slack === "object" && !Array.isArray(slack)) {
    const blocks = (slack as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) return blocks;
  }
  return [];
}
