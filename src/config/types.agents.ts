import type { ChatType } from "../channels/chat-type.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
  EmbeddedPiExecutionContract,
} from "./types.agent-defaults.js";
import type {
  AgentEmbeddedHarnessConfig,
  AgentModelConfig,
  AgentSandboxConfig,
} from "./types.agents-shared.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { SkillsLimitsConfig } from "./types.skills.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentRuntimeAcpConfig = {
  /** ACP harness adapter id (for example codex, claude). */
  agent?: string;
  /** Optional ACP backend override for this agent runtime. */
  backend?: string;
  /** Optional ACP session mode override. */
  mode?: "persistent" | "oneshot";
  /** Optional runtime working directory override. */
  cwd?: string;
};

export type AgentRuntimeConfig =
  | {
      type: "embedded";
    }
  | {
      type: "acp";
      acp?: AgentRuntimeAcpConfig;
    };

export type AgentBindingMatch = {
  channel: string;
  accountId?: string;
  peer?: { kind: ChatType; id: string };
  guildId?: string;
  teamId?: string;
  /** Discord role IDs used for role-based routing. */
  roles?: string[];
};

export type AgentRouteBinding = {
  /** Missing type is interpreted as route for backward compatibility. */
  type?: "route";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
};

export type AgentAcpBinding = {
  type: "acp";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  acp?: {
    mode?: "persistent" | "oneshot";
    label?: string;
    cwd?: string;
    backend?: string;
  };
};

// CLAW-FORK 2026-05-03 (Phase 2, multi-agent): intent-router binding.
// When the dispatcher sees a binding of this type for the inbound channel/peer,
// it pauses the synchronous route resolution, asks the configured `router.agentId`
// to classify the message, then routes to the agent the classifier picked.
// Concretely: `resolveAgentRoute()` returns the synthetic sentinel agentId
// `__intent_pending__`; `dispatch-from-config` detects it, calls
// `resolveIntentAgent()`, then continues with the resolved real agentId.
// Intentionally separate type so the binding tier can be enabled/scoped
// per-channel without mixing with peer-direct routes.
export type AgentIntentBinding = {
  type: "intent";
  comment?: string;
  match: AgentBindingMatch;
  router: {
    /** Agent to invoke for classification. Should be a cheap/fast model. */
    agentId: string;
    /** Optional one-shot system prompt override for the classifier turn only. */
    promptOverride?: string;
    /** Fallback agent when the classifier times out / errors / returns invalid. */
    fallbackAgentId?: string;
    /** TTL seconds for the classifier cache. Default: 300. */
    cacheTtlSec?: number;
    /** Hard timeout for the classifier call in ms. Default: 8000. */
    timeoutMs?: number;
  };
};

export type AgentBinding = AgentRouteBinding | AgentAcpBinding | AgentIntentBinding;

/**
 * CLAW-FORK 2026-05-03 (Phase 2, multi-agent): synthetic agentId returned by
 * `resolveAgentRoute()` when an intent-binding tier matched. The dispatcher
 * MUST replace this with a real agentId via `resolveIntentAgent()` before
 * proceeding to `getReplyFromConfig`. If a downstream consumer ever sees this
 * as the final agentId, that's a bug — log loudly and fall back to default.
 */
export const INTENT_PENDING_AGENT_ID = "__intent_pending__";

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  /** Optional per-agent full system prompt replacement. */
  systemPromptOverride?: AgentDefaultsConfig["systemPromptOverride"];
  /** Optional per-agent embedded harness policy override. */
  embeddedHarness?: AgentEmbeddedHarnessConfig;
  model?: AgentModelConfig;
  /** Optional per-agent default thinking level (overrides agents.defaults.thinkingDefault). */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
  /** Optional per-agent default verbosity level. */
  verboseDefault?: "off" | "on" | "full";
  /** Optional per-agent default reasoning visibility. */
  reasoningDefault?: "on" | "off" | "stream";
  /** Optional per-agent default for fast mode. */
  fastModeDefault?: boolean;
  /** Optional allowlist of skills for this agent; omitting it inherits agents.defaults.skills when set, and an explicit list replaces defaults instead of merging. */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent skills subsystem overrides. */
  skillsLimits?: Pick<SkillsLimitsConfig, "maxSkillsPromptChars">;
  /** Optional per-agent overrides for selected context/token-heavy limits. */
  contextLimits?: AgentContextLimitsConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). */
    requireAgentId?: boolean;
  };
  /** Optional per-agent embedded Pi overrides. */
  embeddedPi?: {
    /** Optional per-agent execution contract override. */
    executionContract?: EmbeddedPiExecutionContract;
  };
  /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig;
  /** Optional per-agent stream params (e.g. cacheRetention, temperature). */
  params?: Record<string, unknown>;
  tools?: AgentToolsConfig;
  /** Optional runtime descriptor for this agent. */
  runtime?: AgentRuntimeConfig;
  /**
   * Optional per-agent reviewer policy.
   * - "on" (default): runtime reviewer hook validates outbound replies and may
   *   append a reject footer.
   * - "off": skip reviewer entirely. Use for direct-to-user agents where the
   *   user is the deployment-gate (e.g. self-improve reviews via branch diff;
   *   data-analyst bots verify against external dashboards). Reviewer footers
   *   add noise without value in those flows.
   */
  reviewer?: "on" | "off";
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};
