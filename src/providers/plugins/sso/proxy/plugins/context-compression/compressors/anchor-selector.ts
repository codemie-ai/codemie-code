function scoreLine(line: string, index: number, total: number): number {
  const stripped = line.trim();
  if (!stripped) return 0.0;

  let score = 0.0;

  if (index === 0 || index === total - 1) {
    score += 0.3;
  }

  if (stripped.length < 60) {
    score += 0.2;
  }

  if (/^(#{1,3}|-|\*|\+)/.test(stripped)) {
    score += 0.2;
  }

  const keywords = ['error', 'warning', 'failed', 'success', 'result', 'total', 'summary', 'note', 'important'];
  const low = stripped.toLowerCase();
  for (const kw of keywords) {
    if (low.includes(kw)) {
      score += 0.15;
      break;
    }
  }

  return Math.min(1.0, score);
}

function selectByKnee(
  scores: number[],
  bias: number,
  minK: number,
  maxK: number,
): number[] {
  if (scores.length === 0) return [];

  const sorted = scores
    .map((s, i) => [i, s] as [number, number])
    .sort((a, b) => b[1] - a[1]);

  const n = sorted.length;
  const effectiveMaxK = Math.min(maxK, n);

  let knee = minK;
  let bestDrop = -1.0;

  for (let k = minK; k < effectiveMaxK; k++) {
    if (k + 1 >= n) break;
    const drop = sorted[k][1] - sorted[k + 1][1];
    const adjusted = drop * (1.0 + bias * Math.log1p(k));
    if (adjusted > bestDrop) {
      bestDrop = adjusted;
      knee = k + 1;
    }
  }

  return sorted.slice(0, knee).map(([idx]) => idx).sort((a, b) => a - b);
}

export function selectAnchors(
  lines: string[],
  bias: number = 1.0,
  minAnchors: number = 1,
  maxAnchors?: number,
): number[] {
  if (lines.length === 0) return [];

  const scores = lines.map((line, i) => scoreLine(line, i, lines.length));
  const effectiveMaxAnchors = maxAnchors ?? lines.length;

  return selectByKnee(scores, bias, minAnchors, effectiveMaxAnchors);
}
