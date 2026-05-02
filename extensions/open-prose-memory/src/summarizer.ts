/**
 * Async post-session summarizer. Compacts a finished session transcript into
 * a recall-ready summary that gets stored in `sessions.db`.
 *
 * Phase 1 scaffold — interface only. Real summarizer adapter (Sonnet by
 * default) lands once the model selection plumbing for memory-plugin tasks
 * is decided.
 */

export interface SummarizerInput {
  agentId: string;
  sessionId: string;
  transcript: string;
  /** ISO 8601 UTC of session end. */
  ts: string;
  /** Optional model override. Defaults to plugin config `summarizerModel`. */
  model?: string;
}

export interface SummarizerOutput {
  summary: string;
  /** Token usage of the compaction call itself. */
  tokenUsage: { input: number; output: number };
}

export type Summarizer = (input: SummarizerInput) => Promise<SummarizerOutput>;

/**
 * Pass-through summarizer: returns the first 1000 characters of the transcript
 * as the summary. Useful for tests and as a no-LLM fallback while the real
 * adapter is being implemented.
 */
export const passthroughSummarizer: Summarizer = async (input) => ({
  summary: input.transcript.slice(0, 1000),
  tokenUsage: { input: 0, output: 0 },
});
