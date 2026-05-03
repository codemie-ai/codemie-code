export const DIFF_HEADER_PATTERN =
  /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/;
export const DIFF_CHANGE_PATTERN = /^[+-][^+-]/;

export interface DiffInfo {
  fileCount: number;
  hunkCount: number;
  additions: number;
  deletions: number;
}

export function isUnifiedDiff(content: string): boolean {
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
    return false;
  }
  const confidence = Math.min(1.0, 0.5 + headerMatches * 0.2 + changeMatches * 0.05);
  return confidence >= 0.7;
}

export function parseDiffInfo(content: string): DiffInfo {
  const lines = content.split('\n');
  let fileCount = 0;
  let hunkCount = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      fileCount++;
    } else if (/^@@/.test(line)) {
      hunkCount++;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }
  return { fileCount, hunkCount, additions, deletions };
}
