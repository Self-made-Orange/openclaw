// Defines agent routing, model, and runtime configuration types.
import type { ChatType } from "../channels/chat-type.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
  AgentModelEntryConfig,
  EmbeddedAgentExecutionContract,
  SubagentDelegationMode,
} from "./types.agent-defaults.js";
import type { AgentModelConfig, AgentSandboxConfig } from "./types.agents-shared.js";
import type { DmScope, HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { SkillsLimitsConfig } from "./types.skills.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";

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
  /**
   * Channel account to match.
   * - Omitted/empty: matches only the channel default account.
   * - "*": matches every account on the channel.
   * - Any other string: matches that specific account id.
   */
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
  session?: {
    /** Optional session scoping override for conversations matched by this binding. */
    dmScope?: DmScope;
  };
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

// CLAW-FORK (multi-agent): intent-router binding.
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
 * CLAW-FORK (multi-agent): synthetic agentId returned by `resolveAgentRoute()`
 * when an intent-binding tier matched. The dispatcher MUST replace this with a
 * real agentId via `resolveIntentAgent()` before proceeding to
 * `getReplyFromConfig`. If a downstream consumer ever sees this as the final
 * agentId, that's a bug — log loudly and fall back to default.
 */
export const INTENT_PENDING_AGENT_ID = "__intent_pending__";

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  /** Optional human-authored agent description. */
  description?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentModelEntryConfig["agentRuntime"];
  /** Per-model metadata overrides for this agent. */
  models?: Record<string, AgentModelEntryConfig>;
  /** @deprecated Legacy per-agent compaction config is kept for raw doctor migration/repair. */
  compaction?: AgentDefaultsConfig["compaction"];
  /** Optional per-agent default thinking level (overrides agents.defaults.thinkingDefault). */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
  /** Optional per-agent default verbosity level. */
  verboseDefault?: "off" | "on" | "full";
  /** Optional per-agent tool progress detail mode. */
  toolProgressDetail?: AgentDefaultsConfig["toolProgressDetail"];
  /** Optional per-agent default reasoning visibility. */
  reasoningDefault?: "on" | "off" | "stream";
  /** Optional per-agent default for fast mode. */
  fastModeDefault?: boolean;
  /** Optional per-agent bootstrap/context injection mode override. */
  contextInjection?: AgentDefaultsConfig["contextInjection"];
  /** Optional per-agent max chars for each injected bootstrap file. */
  bootstrapMaxChars?: AgentDefaultsConfig["bootstrapMaxChars"];
  /** Optional per-agent max total chars across injected bootstrap files. */
  bootstrapTotalMaxChars?: AgentDefaultsConfig["bootstrapTotalMaxChars"];
  /** Optional per-agent experimental flags. Omitted fields inherit agents.defaults.experimental. */
  experimental?: AgentDefaultsConfig["experimental"];
  /** Optional allowlist of skills for this agent; omitting it inherits agents.defaults.skills when set, and an explicit list replaces defaults instead of merging. */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent TTS overrides, deep-merged over messages.tts. */
  tts?: TtsConfig;
  /** Optional per-agent skills subsystem overrides. */
  skillsLimits?: Pick<SkillsLimitsConfig, "maxSkillsPromptChars">;
  /** Optional per-agent overrides for selected context/token-heavy limits. */
  contextLimits?: AgentContextLimitsConfig;
  contextTokens?: number;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  /**
   * CLAW-FORK: replaces the generated system prompt for this agent.
   * Supports `<file:...>` directives (tilde-expanded, mtime-cached).
   */
  systemPromptOverride?: string;
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Prompt-only guidance for how strongly this agent should delegate work. */
    delegationMode?: SubagentDelegationMode;
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any configured target. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Per-agent default thinking level for spawned sub-agents. */
    thinking?: string;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). */
    requireAgentId?: boolean;
  };
  /** Optional outer run loop retry boundaries. */
  runRetries?: AgentDefaultsConfig["runRetries"];
  /** Optional per-agent embedded OpenClaw overrides. */
  embeddedAgent?: {
    /** Optional per-agent execution contract override. */
    executionContract?: EmbeddedAgentExecutionContract;
  };
  /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig;
  /** Optional per-agent stream params (e.g. cacheRetention, temperature). */
  params?: Record<string, unknown>;
  tools?: AgentToolsConfig;
  /** Optional runtime descriptor for this agent. */
  runtime?: AgentRuntimeConfig;
  /**
   * CLAW-FORK: optional per-agent outbound-response reviewer policy.
   * Named `responseReviewer` (not `reviewer`) to avoid confusion with the
   * upstream exec-approval reviewer at `tools.exec.reviewer`.
   *
   * OPT-IN (CLAW-FORK 2026-06-13 HIGH-4): the reviewer runs ONLY when this is
   * explicitly "on". This avoids a per-reply Moonshot call (up to ~8s serial)
   * for agents that don't need outbound review.
   * - "on": runtime reviewer hook validates outbound replies and may append a
   *   reject footer.
   * - "off" / absent (default): skip reviewer entirely. Use for direct-to-user
   *   agents where the user is the deployment-gate (e.g. self-improve reviews via
   *   branch diff; data-analyst bots verify against external dashboards).
   */
  responseReviewer?: "on" | "off";
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};
