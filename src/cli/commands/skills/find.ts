/**
 * `codemie skills find <query>` — two-section search across the EPAM
 * internal catalog and the public skills.sh registry.
 * Find/search intentionally does not emit CodeMie lifecycle metrics because
 * interactive discovery can be noisy and does not change installed state.
 *
 * - Empty query: delegates to upstream `skills find` so the existing
 *   interactive prompt keeps working. The egress guard shim still
 *   applies on that path.
 * - Query <2 chars: prints the upstream-style hint and exits 0.
 * - Query >=2 chars: fetches both sections in parallel; each section
 *   degrades independently. Exit 0 if any HTTP call succeeded; exit 1
 *   only when every attempted call failed.
 */
import { Command } from 'commander';
import { logger } from '@/utils/logger.js';
import { runSkillsCli } from './lib/run-skills-cli.js';
import { requireAuthenticatedSession } from './lib/require-auth.js';
import {
  resolveInternalContext,
  searchInternal,
  searchPublic,
} from './lib/skills-search-client.js';
import { renderSections, renderJson } from './lib/result-render.js';

const MIN_QUERY_CHARS = 2;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface FindOptions {
  json?: boolean;
  limit?: string;
}

export function createFindCommand(): Command {
  return new Command('find')
    .description('Search EPAM internal and public skills.sh catalogs')
    .argument(
      '[query]',
      'search query; without one the upstream interactive prompt is launched'
    )
    .option('--json', 'emit machine-readable JSON instead of the formatted output')
    .option(
      '--limit <n>',
      `max results per section (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
    )
    .action(async (query: string | undefined, options: FindOptions) => {
      await requireAuthenticatedSession();

      if (!query) {
        await delegateToUpstream();
        return;
      }

      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_CHARS) {
        process.stdout.write(`Start typing (min ${MIN_QUERY_CHARS} chars)\n`);
        return;
      }

      const limit = clampLimit(options.limit);
      // Resolve the internal endpoint and SSO headers once. The same
      // result drives both the "internal configured" UX flag and the
      // HTTP call inside `searchInternal`, so we avoid loading config
      // multiple times per invocation.
      const internalContext = await resolveInternalContext();
      const internalConfigured = internalContext !== null;

      const [internal, publicResults] = await Promise.all([
        searchInternal(trimmed, limit, internalContext),
        searchPublic(trimmed, limit),
      ]);

      const succeededCalls =
        (internalConfigured && internal.available ? 1 : 0) +
        (publicResults.available ? 1 : 0);
      const allFailed = succeededCalls === 0;

      const renderInput = {
        query: trimmed,
        internal,
        public: publicResults,
        internalConfigured,
      };

      if (options.json) {
        process.stdout.write(`${JSON.stringify(renderJson(renderInput), null, 2)}\n`);
      } else {
        process.stdout.write(renderSections(renderInput));
      }

      if (allFailed) {
        process.exit(1);
      }
    });
}

async function delegateToUpstream(): Promise<void> {
  const cwd = process.cwd();
  try {
    const result = await runSkillsCli(['find'], { cwd });
    if (result.code === 0) {
      return;
    }
    process.exit(result.code || 1);
  } catch (error) {
    logger.error(
      `[skills] find failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}
