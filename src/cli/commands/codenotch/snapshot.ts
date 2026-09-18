import type { BudgetRow, CodenotchProfile } from './budget.js';

/**
 * Codenotch plugin-protocol payload builders
 * (docs/design/plugin-protocol.md in the Codenotch repo).
 *
 * `codemie-budget` shows every bucket on the account, led by a synthesized
 * Total window; `codemie-claude` leads with the CLI bucket its sessions spend
 * from. Identity (id, displayName, glyph) never crosses the wire — Codenotch
 * takes those from the manifest.
 */

export type CodenotchProviderId = 'codemie-budget' | 'codemie-claude';
export const CODENOTCH_PROVIDER_IDS: CodenotchProviderId[] = ['codemie-budget', 'codemie-claude'];

interface Bucket {
  id: string;
  label: string;
  row: BudgetRow;
}

/** `"you@example.com (cli)"` → suffix `cli`; bare email → the web bucket. */
export function bucketsForAccount(rows: BudgetRow[], email: string): Bucket[] {
  const prefix = email.trim().toLowerCase();
  const matched: { suffix: string | null; row: BudgetRow }[] = [];
  for (const row of rows) {
    if (row.projectName === prefix) {
      matched.push({ suffix: null, row });
    } else if (row.projectName.startsWith(`${prefix} (`) && row.projectName.endsWith(')')) {
      matched.push({ suffix: row.projectName.slice(prefix.length + 2, -1), row });
    }
  }
  const rank = (suffix: string | null): number => (suffix === 'cli' ? 0 : suffix === null ? 1 : 2);
  return matched
    .sort((a, b) => rank(a.suffix) - rank(b.suffix) || (a.suffix ?? '').localeCompare(b.suffix ?? ''))
    .map(({ suffix, row }) => ({
      id: suffix === null ? 'bucket-web' : `bucket-${suffix}`,
      label: suffix === null ? 'Platform spend' : suffix === 'cli' ? 'CLI spend' : `${suffix[0].toUpperCase()}${suffix.slice(1)} spend`,
      row,
    }));
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function fraction(percent: number): number {
  return Math.round(Math.max(0, percent) * 10_000) / 1_000_000;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

type Json = Record<string, unknown>;

function windowFor(id: string, label: string, row: BudgetRow): Json {
  let money: Json | null = null;
  let usedText: string | null = null;
  let detail: string | null = null;
  if (row.spent !== undefined && row.limit !== undefined) {
    money = { currency: 'USD', spent: cents(row.spent), remaining: cents(Math.max(0, row.limit - row.spent)) };
    detail = `${dollars(row.spent)} of ${dollars(row.limit)}`;
  } else if (row.spent !== undefined) {
    usedText = `${dollars(row.spent)} spent`;
  }
  return {
    id,
    label,
    usedFraction: row.percent !== undefined ? fraction(row.percent) : null,
    group: null,
    remaining: null,
    used: null,
    usedText,
    detail,
    money,
    resetsAt: row.resetsAt ?? null,
  };
}

/** Headline window summing every bucket; rows without a limit give no remaining. */
function totalWindow(rows: BudgetRow[]): Json {
  const spent = rows.reduce((sum, row) => sum + (row.spent ?? 0), 0);
  const limited = rows.filter((row) => row.limit !== undefined);
  let money: Json | null = null;
  let usedText: string | null = null;
  let detail: string | null = null;
  let usedFraction: number | null = null;
  if (limited.length > 0) {
    const remaining = limited.reduce((sum, row) => sum + Math.max(0, (row.limit ?? 0) - (row.spent ?? 0)), 0);
    const funded = spent + remaining;
    money = { currency: 'USD', spent: cents(spent), remaining: cents(remaining) };
    detail = `${dollars(spent)} of ${dollars(funded)}`;
    if (funded > 0) usedFraction = fraction((spent / funded) * 100);
  } else {
    usedText = `${dollars(spent)} spent`;
  }
  const resets = rows.map((row) => row.resetsAt).filter((d): d is string => Boolean(d)).sort();
  return {
    id: 'budget-total',
    label: 'Total budget',
    usedFraction,
    group: null,
    remaining: null,
    used: null,
    usedText,
    detail,
    money,
    resetsAt: resets[0] ?? null,
  };
}

function envelope(headlineID: string, windows: Json[], profile: CodenotchProfile): Json {
  return {
    fidelity: 'official',
    plan: profile.provider ?? null,
    headlineID,
    weeklyID: null,
    account: {
      label: profile.userEmail,
      plan: profile.provider ?? null,
      source: 'CodeMie CLI',
      manageURL: profile.codeMieUrl,
    },
    windows,
  };
}

/** Payload for one provider, or null when the account has no budget rows (exit-5 path). */
export function buildSnapshot(
  provider: CodenotchProviderId,
  rows: BudgetRow[],
  profile: CodenotchProfile
): Json | null {
  const buckets = bucketsForAccount(rows, profile.userEmail);
  if (buckets.length === 0) return null;

  if (provider === 'codemie-claude') {
    const headlineID = buckets.some((bucket) => bucket.id === 'bucket-cli') ? 'bucket-cli' : buckets[0].id;
    return envelope(headlineID, buckets.map((bucket) => windowFor(bucket.id, bucket.label, bucket.row)), profile);
  }

  const windows: Json[] = [];
  let headlineID = buckets[0].id;
  if (buckets.length > 1) {
    windows.push(totalWindow(buckets.map((bucket) => bucket.row)));
    headlineID = 'budget-total';
  }
  windows.push(...buckets.map((bucket) => windowFor(bucket.id, bucket.label, bucket.row)));
  return envelope(headlineID, windows, profile);
}
