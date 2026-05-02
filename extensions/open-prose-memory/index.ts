import { definePluginEntry, type OpenClawPluginApi } from "./runtime-api.js";

export default definePluginEntry({
  id: "open-prose-memory",
  name: "OpenProse Memory",
  description: "Cross-session memory recall for opt-in OpenProse patterns (Hermes hybrid Phase 1).",
  register(_api: OpenClawPluginApi) {
    // Phase 1 scaffold — runtime hook wiring (onPatternComplete, recall helper
    // injection) lands once the SDK hook registration surface is finalized in
    // a follow-up commit on this branch.
  },
});
