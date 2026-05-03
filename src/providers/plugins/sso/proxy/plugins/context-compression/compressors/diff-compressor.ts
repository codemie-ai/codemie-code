import { Compressor, CompressionResult } from './types.js';
import { Tokenizer } from '../tokenizer/tiktoken.js';

export interface DiffCompressorConfig {
  maxContextLines: number;
  maxHunksPerFile: number;
  maxFiles: number;
  minLinesForCompression: number;
}

interface DiffHunk {
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
  contextLines: number;
  score: number;
}

interface DiffFile {
  header: string;
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  isRenamed: boolean;
  renameLines: string[];
}

const DEFAULT_CONFIG: DiffCompressorConfig = {
  maxContextLines: 2,
  maxHunksPerFile: 10,
  maxFiles: 20,
  minLinesForCompression: 50,
};

const PRIORITY_PATTERNS = [
  /\b(error|exception|fail(?:ed|ure)?|fatal|critical|crash|panic)\b/i,
  /\b(important|note|todo|fixme|hack|xxx|bug|fix)\b/i,
  /\b(security|auth|password|secret|token)\b/i,
];

function parseDiff(lines: string[]): { preDiffLines: string[]; files: DiffFile[] } {
  const preDiffLines: string[] = [];
  const files: DiffFile[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let inPreDiff = true;

  for (const line of lines) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('diff --combined ') ||
      line.startsWith('diff --cc ')
    ) {
      inPreDiff = false;
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      currentFile = {
        header: line,
        oldFile: '',
        newFile: '',
        hunks: [],
        isBinary: false,
        isNewFile: false,
        isDeletedFile: false,
        isRenamed: false,
        renameLines: [],
      };
      files.push(currentFile);
      continue;
    }

    if (inPreDiff) {
      preDiffLines.push(line);
      continue;
    }

    if (currentFile === null) {
      preDiffLines.push(line);
      continue;
    }

    if (line.startsWith('new file mode')) {
      currentFile.isNewFile = true;
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      currentFile.isDeletedFile = true;
      continue;
    }

    if (
      line.startsWith('rename ') ||
      line.startsWith('similarity ') ||
      line.startsWith('copy ') ||
      line.startsWith('dissimilarity ')
    ) {
      currentFile.isRenamed = true;
      currentFile.renameLines.push(line);
      continue;
    }

    if (line.startsWith('Binary files') && line.includes('differ')) {
      currentFile.isBinary = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      currentFile.oldFile = line;
      continue;
    }

    if (line.startsWith('+++ ')) {
      currentFile.newFile = line;
      continue;
    }

    if (line.startsWith('@@ ') || line.startsWith('@@@ ')) {
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }
      currentHunk = {
        header: line,
        lines: [],
        additions: 0,
        deletions: 0,
        contextLines: 0,
        score: 0,
      };
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.additions++;
        currentHunk.lines.push(line);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.deletions++;
        currentHunk.lines.push(line);
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.contextLines++;
        currentHunk.lines.push(line);
      } else {
        currentHunk.lines.push(line);
      }
    }
  }

  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }

  return { preDiffLines, files };
}

function scoreHunks(files: DiffFile[], context: string): void {
  const contextWords = context
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  for (const file of files) {
    for (const hunk of file.hunks) {
      const hunkContent = hunk.lines.join('\n').toLowerCase();
      let score = Math.min(0.3, (hunk.additions + hunk.deletions) * 0.03);

      for (const word of contextWords) {
        if (hunkContent.includes(word)) {
          score += 0.2;
        }
      }

      for (const pattern of PRIORITY_PATTERNS) {
        if (pattern.test(hunkContent)) {
          score += 0.3;
          break;
        }
      }

      hunk.score = Math.min(1.0, score);
    }
  }
}

function selectFiles(files: DiffFile[], maxFiles: number): DiffFile[] {
  if (files.length <= maxFiles) {
    return files;
  }
  return [...files]
    .sort((a, b) => {
      const totalA = a.hunks.reduce((s, h) => s + h.additions + h.deletions, 0);
      const totalB = b.hunks.reduce((s, h) => s + h.additions + h.deletions, 0);
      return totalB - totalA;
    })
    .slice(0, maxFiles);
}

function getHunkStartLine(hunk: DiffHunk): number {
  const match = hunk.header.match(/@+\s+-\d+(?:,\d+)?\s+\+(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function selectHunks(hunks: DiffHunk[], maxPerFile: number): DiffHunk[] {
  if (hunks.length <= maxPerFile) {
    return hunks;
  }

  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  const middle = hunks.slice(1, -1);

  const topMiddle = [...middle]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPerFile - 2);

  const kept = [first, ...topMiddle, last];
  return kept.sort((a, b) => getHunkStartLine(a) - getHunkStartLine(b));
}

function reduceContext(hunk: DiffHunk, maxContext: number): DiffHunk {
  const lines = hunk.lines;
  const changeIndices = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')))
    .map(({ i }) => i);

  if (changeIndices.length === 0) {
    return {
      ...hunk,
      lines: lines.slice(0, Math.min(maxContext, lines.length)),
    };
  }

  const keepSet = new Set<number>();
  for (const pos of changeIndices) {
    const start = Math.max(0, pos - maxContext);
    const end = pos + maxContext;
    for (let i = start; i <= end && i < lines.length; i++) {
      keepSet.add(i);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('\\')) {
      keepSet.add(i);
    }
  }

  const trimmedLines = lines.filter((_, i) => keepSet.has(i));
  return { ...hunk, lines: trimmedLines };
}

function formatOutput(
  preDiffLines: string[],
  files: DiffFile[],
  filesAffected: number,
  totalAdditions: number,
  totalDeletions: number,
  hunksRemoved: number,
): string {
  const parts: string[] = [];

  if (preDiffLines.length > 0) {
    parts.push(...preDiffLines);
  }

  for (const file of files) {
    parts.push(file.header);

    for (const renameLine of file.renameLines) {
      parts.push(renameLine);
    }

    if (file.isNewFile) {
      parts.push('new file mode 100644');
    }

    if (file.isDeletedFile) {
      parts.push('deleted file mode 100644');
    }

    if (file.isBinary) {
      parts.push('Binary files differ');
      continue;
    }

    if (file.oldFile) {
      parts.push(file.oldFile);
    }

    if (file.newFile) {
      parts.push(file.newFile);
    }

    for (const hunk of file.hunks) {
      parts.push(hunk.header);
      parts.push(...hunk.lines);
    }
  }

  if (hunksRemoved > 0 || filesAffected > 0) {
    let footer = `[${filesAffected} files changed, +${totalAdditions} -${totalDeletions} lines`;
    if (hunksRemoved > 0) {
      footer += `, ${hunksRemoved} hunks omitted`;
    }
    footer += ']';
    parts.push(footer);
  }

  return parts.join('\n');
}

export class DiffCompressor implements Compressor {
  constructor(
    private tokenizer: Tokenizer,
    private config: DiffCompressorConfig = DEFAULT_CONFIG,
  ) {}

  async compress(content: string, contextHint = ''): Promise<CompressionResult> {
    const originalTokens = await this.tokenizer.countText(content);

    const lines = content.split('\n');
    if (lines.length < this.config.minLinesForCompression) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    const { preDiffLines, files } = parseDiff(lines);
    if (files.length === 0) {
      return { compressed: content, originalTokens, compressedTokens: originalTokens, compressionRatio: 1.0 };
    }

    scoreHunks(files, contextHint);
    const cappedFiles = selectFiles(files, this.config.maxFiles);

    let totalAdditions = 0;
    let totalDeletions = 0;
    let hunksRemoved = 0;

    for (const file of cappedFiles) {
      totalAdditions += file.hunks.reduce((s, h) => s + h.additions, 0);
      totalDeletions += file.hunks.reduce((s, h) => s + h.deletions, 0);
      const originalHunkCount = file.hunks.length;
      const selected = selectHunks(file.hunks, this.config.maxHunksPerFile);
      hunksRemoved += originalHunkCount - selected.length;
      file.hunks = selected.map(h => reduceContext(h, this.config.maxContextLines));
    }

    const compressed = formatOutput(
      preDiffLines,
      cappedFiles,
      cappedFiles.length,
      totalAdditions,
      totalDeletions,
      hunksRemoved,
    );
    const compressedTokens = await this.tokenizer.countText(compressed);

    return {
      compressed,
      originalTokens,
      compressedTokens,
      compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 1.0,
    };
  }
}

export function createDiffCompressor(tokenizer: Tokenizer, config?: Partial<DiffCompressorConfig>): DiffCompressor {
  return new DiffCompressor(tokenizer, { ...DEFAULT_CONFIG, ...config });
}
