/**
 * Mention Utilities
 *
 * Handles parsing and highlighting of @mentions and assistant references in text.
 * Provides centralized regex patterns and highlighting logic for consistent
 * mention handling across the application.
 */

import chalk from 'chalk';

/** Default color for mention highlights (#B1B9F9) */
export const DEFAULT_MENTION_COLOR = { r: 177, g: 185, b: 249 };

/** Mention type constants */
export const MENTION_TYPES = {
  SIMPLE: 'simple',
  ASSISTANT_REFERENCE: 'assistant_reference',
} as const;

/** Mention type union from constants */
export type MentionType = typeof MENTION_TYPES[keyof typeof MENTION_TYPES];

/** Regex patterns for matching different mention formats */
export const MENTION_PATTERNS = {
  SIMPLE: /@([\w-]+)/g, /** Matches @assistant-slug format */
  ASSISTANT_REFERENCE: /\[Assistant (@[\w-]+)\]/g, /** Matches [Assistant @slug] format */
  AT_START: /^@([\w-]+)\s+(.+)$/s, /** Matches @slug at start of message with content after */
} as const;

/** Represents a parsed mention in text */
export interface Mention {
  type: MentionType;
  slug: string;
  fullMatch: string;
  startIndex: number;
  endIndex: number;
}

/** Options for customizing mention highlighting */
export interface MentionHighlightOptions {
  color?: { r: number; g: number; b: number }; // Color for highlighting
  bold?: boolean;
  underline?: boolean;
}

/**
 * Parse all mentions from text
 * @param text - Text to parse for mentions
 * @returns Array of parsed mentions with metadata
 */
export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];

  // Parse [Assistant @slug] patterns using RegExp.exec()
  const assistantRefRegex = new RegExp(MENTION_PATTERNS.ASSISTANT_REFERENCE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = assistantRefRegex.exec(text)) !== null) {
    mentions.push({
      type: MENTION_TYPES.ASSISTANT_REFERENCE,
      slug: match[1].substring(1),
      fullMatch: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  const simpleMentionRegex = new RegExp(MENTION_PATTERNS.SIMPLE.source, 'g');

  while ((match = simpleMentionRegex.exec(text)) !== null) {
    // Check if this mention is already part of an assistant reference
    const isPartOfReference = mentions.some(
      m => match!.index >= m.startIndex && match!.index < m.endIndex
    );

    if (!isPartOfReference) {
      mentions.push({
        type: MENTION_TYPES.SIMPLE,
        slug: match[1],
        fullMatch: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  return mentions.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Check if text contains any mentions
 * @param text - Text to check
 * @returns True if text contains mentions
 */
export function hasMentions(text: string): boolean {
  return MENTION_PATTERNS.SIMPLE.test(text) || MENTION_PATTERNS.ASSISTANT_REFERENCE.test(text);
}

/**
 * Extract just the assistant slugs from mentions in text
 * @param text - Text to extract slugs from
 * @returns Array of assistant slugs (without @ prefix)
 */
export function extractMentionSlugs(text: string): string[] {
  const mentions = parseMentions(text);
  return mentions.map(m => m.slug);
}

/**
 * Apply highlight color to a single piece of text
 * @param text - Text to highlight
 * @param options - Highlighting options
 * @returns Highlighted text with ANSI color codes
 */
export function highlightMention(text: string, options?: MentionHighlightOptions): string {
  const color = options?.color || DEFAULT_MENTION_COLOR;
  let styled = chalk.rgb(color.r, color.g, color.b)(text);

  if (options?.bold) {
    styled = chalk.bold(styled);
  }

  if (options?.underline) {
    styled = chalk.underline(styled);
  }

  return styled;
}

/**
 * Highlight all mentions in text
 * @param text - Text containing mentions
 * @param options - Highlighting options
 * @returns Text with all mentions highlighted
 */
export function highlightMentionsInText(text: string, options?: MentionHighlightOptions): string {
  return text
    .replaceAll(MENTION_PATTERNS.ASSISTANT_REFERENCE, (match) => {
      return highlightMention(match, options);
    })
    .replaceAll(MENTION_PATTERNS.SIMPLE, (match) => {
      return highlightMention(match, options);
    });
}

/**
 * Parse @mention command format (@slug message content)
 * @param text - Text to parse
 * @returns Object with assistantSlug and message, or null if not a mention command
 */
export function parseAtMentionCommand(text: string): { assistantSlug: string; message: string } | null {
  const regex = new RegExp(MENTION_PATTERNS.AT_START.source, MENTION_PATTERNS.AT_START.flags);
  const match = regex.exec(text);

  if (!match) {
    return null;
  }

  return {
    assistantSlug: match[1],
    message: match[2],
  };
}
