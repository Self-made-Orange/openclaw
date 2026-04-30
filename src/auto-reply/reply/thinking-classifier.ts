// CLAW-FORK: per-message thinking complexity classifier.
//
// Kimi K2.6 charges per-token regardless of thinking, but thinking-on inflates
// completion_tokens 5~50x for trivial questions (verified curl test 2026-04-26:
// "What is 2+2?" → 200 tokens with thinking, 4 without). For our chatbot most
// messages are simple lookups / greetings / tool questions where thinking is
// pure waste. But for multi-step reasoning, code review, analytical comparison,
// thinking meaningfully improves answer quality.
//
// This classifier picks "low" (= thinking on) for messages that look complex
// and "off" otherwise. Result is injected as the auto-default in
// get-reply-directives.ts, sitting between explicit user directive (highest
// priority) and the model's static default (lowest).
//
// Scope: only applied to moonshot kimi-k2.x. Other providers handle their own
// thinking conventions.

import { logVerbose } from "../../globals.js";

type ClawThinkLevel = "off" | "low" | "high" | "max" | "adaptive";

const COMPLEX_PATTERNS: RegExp[] = [
  // Korean reasoning keywords
  /(왜|이유|원인|분석|비교|차이점?|근거|추론|판단|평가|검토|논리|결론|시나리오|영향|효과)/,
  /(어떻게.*해야|어떻게.*되[ㄴ는]|어떤.*점에서|뭐가.*다른|뭐가.*맞)/,
  // English reasoning
  /\b(why|reason|cause|analy[sz]e|analy[sz]is|compare|comparison|because|therefore|hence|reasoning|implication|trade[\s-]?offs?|root\s*cause)\b/i,
  // Code / architecture
  /(코드|코딩|디버그|디버깅|스택|에러|예외|구현|아키텍처|구조|리팩토[링]?)/,
  /\b(refactor|architecture|debug|implement|stack\s*trace|exception|big[\s-]?O|complexity|scalab|race\s*condition|deadlock)\b/i,
  /\b(typescript|javascript|python|rust|golang|kotlin|swift|java\b|sql|graphql|terraform|kubernetes|docker)\b/i,
  // Multi-step / planning
  /(단계별|step[\s-]?by[\s-]?step|first.*then|먼저.*그.?다음|after\s+that)/i,
  // Math / data
  /(\d+\s*[+\-×÷*\/]\s*\d+)/, // explicit math
  /\b(n\s*=\s*\d|x\s*=|y\s*=|f\([^)]+\))/, // variable / function
  /(\d+\s*%|\d+\s*개\s*중|\d+\s*년\s*안에)/, // statistical / ratio
  // Two wh-questions in one
  /(왜.*어떻게|어떻게.*왜|why.*how|how.*why)/i,
  // Decision / recommendation
  /(추천해|recommend|어떤\s*걸\s*골|뭘\s*골|골라줘|선택해)/i,
];

const SIMPLE_PATTERNS: RegExp[] = [
  // Greetings
  /^\s*(안녕|hello|hi\b|hey\b|반가|좋은\s*아침|좋은\s*저녁|굿모|굿이브닝)/i,
  // Acks / yes-no
  /^\s*(네\b|예\b|아니[요오]?\b|ㅇㅋ|ok\b|okay|yes\b|no\b|sure\b|nope\b|nah\b|ㅇㅇ|ㄴㄴ|ㄱㄱ|ㄱㄴ)/i,
  // Thanks
  /(고마워|고맙|감사|thank|thanks|thx|ty\b)/i,
];

// Lookup-style — usually answerable from cached knowledge or a single tool call.
const LOOKUP_PATTERNS: RegExp[] = [
  /(어떻게\s*돌려|어떻게\s*실행|어떻게\s*시작|how\s*to\s*run|how\s*do\s*i\s*run|where\s*is)/i,
  /(뭐야\??$|뭐임\??$|이거\s*뭐|이게\s*뭐|뭔지\s*알아|what\s*is)/i,
  /(언제\??$|when\s*is)/i,
];

/**
 * Classify a user message and return a thinking level hint for moonshot/kimi-k2.x.
 *
 * - "low"     : message looks complex; thinking ON.
 * - "off"     : message looks simple; thinking OFF.
 * - undefined : not applicable (other provider, or ambiguous).
 *
 * Returning undefined lets the existing default chain take over.
 */
export function classifyMessageComplexity(params: {
  text: string;
  provider: string;
  model: string;
}): ClawThinkLevel | undefined {
  if (params.provider !== "moonshot") return undefined;
  if (!params.model.toLowerCase().startsWith("kimi-k2")) return undefined;

  const raw = params.text ?? "";
  const text = raw.trim();
  if (!text) return undefined;

  // Hard simple cases — short greetings/acks/thanks. Force off.
  if (text.length <= 25 && SIMPLE_PATTERNS.some((re) => re.test(text))) {
    logVerbose(`[claw-debug] thinking-classifier: simple greeting/ack → off`);
    return "off";
  }

  // Very long messages almost always warrant thinking.
  if (text.length > 400) {
    logVerbose(`[claw-debug] thinking-classifier: long (${text.length} chars) → on`);
    return "low";
  }

  // Complex pattern match wins next.
  for (const re of COMPLEX_PATTERNS) {
    if (re.test(text)) {
      logVerbose(`[claw-debug] thinking-classifier: complex match (${re}) → on`);
      return "low";
    }
  }

  // Lookup-style — keep thinking off.
  if (LOOKUP_PATTERNS.some((re) => re.test(text))) {
    logVerbose(`[claw-debug] thinking-classifier: lookup style → off`);
    return "off";
  }

  // Ambiguous — let the default chain decide.
  return undefined;
}
