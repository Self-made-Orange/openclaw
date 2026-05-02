---
summary: Lock Phase 0 decisions (storage, SDK, frontmatter, sign-off) so Phase 1 can begin without ambiguity.
title: Hermes hybrid self-improvement — Phase 0 alignment
read_when:
  - Reviewing or signing off on the Hermes hybrid self-improvement proposal
  - About to start Phase 1 (open-prose-memory plugin) and need the locked contract
  - Touching `~/.openclaw/memory/` layout, plugin SDK memory hooks, or pattern frontmatter for memory/evolve flags
---

## Status

Draft alignment. Awaiting solo-dev sign-off (this fork has no separate CODEOWNERS team —
the maintainer is the sole approver). Phase 1 must not start until each "Decision" block
below is marked `LOCKED`.

## Purpose

Resolve the four open contracts from `hermes-hybrid-self-improvement.md` Phase 0 so the
plugin work in Phase 1 (`open-prose-memory`) can be implemented against a stable target.

Each decision is laid out with: proposal, rationale, alternatives considered, status.
Edit the status to `LOCKED` (or `REVISED` with notes) to sign off.

## Decision 1 — On-disk state layout

### Proposal

```
~/.openclaw/memory/
  <agentId>/
    sessions.db          # SQLite, FTS5 virtual table over compacted session summaries
    user.md              # append-only observed user preferences (Honcho-lite bullet list)
    memory.md            # append-only durable facts surfaced by patterns
    traces/              # Phase 2 dependency, created lazily
      <pattern-id>/
        <session-id>.jsonl
```

### Retention and rotation

- `sessions.db` — indefinite, soft cap **1 GB per agentId**. When breached, drop oldest
  rows by `last_recall_ts` (LRU). Configurable via `memory.sessionsDbCapMB`.
- `user.md`, `memory.md` — append-only, no rotation. Files are bounded by usage volume,
  not policy.
- `traces/` — default **90-day TTL** per file. Configurable globally via
  `memory.tracesRetentionDays`. Per-pattern override through frontmatter
  (`evolve.traceRetentionDays`).

### Redaction

- **Default: off** — unredacted persistence preserves recall quality.
- Opt-in scrub via `memory.redact: true` in agent config. When enabled, applies the
  following regex passes pre-commit: email, phone (E.164 + common locale formats),
  credit-card (Luhn-validated 13–19 digit), bearer tokens (`xox[bp]-…`, `sk-…`,
  `ghp_…`, `ntn_…`).
- Redaction is irreversible. Original transcript is not retained when scrub is on.

### Export and ownership

- CLI: `openclaw memory export <agentId> --out <path>` produces a tarball with
  `sessions.db` + `*.md` + `traces/`.
- CLI: `openclaw memory clear <agentId>` removes the entire `<agentId>/` directory after
  interactive confirmation. `--yes` for scripted cleanup.
- File ownership is the OS user that ran the agent. No multi-user permission model in
  scope.

### Alternatives considered

- **Single shared `sessions.db` for all agentIds** — rejected. Cross-agent leakage risk
  and harder export/clear semantics outweigh the modest dedupe gain.
- **JSONL only, no SQLite** — rejected. FTS5 is the cheapest hybrid lexical/semantic
  recall available without pulling in a vector DB dependency.
- **Vector store (sqlite-vss / pgvector / qdrant)** — deferred to Phase 3+ if FTS5 recall
  proves insufficient. Adds binary deps the default install must avoid.

### Status

`PENDING` — awaiting sign-off.

## Decision 2 — Plugin SDK additions

### Proposal

Two additions under `openclaw/plugin-sdk/memory`:

```ts
// Lifecycle hook — called after every pattern completes (success or failure).
// Plugins implement this to capture traces, write summaries, etc.
export interface OnPatternCompleteHook {
  (trace: PatternTrace): Promise<void>;
}

export interface PatternTrace {
  agentId: string;
  patternId: string;
  sessionId: string;
  startedAt: string; // ISO 8601 UTC
  endedAt: string;
  outcome: "success" | "failure" | "abort";
  toolCalls: ToolCallSummary[]; // length, identity, error/retry counts
  tokenUsage: { input: number; output: number; cacheHit: number };
  promptHash: string; // SHA-256 of final prompt (for dedupe)
  errorMessage?: string; // present iff outcome !== "success"
  patternFlags: { memory?: "cross-session"; evolve?: boolean };
}

// Runtime helper — called from inside a pattern body to fetch ranked recall.
// Returns [] for patterns without `memory: cross-session`.
export interface RecallHelper {
  (query: string, opts?: RecallOptions): Promise<RecallResult[]>;
}

export interface RecallOptions {
  k?: number; // default 5
  agentId?: string; // default = current agent
  minScore?: number; // FTS5 bm25 threshold, default 0
}

export interface RecallResult {
  sessionId: string;
  summary: string;
  score: number;
  ts: string;
}
```

### Versioning

- This is a net-add. Existing SDK consumers see no breaking change.
- Bump SDK **minor** version (current `0.X.Y` → `0.(X+1).0`).
- Generate baseline diff via `pnpm plugin-sdk:api:gen`. Verify no incidental break via
  `pnpm plugin-sdk:api:check`.
- Document the additions in `openclaw/plugin-sdk/CHANGELOG.md` with a "since 0.(X+1).0"
  marker on the new types.

### Hook registration

- Plugins register `onPatternComplete` via the existing plugin manifest's lifecycle
  section — no new manifest field required.
- Multiple plugins may register; runtime invokes them sequentially in registration order
  with a per-hook 30s timeout. Hook failures are logged and do not propagate.

### Alternatives considered

- **Synchronous hook** — rejected. Persistent storage writes (SQLite, summarizer LLM
  call) must not block the pattern's completion path.
- **Event bus / pub-sub** — rejected. Adds runtime indirection; the typed hook is a
  better fit for OpenClaw's plugin SDK style.

### Status

`PENDING` — awaiting sign-off.

## Decision 3 — Pattern frontmatter schema

### Proposal

Add two new optional top-level keys to the existing pattern frontmatter:

```yaml
memory: cross-session   # enum: "off" (default) | "cross-session"
evolve: true            # bool: false (default) | true
evolve:                 # OR: object form, when overrides needed
  enabled: true
  trigger:
    toolCalls: 5        # default 5
    retryCount: 2       # default 2
  traceRetentionDays: 30  # overrides global default
```

### Default behavior preserved

- A pattern without these keys runs **identically to today**. No recall, no trace
  capture, no skill proposal. This is the central opt-in guarantee from the proposal.

### Validation

- Schema enforced by `pnpm config:docs:check` against the existing pattern frontmatter
  schema (extend `extensions/open-prose/skills/prose/guidance/patterns.md` with the new
  fields).
- Unknown values fail loudly at pattern load time (consistent with existing strict
  frontmatter handling).

### Alternatives considered

- **Single `selfImprove: true` umbrella flag** — rejected. Couples memory and evolve;
  pattern authors may want one without the other (e.g., recall without auto-skill
  proposals).
- **Separate sidecar config file** — rejected. Frontmatter co-locates intent with the
  pattern, matching existing `max:` counter conventions.

### Status

`PENDING` — awaiting sign-off.

## Decision 4 — Sign-off (solo dev)

This fork has no separate CODEOWNERS team. The repository maintainer is the sole
approver. Sign-off below authorizes Phase 1 to begin.

| Decision                | Status    | Approved by | Date | Notes |
| ----------------------- | --------- | ----------- | ---- | ----- |
| 1. On-disk state layout | `PENDING` | —           | —    | —     |
| 2. Plugin SDK additions | `PENDING` | —           | —    | —     |
| 3. Frontmatter schema   | `PENDING` | —           | —    | —     |

## Open questions to resolve at sign-off

1. **Redaction default** — current proposal is OFF. Confirm or flip. If flipping ON by
   default, list any pattern that would lose recall quality unacceptably.
2. **Trace retention** — 90 days global default. Acceptable, or shorter (e.g., 30) to
   minimize disk footprint?
3. **SDK hook timeout** — 30 seconds per hook. Acceptable, or tighter (10s) to keep
   shutdown fast even when a hook hangs?
4. **`agentId` namespace** — singular per-OS-user agent today, but the path layout
   already keys by `<agentId>` to allow future multi-agent isolation. Confirm this is
   desired forward-compat or collapse to a flat layout for now.

## Once locked

When all three "Decision N" blocks read `LOCKED`, Phase 1 work begins:

- New plugin scaffold at `extensions/open-prose-memory/` (manifest, SKILL.md, src/, test/).
- SDK addition committed under `openclaw/plugin-sdk/memory.ts` (new file) with `since`
  markers.
- Frontmatter schema doc updated in
  `extensions/open-prose/skills/prose/guidance/patterns.md`.
- One PoC pattern in `extensions/open-prose/skills/prose/examples/` toggles
  `memory: cross-session` for the integration smoke test.
