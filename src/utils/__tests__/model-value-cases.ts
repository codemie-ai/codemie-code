/**
 * Shared model-value test table. The JSON next to this file is the cross-repository contract; this loader expands
 * its compact row forms into concrete values.
 *
 * Row forms: `{name, value, valid, rule?}` (text), `{name, gen: {char, count, prefix?}, ...}` (generated text),
 * `{name, json, nonText: true, valid: false, rule: "not_text"}` (any JSON value, `null` included).
 */

import { readFileSync } from 'node:fs';
import type { ModelValueRule } from '../model-value.js';

export interface ModelValueCase {
  name: string;
  value: unknown;
  valid: boolean;
  rule?: ModelValueRule;
  nonText: boolean;
}

interface RawRow {
  name: string;
  value?: string;
  gen?: { char: string; count: number; prefix?: string };
  json?: unknown;
  nonText?: boolean;
  valid: boolean;
  rule?: ModelValueRule;
}

function expand(row: RawRow): ModelValueCase {
  let value: unknown;
  if (row.gen) value = (row.gen.prefix ?? '') + row.gen.char.repeat(row.gen.count);
  else if ('json' in row) value = row.json;
  else value = row.value;
  return { name: row.name, value, valid: row.valid, rule: row.rule, nonText: row.nonText === true };
}

const rawRows = JSON.parse(
  readFileSync(new URL('./model-value-cases.json', import.meta.url), 'utf-8')
) as RawRow[];

export const MODEL_VALUE_CASES: ModelValueCase[] = rawRows.map(expand);

/** The first 8 characters of a text value, or null when it is shorter: a prefix a leak would reveal. */
export function leakProbe(value: string): string | null {
  return value.length < 8 ? null : value.slice(0, 8);
}
