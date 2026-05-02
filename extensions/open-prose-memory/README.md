# OpenProse Memory

Phase 1 of the Hermes hybrid self-improvement layer. Provides cross-session
memory recall for OpenProse patterns that opt in via frontmatter.

## Status

**Phase 1 v1 — runtime-wired.** SDK memory hook types, redaction, markdown
writers, SQLite + FTS5 sessions store, and the `agent_end` hook subscription
are landed. Per-pattern frontmatter gating (`memory: cross-session`) is the
remaining v2 work; today every completed agent turn is summarized and persisted
when the plugin is `enabled`. Sonnet summarizer adapter and recall injection
into pattern bodies follow in subsequent commits on `feat/hermes-self-improve`.

See [docs/plan/hermes-hybrid-self-improvement.md](../../docs/plan/hermes-hybrid-self-improvement.md)
for the design and
[docs/plan/hermes-hybrid-self-improvement-phase-0-alignment.md](../../docs/plan/hermes-hybrid-self-improvement-phase-0-alignment.md)
for the locked Phase 0 contracts that govern this plugin.

## Activation

A pattern receives recall results only when its frontmatter declares:

```yaml
memory: cross-session
```

Patterns without this flag run unchanged — no recall, no DB writes, no
overhead.

## On-disk layout

Per Phase 0 Decision 1:

```
~/.openclaw/memory/
  <agentId>/
    sessions.db          # SQLite + FTS5 (compacted summaries)
    user.md              # observed user preferences (append-only)
    memory.md            # durable facts surfaced by patterns (append-only)
    traces/              # Phase 2 dependency, created lazily
```

## Configuration (excerpt)

| Key                   | Default | Notes                                                                            |
| --------------------- | ------- | -------------------------------------------------------------------------------- |
| `enabled`             | `true`  | Plugin-wide kill switch; per-pattern opt-in still required.                      |
| `sessionsDbCapMB`     | `1024`  | Soft cap per `agentId`. LRU eviction by `last_recall_ts`.                        |
| `tracesRetentionDays` | `30`    | TTL for trace JSONL files. Per-pattern override via `evolve.traceRetentionDays`. |
| `redactPII`           | `false` | Bearer tokens are always scrubbed regardless of this flag.                       |
| `summarizerModel`     | _agent_ | Model used to compact session transcripts. Defaults to agent primary.            |
| `recallDefaultK`      | `5`     | Top-k recall results when a pattern does not specify k.                          |

## Testing

```sh
pnpm test extensions/open-prose-memory
```

Real SQLite roundtrip tests gated behind a `OPENCLAW_TEST_SQLITE=1` env var
once the store implementation lands; until then unit tests cover the
redaction passes and markdown writers.
