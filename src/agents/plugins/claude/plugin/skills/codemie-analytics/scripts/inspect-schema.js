#!/usr/bin/env node
/**
 * inspect-schema.js <data-dir>
 *
 * Reads all .json files in <data-dir> and prints a compact schema to stdout.
 * Designed to give Claude enough structural information to write data extraction
 * code without reading raw API responses into the conversation context.
 *
 * Output format (per file):
 *   - primitives:  "number" | "boolean" | "string ~ 'sample'"
 *   - arrays:      { _type: "array", _count: N, _item: <item-schema> }
 *   - objects:     { key: <schema>, ... }
 *   - null fields: "null" or "<type> | null" when nullable across samples
 *
 * Usage:
 *   node inspect-schema.js /tmp/codemie-analytics-20260507/
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MAX_STRING_PREVIEW = 50;
const NULL_CHECK_SAMPLES = 5;
// For type-diversity detection: scan all items in small arrays, first N in large ones.
const TYPE_CHECK_SAMPLES = 20;

// Fields whose complete vocabulary is always emitted regardless of array context.
const ALWAYS_ENUMERATE = new Set([
  'type', 'format', 'classification', 'tier_name',
  'weekday', 'range', 'client_name', 'dimension_id',
]);

// Values containing these chars are entity/path identifiers, not vocabulary — skip them.
const ENTITY_VALUE_RE = /[@/]/;

// UUID-shaped strings are entity IDs, not vocabulary.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

/**
 * Returns the set of fields in itemSchema that should be fully enumerated.
 *
 * Rules:
 * - ALWAYS_ENUMERATE fields: always included.
 * - 'id': only when the parent item has a 'label' key (metrics or columns context),
 *   ensuring we capture metric/column identifiers without enumerating entity IDs.
 */
function getEnumerableFields(itemSchema) {
  const keys = new Set();
  for (const key of Object.keys(itemSchema)) {
    if (ALWAYS_ENUMERATE.has(key)) keys.add(key);
  }
  if ('id' in itemSchema && 'label' in itemSchema) {
    keys.add('id');
  }
  return keys;
}

/**
 * Returns the bare type category of an already-inferred schema string.
 * e.g. "string ~ 'foo'" → "string", "number" → "number", "null" → "null"
 */
function typeCategory(schema) {
  if (schema === 'null') return 'null';
  if (schema === 'number' || schema === 'boolean') return schema;
  if (typeof schema === 'string' && schema.startsWith('string')) return 'string';
  if (schema && typeof schema === 'object' && schema._type === 'array') return 'array';
  if (schema && typeof schema === 'object') return 'object';
  return String(schema);
}

function infer(value) {
  if (value === null || value === undefined) return 'null';

  const t = typeof value;

  if (t === 'boolean') return 'boolean';
  if (t === 'number') return 'number';

  if (t === 'string') {
    const preview = value.length > MAX_STRING_PREVIEW
      ? value.slice(0, MAX_STRING_PREVIEW) + '...'
      : value;
    return `string ~ '${preview}'`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { _type: 'array', _count: 0, _item: 'unknown' };

    const itemSchema = infer(value[0]);

    // Scan multiple items to detect nullable fields AND type diversity.
    // For small arrays scan everything; for large ones sample the first N.
    if (
      itemSchema !== null &&
      typeof itemSchema === 'object' &&
      !Array.isArray(itemSchema) &&
      value.length > 1
    ) {
      const sampleSize = Math.min(
        Math.max(NULL_CHECK_SAMPLES, TYPE_CHECK_SAMPLES),
        value.length
      );
      const samples = value.slice(0, sampleSize);

      for (const key of Object.keys(itemSchema)) {
        if (typeof itemSchema[key] !== 'string') continue; // skip nested objects/arrays
        if (itemSchema[key] === 'null') continue;

        const baseCategory = typeCategory(itemSchema[key]);
        const seenCategories = new Set([baseCategory]);

        for (const sample of samples.slice(1)) {
          const v = sample[key];
          if (v === null || v === undefined) {
            seenCategories.add('null');
          } else {
            seenCategories.add(typeCategory(infer(v)));
          }
        }

        const nonNullTypes = [...seenCategories].filter(c => c !== 'null');
        const hasNull = seenCategories.has('null') || itemSchema[key].includes('| null');

        if (nonNullTypes.length > 1) {
          // Multiple distinct types observed — drop string preview, show union
          itemSchema[key] = nonNullTypes.join(' | ') + (hasNull ? ' | null' : '');
        } else if (hasNull && !itemSchema[key].includes('| null')) {
          itemSchema[key] += ' | null';
        }
      }

      // Pass 2: enumerate vocabulary fields across ALL items
      const enumerableFields = getEnumerableFields(itemSchema);
      for (const key of enumerableFields) {
        if (typeof itemSchema[key] !== 'string') continue;
        if (!itemSchema[key].startsWith('string')) continue;

        const uniqueVals = new Set();
        for (const item of value) {
          const v = item[key];
          if (typeof v === 'string' && !UUID_RE.test(v) && !ENTITY_VALUE_RE.test(v)) {
            uniqueVals.add(v);
          }
        }

        // Always-enumerate fields emit even a single observed value; id requires ≥ 2.
        const minUnique = ALWAYS_ENUMERATE.has(key) ? 1 : 2;
        if (uniqueVals.size >= minUnique && uniqueVals.size <= 50) {
          const sorted = [...uniqueVals].sort();
          const preview = sorted.map(v => `'${v}'`).join(' | ');
          const nullable = itemSchema[key].includes('| null');
          itemSchema[key] = `string (enum) ~ ${preview}${nullable ? ' | null' : ''}`;
        }
      }
    }

    return { _type: 'array', _count: value.length, _item: itemSchema };
  }

  if (t === 'object') {
    const schema = {};
    for (const [k, v] of Object.entries(value)) {
      schema[k] = infer(v);
    }
    return schema;
  }

  return t;
}

function processFile(filePath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { _error: `Failed to parse: ${e.message}` };
  }
  return infer(raw);
}

const dataDir = process.argv[2];

if (!dataDir) {
  console.error('Usage: node inspect-schema.js <data-dir>');
  process.exit(1);
}

let files;
try {
  files = readdirSync(dataDir).filter(f => f.endsWith('.json') && !f.endsWith('.schema.json')).sort();
} catch (e) {
  console.error(`Cannot read directory: ${dataDir}\n${e.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No .json files found in: ${dataDir}`);
  process.exit(1);
}

const written = [];
for (const file of files) {
  const schema = processFile(join(dataDir, file));
  const schemaFile = file.replace(/\.json$/, '.schema.json');
  const schemaPath = join(dataDir, schemaFile);
  writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  written.push(`  ✓ ${schemaFile}`);
}

console.log(`Schemas written to: ${dataDir}`);
console.log(written.join('\n'));
