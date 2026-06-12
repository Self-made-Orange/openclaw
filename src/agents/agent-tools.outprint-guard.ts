// Outprint envelope guard — fork patch, ported from pi-tools.before-tool-call.ts
// (upstream v2026.6.6 split that file into agent-tools.before-tool-call.*).
import { isPlainObject } from "../utils.js";

// Outprint envelope guard — fork patch (replaces legacy HTML template
// fingerprint guard, 2026-04-27).
//
// Blocks direct `write` of `.html` artifacts under output/. Forces the agent
// to use the JSON envelope → outprint-render pipeline instead of hand-
// rolling inline CSS. The block reason includes the catalog component list
// so Kimi can compose a valid envelope on the retry without an extra Read.
const OUTPRINT_GUARD_HEAD =
  "HTML write blocked. Direct .html authoring is disabled. Use the outprint pipeline: (1) Write a JSON envelope to output/<topic>-<YYMMDD-HHMM>.envelope.json, (2) Bash: outprint-render --in <envelope> --out <html> --mode auto, (3) MEDIA: <html>. The envelope is ~70% smaller than HTML and validates against a fixed catalog.";

// Catalog summary — kept inline so Kimi can compose envelopes from the block
// message alone, no Read required. Required props are precise — they match
// the schema validator at
// /home/self-made-orange/agent-outprint-skills/plugins/outprint/spec/catalog.json.
// "?" suffix = optional. Items in arrays use { ... } notation for required
// fields per item.
const OUTPRINT_CATALOG_SUMMARY = `Envelope skeleton (a2ui_version + catalog + is_task_complete + parts are all required at root):
{
  "a2ui_version": "0.9",
  "catalog": "outprint/v1",
  "is_task_complete": true,
  "parts": [ { "component": "outprint/Page", "props": { "title": "..." }, "children": [ ... ] } ]
}

Catalog (35 components, all in outprint/v1 namespace, agent-outprint-skills source).
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
5. outprint-render REQUIRES --mode flag (auto|light|dark). Omitting → "Invalid mode null" exit 4.

Mapping examples:
- "A vs B 비교" → Page > Section + KPICard×N + Comparison(mode=vs) + Callout
- "프로필" → Page > KPICard×3 + Section + StepList + DataTable + Callout
- "트렌드 분석" → Page > Callout + Chart + Section + Prose + Callout
- "아키텍처" → Page > Mermaid OR ArchitectureGrid + FileCard×N + CodeBlock
- "코드 리뷰" → Page > Callout + CodeDiff×N + AnnotatedCode + Callout
- "프로세스" → Page > Swimlane OR FlowChart + StepList
- "포트폴리오 / 랜딩 / 사이트" → Page > SiteHeader + EditorialStatement + Section > MosaicGrid > ProjectTile×N + PressMentions + WorkTypeRow×N + SiteFooter`;

function buildOutprintBlockReason(targetPath: string): string {
  const envelopePath = targetPath.replace(/\.html$/i, ".envelope.json");
  return `${OUTPRINT_GUARD_HEAD}

For this request, write to: ${envelopePath}
Then run: outprint-render --in ${envelopePath} --out ${targetPath} --theme notion --mode auto --quiet

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

${OUTPRINT_CATALOG_SUMMARY}`;
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

export function checkHtmlTemplateGuard(
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
  // outprint theme variants, README HTML, etc. Only the output artifact
  // path is policed.
  const lowerPath = targetPath.toLowerCase();
  if (lowerPath.includes("/_templates/") || lowerPath.includes("\\_templates\\")) {
    return undefined;
  }
  // Agents must write JSON envelopes (.envelope.json), not HTML. The renderer
  // produces the .html separately, in a Bash exec step that doesn't go
  // through this hook. So any direct .html write here is by definition the
  // agent trying to bypass the pipeline — block.
  return { blocked: true, reason: buildOutprintBlockReason(targetPath) };
}
