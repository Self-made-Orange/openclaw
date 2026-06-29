/**
 * CLAW-FORK 2026-06-29: markdown pipe-table → Slack Block Kit `table` block.
 *
 * 봇들이 비교/요약 표를 정렬 유지하려고 마크다운 표(`| a | b |`)를 ``` 코드펜스
 * 안에 넣어 emit → Slack 은 monospace 코드로만 보여줌(진짜 표 X). 반복 사고.
 *
 * 이 모듈은 (1) 표만 담은 코드펜스를 unwrap 하고 (2) 본문의 마크다운 표를
 * 감지해 Slack `table` 블록으로 변환한다. 표가 아닌 코드(파이썬 등)·일반
 * 텍스트는 건드리지 않는다.
 */

interface TableConversion {
  text: string;
  blocks: unknown[];
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

// 구분선: `| --- | :--: |` 류 (셀이 -, :, 공백만).
function isSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(t);
}

function isRowLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 2;
}

// 한 텍스트 셀 → Slack rich_text 셀.
function cell(textValue: string, bold: boolean): unknown {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          {
            type: "text",
            text: textValue,
            ...(bold ? { style: { bold: true } } : {}),
          },
        ],
      },
    ],
  };
}

// header + body 행들 → Slack `table` 블록.
function buildTableBlock(header: string[], body: string[][]): unknown {
  const cols = header.length;
  const norm = (r: string[]): string[] => {
    const out = r.slice(0, cols);
    while (out.length < cols) out.push("");
    return out;
  };
  return {
    type: "table",
    rows: [
      header.map((c) => cell(c, true)),
      ...body.map((r) => norm(r).map((c) => cell(c, false))),
    ],
  };
}

// 코드펜스 내용이 "마크다운 표 뿐"이면 펜스만 벗긴다(내용은 그대로 표로 둠).
function unwrapTableFences(text: string): string {
  return text.replace(/```(?:\w+)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g, (match, body: string) => {
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (
      lines.length >= 2 &&
      isRowLine(lines[0]) &&
      isSeparator(lines[1]) &&
      lines.every(isRowLine)
    ) {
      return body; // 표만 든 펜스 → 펜스 제거, 표 본문만 남김
    }
    return match; // 그 외(코드 등) 그대로
  });
}

/**
 * 본문의 마크다운 표를 모두 찾아 Slack table 블록으로 변환하고, 표 텍스트는
 * 제거한다. 변환된 블록 배열과 표가 빠진 텍스트를 반환.
 */
export function convertMarkdownTables(text: string): TableConversion {
  if (!text || !text.includes("|")) return { text, blocks: [] };
  const pre = unwrapTableFences(text);
  const lines = pre.split(/\r?\n/);
  const outLines: string[] = [];
  const blocks: unknown[] = [];
  let i = 0;
  while (i < lines.length) {
    // 표 시작 후보: row + 다음 줄이 separator
    if (i + 1 < lines.length && isRowLine(lines[i]) && isSeparator(lines[i + 1])) {
      const header = splitRow(lines[i]);
      let j = i + 2;
      const body: string[][] = [];
      while (j < lines.length && isRowLine(lines[j]) && !isSeparator(lines[j])) {
        body.push(splitRow(lines[j]));
        j += 1;
      }
      // header 열이 ≥2 여야 표로 인정 (단일 파이프 오탐 방지)
      if (header.length >= 2) {
        blocks.push(buildTableBlock(header, body));
        // 표 자리에 빈 줄 하나(앞뒤 텍스트 분리 유지) — 연속 공백은 후처리 정리
        outLines.push("");
        i = j;
        continue;
      }
    }
    outLines.push(lines[i]);
    i += 1;
  }
  if (blocks.length === 0) return { text, blocks: [] };
  const strippedText = outLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: strippedText, blocks };
}
