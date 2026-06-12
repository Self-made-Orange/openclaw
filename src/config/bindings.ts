// Normalizes agent binding config for channels, routes, and ACP sessions.
import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function normalizeBindingType(binding: AgentBinding): "route" | "acp" | "intent" {
  // Missing `type` is the legacy/default route binding shape.
  if (binding.type === "acp") {
    return "acp";
  }
  // CLAW-FORK (multi-agent): intent bindings are handled by the intent-router
  // tier in resolve-route.ts, never as channel route bindings.
  if (binding.type === "intent") {
    return "intent";
  }
  return "route";
}

/** Narrows a configured binding to the channel route form. */
export function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding {
  return normalizeBindingType(binding) === "route";
}

function isAcpBinding(binding: AgentBinding): binding is AgentAcpBinding {
  return normalizeBindingType(binding) === "acp";
}

/** Returns the configured binding list, treating missing/non-array config as empty. */
export function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

/** Lists channel route bindings, including legacy bindings without an explicit type. */
export function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[] {
  return listConfiguredBindings(cfg).filter(isRouteBinding);
}

/** Lists ACP conversation bindings only. */
export function listAcpBindings(cfg: OpenClawConfig): AgentAcpBinding[] {
  return listConfiguredBindings(cfg).filter(isAcpBinding);
}
