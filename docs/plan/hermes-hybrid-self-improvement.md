---
summary: Graft Hermes Agent self-improvement mechanisms onto OpenClaw's opt-in OpenProse pattern library as opt-in plugin layers.
title: Hermes hybrid self-improvement plan
read_when:
  - Designing or reviewing self-improvement, evolutionary, or cross-session memory features for OpenClaw
  - Touching OpenProse pattern semantics, frontmatter schema, or plugin SDK hooks for trace capture
  - Evaluating whether to import Hermes Agent or GEPA-style mechanisms into the OpenClaw runtime
---

## Status

Proposal. Not yet approved. Requires CODEOWNERS sign-off before implementation begins, since
the work touches plugin SDK contracts, persistent on-disk state, and pattern semantics.

## Problem

OpenClaw's self-improvement story today lives entirely inside OpenProse patterns
(`extensions/open-prose/skills/prose/guidance/patterns.md:351-450` and adjacent example
files). All loops are bounded by explicit `max:` counters, role-split between Sonnet and
Opus, and re-run from scratch on every invocation. There is no:

- Cross-session recall of prior task outcomes.
- Autonomous skill capture from successful runs.
- Trace-based reflection that mutates skills or prompts based on why a run failed.
- Persistent user model.

Hermes Agent (Nous Research, v0.10.0) ships these as first-class concerns: skill creation
after complex tasks, FTS5 cross-session memory, Honcho dialectic user modeling, and a
GEPA-driven evolution loop that mutates skills through reflective trace analysis gated by
human PR review.

Adopting Hermes wholesale conflicts with OpenClaw's "core stays extension-agnostic",
"opt-in patterns", "no broad mutable registries are transitional", and CODEOWNERS-gated
behavior change rules. The goal is to graft the useful Hermes mechanisms onto OpenClaw
without violating those rules.

## Goals

- Pattern authors opt into self-improvement and cross-session memory through frontmatter
  flags. Default behavior is unchanged.
- All evolutionary mutations land as draft pull requests for human review. No automated
  merges to plugin or skill files.
- Cross-session state lives in a new isolated path under `~/.openclaw/memory/`, separate
  from `credentials/` and `agents/`.
- Core stays plugin-agnostic. New behavior ships as bundled plugins under `extensions/`.
- Plugin SDK additions are versioned, documented, and backwards compatible.

## Non-Goals

- Automated tool-implementation code mutation (Hermes phase 4 / Darwinian Evolver).
- Auto-merging evolved patterns or skills.
- Replacing or deprecating any current OpenProse pattern.
- Adopting Honcho as a third-party dependency. We ship a simplified user-model file
  format only.

## Architecture

Three opt-in layers wrap the existing pattern runtime:

```
Layer 3   open-prose-evolve    Trace -> reflective proposal -> draft PR
Layer 2   open-prose-memory    SQLite + FTS5 + user.md / memory.md
Layer 1   open-prose            Existing bounded patterns (unchanged)
```

Activation is per pattern through new frontmatter fields:

- `memory: cross-session` enables Layer 2 recall and writeback for that pattern.
- `evolve: true` enables Layer 3 trace capture and skill proposal for that pattern.

Patterns without these fields run exactly as today.

## Phase 0: Alignment

No code. Decisions and approvals.

- CODEOWNERS approval on the overall direction. Larger behavior, security, and
  ownership-sensitive change rules apply.
- On-disk state policy: settle `~/.openclaw/memory/<agentId>/{sessions.db, user.md, memory.md}`
  layout, retention, redaction, and export semantics.
- Plugin SDK addition agreement: new `onPatternComplete(trace)` hook and `recall(query, k)`
  runtime helper. Confirm semver bump strategy with `pnpm plugin-sdk:api:gen` baseline.
- Pattern frontmatter schema additions for `memory` and `evolve`. Update
  `pnpm config:docs:gen/check` and pattern guidance docs.

## Phase 1: Layer 2 - Memory plugin

Path: `extensions/open-prose-memory/`

Responsibilities:

- SQLite database with FTS5 virtual table indexing finished session transcripts.
- Async post-session compaction worker that summarizes each session with Sonnet and
  stores the summary alongside the raw transcript for hybrid lexical and semantic recall.
- Runtime helper exposed through plugin SDK: `recall(query, k=5)` returns ranked snippets
  ready for prompt injection.
- Append-only `user.md` and `memory.md` builders that persist user preferences and
  durable facts. Format is a simplified subset of the Honcho dialectic model: bullet
  list of observed preferences with timestamps and source session ids.
- Activation gate: only patterns declaring `memory: cross-session` see recall results.
  No recall happens for patterns without the flag.

Tests:

- Unit tests for the indexer, summarizer adapter, and recall ranker.
- One integration smoke per boundary, not per branch (per `test/helpers/AGENTS.md`).
- Hot-path import budget enforced through `pnpm test:perf:imports`.

Gates: `pnpm test extensions/open-prose-memory`, `pnpm check:architecture`,
`pnpm check:import-cycles`, `pnpm plugin-sdk:api:check`.

## Phase 2: Layer 3 - Trace capture and skill suggester

Path: `extensions/open-prose-evolve/`

Responsibilities:

- Trace recorder: per-pattern execution capture of tool calls, retries, errors, token
  counts, and wall-clock latency. Writes traces to `~/.openclaw/memory/<agentId>/traces/`.
- Trigger heuristics inherited from Hermes: `tool_calls >= 5` or `retry_count >= 2`
  qualify a run as worth proposing a skill for. Configurable per pattern through
  frontmatter (`evolve.trigger`).
- Skill proposer: Sonnet evaluator reads the trace and drafts a candidate `SKILL.md`
  capturing approach, edge cases, and domain knowledge surfaced by the run.
- Pull request automation: opens a draft PR through the GitHub MCP server with the
  proposed skill plus the supporting trace summary as the PR body. Never merges.
- Acceptance gates enforced before opening the PR: skill size 15KB or less, existing
  pattern test suites stay green when the proposed skill is loaded, and prompt-cache
  ordering is preserved (deterministic registry ordering rule).

Tests:

- Unit tests for trigger heuristics, trace summarization, and PR payload assembly.
- Mock the GitHub MCP boundary; do not exercise live PR creation in CI.

Gates: same as Phase 1 plus a no-network check in unit lanes.

## Phase 3: GEPA-style reflective mutation (optional)

Scope-limited adoption of Hermes' GEPA loop:

- Mutate `SKILL.md` only (Hermes phase 1 scope). Tool descriptions, system prompt
  sections, and tool implementation code are out of scope here.
- Eval set sourced automatically from the Phase 2 trace pool, gated on minimum sample
  count.
- Budget cap through `OPENCLAW_EVOLVE_BUDGET_USD` env var. Default 5. Hard ceiling.
- DSPy adoption decision is deferred. Evaluate weight on cold-start (`pnpm test:perf:imports`)
  before committing. A self-contained reflective mutator is preferred if DSPy import cost
  is unacceptable.
- Output is always a draft PR. Auto-merge is forbidden.

Phase 3 ships only if Phase 2 PoC shows clear quality wins and the SDK surface remains
backwards compatible.

## Phase 4: Integration and docs

PoC patterns under `extensions/open-prose/skills/prose/examples/`:

- `40-rlm-self-refine.prose` toggled with `evolve: true` to validate trace capture.
- New `48-cross-session-memory.prose` exercising Layer 2 recall in isolation.
- `33-pr-review-autofix.prose` toggled with both flags for full-stack validation.

Docs:

- New concept doc `/concepts/self-improvement` describing the three-layer model and
  opt-in flags.
- New help doc `/help/memory-recall` covering on-disk layout, redaction, and export.
- Update `extensions/open-prose/skills/prose/guidance/patterns.md` with frontmatter
  schema and the two new flags.
- Changelog entries split by layer: Layer 2 GA, Layer 3 GA, Layer 3 evolution GA.
- `.github/labeler.yml` adds `area/memory` and `area/evolve`.

## Validation gates per phase

- `pnpm check:changed` before handoff.
- `pnpm test:changed` for fast tests.
- `pnpm check:architecture` to enforce the no broad mutable registries direction.
- `pnpm build` when lazy-import boundaries change.
- `pnpm test:perf:imports` against new files to keep cold-start budgets honest.
- `pnpm plugin-sdk:api:check` for any SDK surface diff.
- `pnpm config:docs:check` for frontmatter schema changes.

## Risks and decision points

| Item | Risk | Gate |
| --- | --- | --- |
| New persistent on-disk path | User data governance | Phase 0 storage policy approval |
| New plugin SDK hooks | Third-party plugin compatibility | Versioned SDK release with migration notes |
| Trace recorder overhead | Hot-path regression | `pnpm test:perf:hotspots` budget |
| GEPA token cost | Budget runaway | Hard env-var cap plus human PR gate |
| Skill auto-evolution | Silent prompt drift | Draft PR only, no auto-merge ever |
| Hermes phase 4 (code mutation) | Unsafe automated code edits | Explicitly out of scope |

## Milestones

- M1: Phase 0 approval and storage policy locked.
- M2: Layer 2 plugin shipped behind opt-in flag, beta on one pattern.
- M3: Layer 3 trace capture and skill proposer shipped, draft PRs against a sandbox
  fork.
- M4: Decision on Phase 3 GEPA adoption.
- M5: Phase 4 PoC patterns merged, concept and help docs published, GA changelog entry.

## Open questions

- Does the user-model file format need a redaction pass before commit-time PR creation?
- Should `recall` results be deduplicated against the active session context to avoid
  prompt bloat, or is that the calling pattern's responsibility?
- Is a per-pattern trace retention window appropriate, or do we keep a single global
  policy under `~/.openclaw/memory/`?
- Does Phase 3 require a separate plugin (`extensions/open-prose-evolve-gepa`) to keep
  DSPy weight off the default install?
