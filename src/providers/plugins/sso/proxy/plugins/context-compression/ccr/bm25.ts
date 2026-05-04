/**
 * BM25 relevance scorer — zero dependencies, pure TypeScript.
 * Port of headroom/headroom/relevance/bm25.py
 */

export interface RelevanceScore {
  score: number;
  reason: string;
  matchedTerms: string[];
}

// Matches UUIDs, 4+ digit numeric IDs, and alphanumeric tokens — same as headroom.
const TOKEN_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b\d{4,}\b|[a-zA-Z0-9_]+/g;

function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(TOKEN_PATTERN);
  return matches ?? [];
}

function bm25Score(
  docTokens: string[],
  queryTokens: string[],
  avgDocLen?: number,
  k1 = 1.5,
  b = 0.75,
): [number, string[]] {
  if (docTokens.length === 0 || queryTokens.length === 0) return [0, []];

  const docLen = docTokens.length;
  const avgdl = avgDocLen ?? docLen;

  const docFreq = new Map<string, number>();
  for (const t of docTokens) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

  const queryFreq = new Map<string, number>();
  for (const t of queryTokens) queryFreq.set(t, (queryFreq.get(t) ?? 0) + 1);

  let score = 0;
  const matchedTerms: string[] = [];

  for (const [term, qf] of queryFreq) {
    const f = docFreq.get(term) ?? 0;
    if (f === 0) continue;

    matchedTerms.push(term);
    const idf = Math.log(2.0); // simplified IDF for single-doc case (same as headroom)
    const numerator = f * (k1 + 1);
    const denominator = f + k1 * (1 - b + b * (docLen / avgdl));
    score += idf * (numerator / denominator) * qf;
  }

  return [score, matchedTerms];
}

export class BM25Scorer {
  private readonly k1: number;
  private readonly b: number;
  private readonly maxScore: number;

  constructor(k1 = 1.5, b = 0.75, maxScore = 10.0) {
    this.k1 = k1;
    this.b = b;
    this.maxScore = maxScore;
  }

  score(item: string, context: string): RelevanceScore {
    const itemTokens = tokenize(item);
    const contextTokens = tokenize(context);
    const [rawScore, matched] = bm25Score(
      itemTokens,
      contextTokens,
      undefined,
      this.k1,
      this.b,
    );

    let normalized = Math.min(1.0, rawScore / this.maxScore);
    const longMatches = matched.filter(t => t.length >= 8);
    if (longMatches.length > 0) normalized = Math.min(1.0, normalized + 0.3);

    const reason =
      matched.length === 0
        ? 'BM25: no term matches'
        : matched.length === 1
          ? `BM25: matched '${matched[0]}'`
          : `BM25: matched ${matched.length} terms (${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '...' : ''})`;

    return { score: normalized, reason, matchedTerms: matched.slice(0, 10) };
  }

  scoreBatch(items: string[], context: string): RelevanceScore[] {
    const contextTokens = tokenize(context);
    if (contextTokens.length === 0) {
      return items.map(() => ({ score: 0, reason: 'BM25: empty context', matchedTerms: [] }));
    }

    const allTokens = items.map(tokenize);
    const totalLen = allTokens.reduce((s, t) => s + t.length, 0);
    const avgLen = totalLen / Math.max(items.length, 1);

    return allTokens.map(itemTokens => {
      const [rawScore, matched] = bm25Score(itemTokens, contextTokens, avgLen, this.k1, this.b);
      let normalized = Math.min(1.0, rawScore / this.maxScore);
      if (matched.some(t => t.length >= 8)) normalized = Math.min(1.0, normalized + 0.3);

      const reason =
        matched.length === 0 ? 'BM25: no matches' : `BM25: ${matched.length} terms`;

      return { score: normalized, reason, matchedTerms: matched.slice(0, 5) };
    });
  }
}

export function createBM25Scorer(): BM25Scorer {
  return new BM25Scorer();
}
