---
name: router-fragment-injector
description: "Classify each user message and inject a matching specialist prompt fragment so the agent reads narrower, type-focused rules per turn"
homepage: https://github.com/Self-made-Orange/openclaw
metadata:
  {
    "openclaw":
      {
        "emoji": "🚦",
        "events": ["message:preprocessed", "agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Router Fragment Injector

Classifies each incoming user message into a coarse type (envelope / search / code / wiki / plain) and injects a matching specialist prompt fragment from `<workspace>/agents-fragments/AGENTS-<type>.md` into the agent's system prompt.

## Why

Long monolithic `AGENTS.md` (33KB+) is poorly followed by cheap fast models (verified 2026-05-03 with Gemini 2.5 Flash + Kimi K2.6). Each turn typically needs only a thin slice of the rules — the rest is noise that drowns the relevant constraints. This hook gives a "single-agent multi-prompt" approximation of the multi-agent architecture: the runtime stays single-agent, but each turn's effective system prompt is `core AGENTS.md + one narrow specialist fragment`.

## Classification

Currently rule-based keyword classifier (latency 0, cost 0). LLM classifier upgrade is a future iteration.

| Type       | Trigger keywords (KO/EN, regex-friendly)                                |
| ---------- | ----------------------------------------------------------------------- |
| `envelope` | 만들어\|정리\|비교\|리포트\|분석\|envelope\|html\|chart\|graph\|diagram |
| `search`   | 검색\|찾아\|최신\|뉴스\|오늘\|현재\|search\|news\|today                 |
| `code`     | 코드\|구현\|refactor\|PR\|타입\|typescript\|python\|debug\|버그         |
| `wiki`     | wiki\|vault\|저장\|ingest\|메모리\|기록\|note                           |
| `plain`    | (default fallback)                                                      |

Multiple keyword matches → first hit wins by table order (envelope > search > code > wiki > plain).

## Configuration

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "router-fragment-injector": {
          "enabled": true,
          "fragmentDir": "agents-fragments"
        }
      }
    }
  }
}
```

## Options

- `fragmentDir` (string): directory under workspace root holding `AGENTS-<type>.md` files. Default: `"agents-fragments"`.
- `enabled` (boolean): default false (must be opted in).

## Lifecycle

1. **`message:preprocessed`** — read `bodyForAgent` text, classify, store `{conversationId → type}` in 60s in-memory cache.
2. **`agent:bootstrap`** — read cached type for the session's `sessionKey` (matched via conversationId substring), append `agents-fragments/AGENTS-<type>.md` to `bootstrapFiles`.

If no match cached (e.g., bootstrap fired before classification), the hook is a no-op — base AGENTS.md still loads as before.

## Failure modes

- **No fragment file** → silently skip, log debug.
- **Classification cache miss** → silently skip.
- **Classification timeout/error** (rule-based: never; LLM future: <500ms timeout) → fall back to `plain`.

The hook is non-fatal: any failure leaves the prompt unchanged, so the agent always gets at least the base bootstrap.
