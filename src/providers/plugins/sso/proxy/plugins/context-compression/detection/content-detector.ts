export enum ContentType {
  JSON_ARRAY = 'json_array',
  SOURCE_CODE = 'source_code',
  SEARCH_RESULTS = 'search',
  BUILD_OUTPUT = 'build',
  GIT_DIFF = 'diff',
  HTML = 'html',
  PLAIN_TEXT = 'text',
}

export interface DetectionResult {
  contentType: ContentType;
  confidence: number;
  metadata: Record<string, unknown>;
}

import { DIFF_HEADER_PATTERN, DIFF_CHANGE_PATTERN } from './unidiff-detector.js';

const SEARCH_RESULT_PATTERN = /^[^\s:]+:\d+:/;
const LOG_PATTERNS: RegExp[] = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^={3,}|^-{3,}/,
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/,
  /^npm ERR!|^yarn error|^cargo error/,
  /Traceback \(most recent call last\)/,
  /^\s*at\s+[\w.$]+\(/,
];

const CODE_PATTERNS: Record<string, RegExp[]> = {
  python: [
    /^\s*(def|class|import|from|async def)\s+\w+/,
    /^\s*@\w+/,
    /^\s*"""/,
    /^\s*if __name__\s*==/,
  ],
  javascript: [
    /^\s*(function|const|let|var|class|import|export)\s+/,
    /^\s*(async\s+function|=>\s*\{)/,
    /^\s*module\.exports/,
  ],
  typescript: [
    /^\s*(interface|type|enum|namespace)\s+\w+/,
    /:\s*(string|number|boolean|any|void)\b/,
  ],
  go: [
    /^\s*(func|type|package|import)\s+/,
    /^\s*func\s+\([^)]+\)\s+\w+/,
  ],
  rust: [
    /^\s*(fn|struct|enum|impl|mod|use|pub)\s+/,
    /^\s*#\[/,
  ],
  java: [
    /^\s*(public|private|protected)\s+(class|interface|enum)/,
    /^\s*@\w+/,
    /^\s*package\s+[\w.]+;/,
  ],
};

function tryDetectJson(content: string): DetectionResult | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const isDictArray = parsed.length > 0 && parsed.every(item => typeof item === 'object' && item !== null && !Array.isArray(item));
      if (isDictArray) {
        return { contentType: ContentType.JSON_ARRAY, confidence: 1.0, metadata: { item_count: parsed.length, is_dict_array: true } };
      }
      return { contentType: ContentType.JSON_ARRAY, confidence: 0.8, metadata: { item_count: parsed.length, is_dict_array: false } };
    }
  } catch {
    // not valid JSON — fall through
  }
  return null;
}

function tryDetectDiff(content: string): DetectionResult | null {
  const lines = content.split('\n').slice(0, 500);
  let headerMatches = 0;
  let changeMatches = 0;
  for (const line of lines) {
    if (DIFF_HEADER_PATTERN.test(line)) {
      headerMatches++;
    }
    if (DIFF_CHANGE_PATTERN.test(line)) {
      changeMatches++;
    }
  }
  if (headerMatches === 0) {
    return null;
  }
  const confidence = Math.min(1.0, 0.5 + headerMatches * 0.2 + changeMatches * 0.05);
  return { contentType: ContentType.GIT_DIFF, confidence, metadata: { header_matches: headerMatches, change_lines: changeMatches } };
}

function tryDetectHtml(content: string): DetectionResult | null {
  const sample = content.slice(0, 3000);
  const hasDoctype = /^\s*<!doctype\s+html/i.test(sample);
  const hasHtmlTag = /<html[\s>]/i.test(sample);
  const hasHead = /<head[\s>]/i.test(sample);
  const hasBody = /<body[\s>]/i.test(sample);
  const structuralMatches = (sample.match(/<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi) ?? []).length;

  if (!hasDoctype && !hasHtmlTag && structuralMatches < 3) {
    return null;
  }

  let confidence = 0.0;
  if (hasDoctype) confidence += 0.5;
  if (hasHtmlTag) confidence += 0.3;
  if (hasHead) confidence += 0.1;
  if (hasBody) confidence += 0.1;
  confidence += Math.min(0.3, structuralMatches * 0.03);
  confidence = Math.min(1.0, confidence);

  if (confidence < 0.5) {
    return null;
  }
  return { contentType: ContentType.HTML, confidence, metadata: { has_doctype: hasDoctype, has_html_tag: hasHtmlTag, structural_tags: structuralMatches } };
}

function tryDetectSearch(content: string): DetectionResult | null {
  const lines = content.split('\n').slice(0, 100);
  const matchingLines = lines.filter(line => line.trim() && SEARCH_RESULT_PATTERN.test(line)).length;
  if (matchingLines === 0) {
    return null;
  }
  const nonEmpty = lines.filter(line => line.trim()).length;
  if (nonEmpty === 0 || matchingLines / nonEmpty < 0.3) {
    return null;
  }
  const ratio = matchingLines / nonEmpty;
  const confidence = Math.min(1.0, 0.4 + ratio * 0.6);
  return { contentType: ContentType.SEARCH_RESULTS, confidence, metadata: { matching_lines: matchingLines, total_lines: nonEmpty } };
}

function tryDetectLog(content: string): DetectionResult | null {
  const lines = content.split('\n').slice(0, 200);
  let patternMatches = 0;
  let errorMatches = 0;
  for (const line of lines) {
    for (let i = 0; i < LOG_PATTERNS.length; i++) {
      if (LOG_PATTERNS[i].test(line)) {
        patternMatches++;
        if (i < 2) {
          errorMatches++;
        }
        break;
      }
    }
  }
  const nonEmpty = lines.filter(line => line.trim()).length;
  if (nonEmpty === 0 || patternMatches === 0 || patternMatches / nonEmpty < 0.1) {
    return null;
  }
  const ratio = patternMatches / nonEmpty;
  const confidence = Math.min(1.0, 0.3 + ratio * 0.5 + errorMatches * 0.05);
  return { contentType: ContentType.BUILD_OUTPUT, confidence, metadata: { pattern_matches: patternMatches, error_matches: errorMatches, total_lines: nonEmpty } };
}

function tryDetectCode(content: string): DetectionResult | null {
  const lines = content.split('\n').slice(0, 100);
  const languageScores: Record<string, number> = {};
  for (const line of lines) {
    for (const [lang, patterns] of Object.entries(CODE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          languageScores[lang] = (languageScores[lang] ?? 0) + 1;
          break;
        }
      }
    }
  }
  if (Object.keys(languageScores).length === 0) {
    return null;
  }
  const bestLang = Object.keys(languageScores).reduce((a, b) =>
    (languageScores[a] ?? 0) > (languageScores[b] ?? 0) ? a : b
  );
  const bestScore = languageScores[bestLang] ?? 0;
  if (bestScore < 3) {
    return null;
  }
  const nonEmpty = lines.filter(line => line.trim()).length;
  const ratio = bestScore / Math.max(nonEmpty, 1);
  const confidence = Math.min(1.0, 0.4 + ratio * 0.4 + bestScore * 0.02);
  return { contentType: ContentType.SOURCE_CODE, confidence, metadata: { language: bestLang, pattern_matches: bestScore } };
}

export function detectContentType(content: string): DetectionResult {
  if (!content || !content.trim()) {
    return { contentType: ContentType.PLAIN_TEXT, confidence: 0.0, metadata: {} };
  }

  const jsonResult = tryDetectJson(content);
  if (jsonResult) {
    return jsonResult;
  }

  const diffResult = tryDetectDiff(content);
  if (diffResult && diffResult.confidence >= 0.7) {
    return diffResult;
  }

  const htmlResult = tryDetectHtml(content);
  if (htmlResult && htmlResult.confidence >= 0.7) {
    return htmlResult;
  }

  const searchResult = tryDetectSearch(content);
  if (searchResult && searchResult.confidence >= 0.6) {
    return searchResult;
  }

  const logResult = tryDetectLog(content);
  if (logResult && logResult.confidence >= 0.5) {
    return logResult;
  }

  const codeResult = tryDetectCode(content);
  if (codeResult && codeResult.confidence >= 0.5) {
    return codeResult;
  }

  return { contentType: ContentType.PLAIN_TEXT, confidence: 0.5, metadata: {} };
}
