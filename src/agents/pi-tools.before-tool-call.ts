import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import {
  emitDiagnosticEvent,
  type DiagnosticToolParamsSummary,
} from "../infra/diagnostic-events.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import { PluginApprovalResolutions, type PluginApprovalResolution } from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { isPlainObject } from "../utils.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  loopDetection?: ToolLoopDetectionConfig;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");

// Hyperscribe envelope guard — fork patch (replaces legacy HTML template
// fingerprint guard, 2026-04-27).
//
// Blocks direct `write` of `.html` artifacts under output/. Forces the agent
// to use the JSON envelope → hyperscribe-render pipeline instead of hand-
// rolling inline CSS. The block reason includes the catalog component list
// so Kimi can compose a valid envelope on the retry without an extra Read.
const HYPERSCRIBE_GUARD_HEAD =
  "HTML write blocked. Direct .html authoring is disabled. Use the hyperscribe pipeline: (1) Write a JSON envelope to output/<topic>-<YYMMDD-HHMM>.envelope.json, (2) Bash: hyperscribe-render --in <envelope> --out <html> --mode auto, (3) MEDIA: <html>. The envelope is ~70% smaller than HTML and validates against a fixed catalog.";

// Catalog summary — kept inline so Kimi can compose envelopes from the block
// message alone, no Read required. Required props are precise — they match
// the schema validator at
// /home/self-made-orange/src/agent-outprint-skills/plugins/hyperscribe/spec/catalog.json.
// "?" suffix = optional. Items in arrays use { ... } notation for required
// fields per item.
const HYPERSCRIBE_CATALOG_SUMMARY = `Envelope skeleton (a2ui_version + catalog + is_task_complete + parts are all required at root):
{
  "a2ui_version": "0.9",
  "catalog": "hyperscribe/v1",
  "is_task_complete": true,
  "parts": [ { "component": "hyperscribe/Page", "props": { "title": "..." }, "children": [ ... ] } ]
}

Catalog (35 components, all in hyperscribe/v1 namespace, agent-outprint-skills source).
Format: ComponentName (REQUIRED PROPS | optional? props). Items in arrays show required item shape.

Structure
- Page (title | subtitle?, toc?). Exactly one Page per envelope, always at parts[0].
- Section (id, title | lead?). BOTH id AND title required — frequent miss.
- Heading (level [2|3|4], text | anchor?).
- Prose (markdown).

Media & emphasis
- Image (src, alt | caption?, width?, height?).
- Callout (severity [info|note|warn|success|danger], body | title?). body REQUIRED — not "text".
- KPICard (label, value | delta?, hint?).

Code
- CodeBlock (lang, code | filename?, highlight?).
- CodeDiff (filename, lang, hunks: [{before, after, atLine}]).
- AnnotatedCode (lang, code, annotations | filename?, pinStyle? [numbered|lettered]).

Diagrams
- Mermaid (kind [flowchart|sequence|er|state|mindmap|class], source | direction? [TD|LR]).
- Sequence (participants: [{id, title, subtitle?}], messages: [{from, to, text, kind?, over?}]).
- ArchitectureGrid (layout [grid|columns|layers], nodes: [{id, title, description, icon?, tag?}] | edges?: [{from, to, label?, style?}], groups?).
- FlowChart (layout [TD|LR], nodes: [{id, label, shape?, tag?}], edges: [{from, to, label?}], ranks: [[node_id, ...], ...]). ranks REQUIRED — array of arrays grouping same-rank node ids.
- Quadrant (xLabel, yLabel, quadrants: [{id, title, description}] | points?: [{label, x, y, tag?, tone?}]).
- Swimlane (lanes: [{id, title, subtitle?}], steps: [{id, lane, title, description?, tag?}] | edges?).
- ERDDiagram (entities, relationships | layout? [grid|columns]).

Data
- DataTable (columns: [{key, label, align?, wrap?}], rows: [{...keyed by columns[].key}] | caption?, footer?, density? [compact|standard]). Each column needs BOTH key AND label — frequent miss.
- Chart (kind [line|bar|pie|area|scatter], data | xLabel?, yLabel?, unit?).
- Comparison (items: [{title, subtitle?, bullets?, verdict?}], mode [vs|grid]). mode is "vs" or "grid" — not "side-by-side".

Narrative & files
- StepList (steps: [{title, body?, state? [done|doing|todo|skipped]}] | numbered? bool).
- FileTree (nodes | showIcons? bool, caption?).
- FileCard (name, responsibility | path?, loc?, exports?, state? [modified|added|removed|stable], icon?).

Slides (slide-mode only)
- SlideDeck (aspect [16:9|4:3] | transition? [none|fade|slide], footer?).
- Slide (layout [title|content|two-col|quote|image|section] | title?, subtitle?, bullets?, image?, quote?).

Site mode (10) — portfolio/landing/brand sites. Use SiteHeader as first child of chromeless Page, SiteFooter as last.
- SiteHeader (brand | brandHref?, links?, cta?). Sticky brand wordmark + nav + CTA pill.
- SiteFooter (columns | meta?, credit?). Multi-column link groups + meta + credit.
- HeroCarousel (slides | interval?, playReel?, lead?). Full-viewport rotating image carousel with '1/N' counter.
- EditorialStatement (text | eyebrow?, cta?). ~70vh massive centered text block. Brand statements.
- DivisionCard (title | eyebrow?, description?, image?, projects?, cta?). 4:5 portrait + linked projects. Place 3 in a Section for Studios/Productions/Touring layout.
- ProjectTile (title | image?, categories?, client?, year?, href?, aspect? [square|landscape|portrait|wide], span?, rowSpan?). Portfolio tile. Use inside MosaicGrid for varied sizing.
- MosaicGrid (children=required | columns?, gap?, rowHeight?, dense?). Audi F1-inspired tile grid (auto-flow dense). Children typically ProjectTile.
- WorkTypeRow (title | description?, image?, meta?, align? [left|right], cta?). Alternating image/body row. Use multiple in sequence.
- PressMentions (mentions | eyebrow?). Press/media credit row. Place between Divisions and Work sections.
- CountdownTimer (target | label?, liveLabel?). 4-cell live countdown (days/hours/minutes/seconds), switches to 'LIVE' at target.

Common pitfalls (top 5):
1. Callout uses "body" not "text".
2. Section requires BOTH "id" (string slug) AND "title".
3. DataTable.columns each need {"key": "...", "label": "..."}; rows are objects keyed by column.key.
4. Comparison.mode is "vs" or "grid" only — not "side-by-side".
5. hyperscribe-render REQUIRES --mode flag (auto|light|dark). Omitting → "Invalid mode null" exit 4.

Mapping examples:
- "A vs B 비교" → Page > Section + KPICard×N + Comparison(mode=vs) + Callout
- "프로필" → Page > KPICard×3 + Section + StepList + DataTable + Callout
- "트렌드 분석" → Page > Callout + Chart + Section + Prose + Callout
- "아키텍처" → Page > Mermaid OR ArchitectureGrid + FileCard×N + CodeBlock
- "코드 리뷰" → Page > Callout + CodeDiff×N + AnnotatedCode + Callout
- "프로세스" → Page > Swimlane OR FlowChart + StepList
- "포트폴리오 / 랜딩 / 사이트" → Page > SiteHeader + EditorialStatement + Section > MosaicGrid > ProjectTile×N + PressMentions + WorkTypeRow×N + SiteFooter`;

function buildHyperscribeBlockReason(targetPath: string): string {
  const envelopePath = targetPath.replace(/\.html$/i, ".envelope.json");
  return `${HYPERSCRIBE_GUARD_HEAD}

For this request, write to: ${envelopePath}
Then run: hyperscribe-render --in ${envelopePath} --out ${targetPath} --theme notion --mode auto --quiet

VISUALIZATION PLAN — make ONE pass over the content before composing the envelope:
1. Classify content type: Topology | Flow | Comparison | Evidence | Narrative. One should DOMINATE.
2. Pick the dominant visual surface FIRST. Defaults by content type:
   - Topology → ArchitectureGrid (cards + connectors) or Mermaid kind=er
   - Flow → Sequence (actor messages) | FlowChart (ranked pipeline) | Swimlane (lane × ownership)
   - Comparison → Comparison (side-by-side bullets) | Quadrant (2-axis positioning) | DataTable (exact rows)
   - Evidence → DataTable | FileTree | FileCard | KPICard
   - Narrative → StepList | Prose (sparingly)
3. Compose around the dominant surface. Do NOT default to Section+Prose+DataTable+Callout — that produces a flat textbook page.
4. Information density rule: prefer 1 dominant diagram > stacked Prose blocks. Repo/architecture/system explainers MUST include at least one of ArchitectureGrid, FlowChart, Swimlane, Sequence as dominant visual.
5. Avoid: stacking unrelated components for "variety", opening with a table when a diagram explains it faster, opening with long Prose when user asked for visual.

${HYPERSCRIBE_CATALOG_SUMMARY}`;
}

function readStringField(params: unknown, ...keys: string[]): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  for (const key of keys) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function checkHtmlTemplateGuard(
  toolName: string,
  params: unknown,
): { blocked: true; reason: string } | undefined {
  if (toolName !== "write") {
    return undefined;
  }
  const targetPath = readStringField(params, "path", "pathParam", "file_path", "filePath");
  if (!targetPath || !targetPath.toLowerCase().endsWith(".html")) {
    return undefined;
  }
  // Don't gate template authorship paths — agent may legitimately seed new
  // hyperscribe theme variants, README HTML, etc. Only the output artifact
  // path is policed.
  const lowerPath = targetPath.toLowerCase();
  if (lowerPath.includes("/_templates/") || lowerPath.includes("\\_templates\\")) {
    return undefined;
  }
  // Agents must write JSON envelopes (.envelope.json), not HTML. The renderer
  // produces the .html separately, in a Bash exec step that doesn't go
  // through this hook. So any direct .html write here is by definition the
  // agent trying to bypass the pipeline — block.
  return { blocked: true, reason: buildHyperscribeBlockReason(targetPath) };
}

const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./pi-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function mergeParamsWithApprovalOverrides(
  originalParams: unknown,
  approvalParams?: unknown,
): unknown {
  if (approvalParams && isPlainObject(approvalParams)) {
    if (isPlainObject(originalParams)) {
      return { ...originalParams, ...approvalParams };
    }
    return approvalParams;
  }
  return originalParams;
}

function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}

function unwrapErrorCause(err: unknown): unknown {
  if (err instanceof Error && err.cause !== undefined) {
    return err.cause;
  }
  return err;
}

function summarizeToolParams(params: unknown): DiagnosticToolParamsSummary {
  if (params === null) {
    return { kind: "null" };
  }
  if (params === undefined) {
    return { kind: "undefined" };
  }
  if (Array.isArray(params)) {
    return { kind: "array", length: params.length };
  }
  if (typeof params === "object") {
    return { kind: "object" };
  }
  if (typeof params === "string") {
    return { kind: "string", length: params.length };
  }
  if (typeof params === "number") {
    return { kind: "number" };
  }
  if (typeof params === "boolean") {
    return { kind: "boolean" };
  }
  return { kind: "other" };
}

function errorCategory(err: unknown): string {
  if (err instanceof Error && err.name.trim()) {
    return err.name;
  }
  return typeof err;
}

function diagnosticErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as { code?: unknown; status?: unknown; statusCode?: unknown };
  const code = candidate.code ?? candidate.status ?? candidate.statusCode;
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  if (typeof code !== "string") {
    return undefined;
  }
  const trimmed = code.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 64);
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  const htmlGuard = checkHtmlTemplateGuard(toolName, params);
  if (htmlGuard) {
    log.warn(`HTML template guard blocked ${toolName}: ${htmlGuard.reason.slice(0, 120)}`);
    return htmlGuard;
  }

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      }
      const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
      if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
        log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "warning",
          action: "warn",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.requireApproval) {
      const approval = hookResult.requireApproval;
      const safeOnResolution = (resolution: PluginApprovalResolution): void => {
        const onResolution = approval.onResolution;
        if (typeof onResolution !== "function") {
          return;
        }
        try {
          void Promise.resolve(onResolution(resolution)).catch((err) => {
            log.warn(`plugin onResolution callback failed: ${String(err)}`);
          });
        } catch (err) {
          log.warn(`plugin onResolution callback failed: ${String(err)}`);
        }
      };
      try {
        const requestResult: {
          id?: string;
          status?: string;
          decision?: string | null;
        } = await callGatewayTool(
          "plugin.approval.request",
          // Buffer beyond the approval timeout so the gateway can clean up
          // and respond before the client-side RPC timeout fires.
          { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
          {
            pluginId: approval.pluginId,
            title: approval.title,
            description: approval.description,
            severity: approval.severity,
            toolName,
            toolCallId: args.toolCallId,
            agentId: args.ctx?.agentId,
            sessionKey: args.ctx?.sessionKey,
            timeoutMs: approval.timeoutMs ?? 120_000,
            twoPhase: true,
          },
          { expectFinal: false },
        );
        const id = requestResult?.id;
        if (!id) {
          safeOnResolution(PluginApprovalResolutions.CANCELLED);
          return {
            blocked: true,
            reason: approval.description || "Plugin approval request failed",
          };
        }
        const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
          requestResult ?? {},
          "decision",
        );
        let decision: string | null | undefined;
        if (hasImmediateDecision) {
          decision = requestResult?.decision;
          if (decision === null) {
            safeOnResolution(PluginApprovalResolutions.CANCELLED);
            return {
              blocked: true,
              reason: "Plugin approval unavailable (no approval route)",
            };
          }
        } else {
          // Wait for the decision, but abort early if the agent run is cancelled
          // so the user isn't blocked for the full approval timeout.
          const waitPromise: Promise<{
            id?: string;
            decision?: string | null;
          }> = callGatewayTool(
            "plugin.approval.waitDecision",
            // Buffer beyond the approval timeout so the gateway can clean up
            // and respond before the client-side RPC timeout fires.
            { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
            { id },
          );
          let waitResult: { id?: string; decision?: string | null } | undefined;
          if (args.signal) {
            let onAbort: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
              if (args.signal!.aborted) {
                reject(args.signal!.reason);
                return;
              }
              onAbort = () => reject(args.signal!.reason);
              args.signal!.addEventListener("abort", onAbort, { once: true });
            });
            try {
              waitResult = await Promise.race([waitPromise, abortPromise]);
            } finally {
              if (onAbort) {
                args.signal.removeEventListener("abort", onAbort);
              }
            }
          } else {
            waitResult = await waitPromise;
          }
          decision = waitResult?.decision;
        }
        const resolution: PluginApprovalResolution =
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
          decision === PluginApprovalResolutions.DENY
            ? decision
            : PluginApprovalResolutions.TIMEOUT;
        safeOnResolution(resolution);
        if (
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS
        ) {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        if (decision === PluginApprovalResolutions.DENY) {
          return { blocked: true, reason: "Denied by user" };
        }
        const timeoutBehavior = approval.timeoutBehavior ?? "deny";
        if (timeoutBehavior === "allow") {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        return { blocked: true, reason: "Approval timed out" };
      } catch (err) {
        safeOnResolution(PluginApprovalResolutions.CANCELLED);
        if (isAbortSignalCancellation(err, args.signal)) {
          log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
          return {
            blocked: true,
            reason: "Approval cancelled (run aborted)",
          };
        }
        log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
        return {
          blocked: true,
          reason: "Plugin approval required (gateway unavailable)",
        };
      }
    }

    if (hookResult?.params) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params, hookResult.params),
      };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(err);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
    };
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
        signal,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      const eventBase = {
        ...(ctx?.runId && { runId: ctx.runId }),
        ...(ctx?.sessionKey && { sessionKey: ctx.sessionKey }),
        ...(ctx?.sessionId && { sessionId: ctx.sessionId }),
        ...(ctx?.trace && { trace: freezeDiagnosticTraceContext(ctx.trace) }),
        toolName: normalizedToolName,
        ...(toolCallId && { toolCallId }),
        paramsSummary: summarizeToolParams(outcome.params),
      };
      emitDiagnosticEvent({
        type: "tool.execution.started",
        ...eventBase,
      });
      const startedAt = Date.now();
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        emitDiagnosticEvent({
          type: "tool.execution.completed",
          ...eventBase,
          durationMs: Date.now() - startedAt,
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        const cause = unwrapErrorCause(err);
        const errorCode = diagnosticErrorCode(cause);
        emitDiagnosticEvent({
          type: "tool.execution.error",
          ...eventBase,
          durationMs: Date.now() - startedAt,
          errorCategory: errorCategory(cause),
          ...(errorCode ? { errorCode } : {}),
        });
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  mergeParamsWithApprovalOverrides,
  isPlainObject,
};
