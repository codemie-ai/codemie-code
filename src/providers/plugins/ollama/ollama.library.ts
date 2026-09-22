/**
 * Ollama Library Search
 *
 * Ollama has no public JSON API for its model library - only the
 * server-rendered HTML pages at ollama.com/search and
 * ollama.com/library/<model>/tags. This scrapes those pages so the setup
 * wizard can offer live search instead of the narrow static/cloud-catalog
 * list in ollama.models.ts. Unofficial by nature: any parse failure must be
 * treated as non-fatal by callers (they fall back to manual entry).
 */

import { HTTPClient } from '../../core/base/http-client.js';

const OLLAMA_WEB_BASE_URL = 'https://ollama.com';
const MAX_SEARCH_RESULTS = 15;

const client = new HTTPClient({ timeout: 10000 });

export interface OllamaLibraryModel {
  name: string;
  description?: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Search Ollama's model library (ollama.com/search).
 * Returns base model names (no tag) in the page's own order (popular first).
 */
export async function searchOllamaLibrary(query: string): Promise<OllamaLibraryModel[]> {
  const url = `${OLLAMA_WEB_BASE_URL}/search?q=${encodeURIComponent(query)}`;
  const response = await client.getRaw(url);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Ollama library search failed: HTTP ${response.statusCode}`);
  }

  const results: OllamaLibraryModel[] = [];
  const seen = new Set<string>();

  // Each result is an <li> card containing a `/library/<slug>` link followed
  // by an <h2> title and a <p> description. Base model links never contain
  // ":" (tag links do), so filtering on that distinguishes result cards from
  // any tag references elsewhere on the page.
  const cardPattern = /href="\/library\/([a-zA-Z0-9._-]+)"[\s\S]{0,600}?<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;

  while ((match = cardPattern.exec(response.data)) && results.length < MAX_SEARCH_RESULTS) {
    const [, slug, rawDescription] = match;
    if (slug.includes(':') || seen.has(slug)) {
      continue;
    }
    seen.add(slug);

    const description = decodeHtmlEntities(rawDescription.replace(/<[^>]+>/g, ''));
    results.push({ name: slug, description: description || undefined });
  }

  if (results.length === 0) {
    throw new Error(`No parsable results for "${query}" - ollama.com's page structure may have changed`);
  }

  return results;
}

/**
 * List the installable tags/variants for a model (ollama.com/library/<model>/tags).
 * ":latest" (or the bare model id when no ":latest" tag exists) is returned first.
 */
export async function listOllamaModelTags(modelSlug: string): Promise<string[]> {
  const url = `${OLLAMA_WEB_BASE_URL}/library/${encodeURIComponent(modelSlug)}/tags`;
  const response = await client.getRaw(url);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Failed to fetch tags for "${modelSlug}": HTTP ${response.statusCode}`);
  }

  const escapedSlug = modelSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagPattern = new RegExp(`href="/library/(${escapedSlug}:[a-zA-Z0-9._-]+)"`, 'g');
  const tags = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(response.data))) {
    tags.add(match[1]);
  }

  if (tags.size === 0) {
    throw new Error(`No tags found for "${modelSlug}" - ollama.com's page structure may have changed`);
  }

  const latestTag = `${modelSlug}:latest`;
  const rest = [...tags].filter(tag => tag !== latestTag).sort();
  return tags.has(latestTag) ? [latestTag, ...rest] : rest;
}

export interface OllamaModelDetails {
  /** Approximate pull/download count parsed from the model page (0 if unknown). */
  downloads: number;
  /** Whether the model's page advertises tool/function-calling support. */
  supportsTools: boolean;
}

function parseCountSuffix(raw: string): number {
  const match = raw.replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) {
    return 0;
  }
  const value = parseFloat(match[1]);
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
  return Math.round(value * multiplier);
}

/**
 * Fetch a model's download count and tool-support badge from its
 * ollama.com/library/<model> page - used to rank live recommendations
 * (popularity + agentic capability) instead of a hardcoded list.
 */
export async function getOllamaModelDetails(modelSlug: string): Promise<OllamaModelDetails> {
  const url = `${OLLAMA_WEB_BASE_URL}/library/${encodeURIComponent(modelSlug)}`;
  const response = await client.getRaw(url);

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Failed to fetch model page for "${modelSlug}": HTTP ${response.statusCode}`);
  }

  const downloadsMatch = response.data.match(/<span\s*>([\d.,]+[KMB]?)<\/span>\s*<span[^>]*>&nbsp;Downloads<\/span>/i);
  const downloads = downloadsMatch ? parseCountSuffix(downloadsMatch[1]) : 0;
  const supportsTools = /class="[^"]*"\s*>\s*tools\s*<\/span>/i.test(response.data);

  return { downloads, supportsTools };
}
