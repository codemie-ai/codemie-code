export function computeOptimalK(
  items: string[],
  bias: number = 1.0,
  minK: number = 1,
  maxK?: number,
): number {
  if (items.length === 0) return 0;

  const n = items.length;
  const effectiveMaxK = Math.min(maxK ?? n, n);
  const effectiveMinK = Math.max(1, Math.min(minK, effectiveMaxK));

  const seenBigrams = new Set<string>();
  const coverage: number[] = [];
  let totalBigrams = 0;

  for (const item of items) {
    const words = item.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]}\x00${words[i + 1]}`;
      if (!seenBigrams.has(bigram)) {
        seenBigrams.add(bigram);
        totalBigrams++;
      }
    }
    coverage.push(totalBigrams);
  }

  if (totalBigrams === 0) return effectiveMinK;

  const normCoverage = coverage.map(c => c / totalBigrams);
  const logMaxK = Math.log1p(effectiveMaxK);

  let knee = effectiveMinK;
  let bestValue = -Infinity;

  for (let k = effectiveMinK; k <= effectiveMaxK; k++) {
    const idx = k - 1;
    const gain = idx < normCoverage.length ? normCoverage[idx] : 1.0;
    const cost = Math.log1p(k) / logMaxK;
    const value = gain - cost / bias;
    if (value > bestValue) {
      bestValue = value;
      knee = k;
    }
  }

  return knee;
}

export function truncateToBudget(
  items: string[],
  tokenBudget: number,
  tokensPerItem: (item: string) => number = (item) => Math.ceil(item.length / 4),
): string[] {
  const result: string[] = [];
  let used = 0;

  for (const item of items) {
    const cost = tokensPerItem(item);
    if (used + cost > tokenBudget) break;
    result.push(item);
    used += cost;
  }

  return result;
}
