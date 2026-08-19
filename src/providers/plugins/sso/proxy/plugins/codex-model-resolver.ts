/**
 * Deployment-name resolution for Codex clients.
 *
 * The Codex desktop app owns the `model` key in `~/.codex/config.toml`: it
 * writes its model-picker selection back to that file, overwriting whatever the
 * connector pinned. The names it picks come from its own bundled catalog and are
 * undated (`gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2`), while CodeMie deployments are
 * dated (`gpt-5.6-luna-2026-07-09`). The gateway rejects the undated form, so
 * every picker selection would fail without this mapping.
 *
 * Self-contained on purpose: the proxy must not depend on the Codex agent
 * plugin, which installs independently of the provider stack.
 */

/** Trailing release date on a CodeMie deployment name, e.g. `-2026-07-09`. */
const DEPLOYMENT_DATE_PATTERN = /[-._](20\d{2})[-._](\d{2})[-._](\d{2})\s*$/;

/** Identity of a model, independent of which dated deployment carries it. */
interface ModelIdentity {
  major: number;
  minor: number;
  /** Variant token such as `luna`, `sol`, `terra`, `mini`, `codex`; '' when plain. */
  variant: string;
}

export type ResolutionKind = 'exact' | 'resolved' | 'substituted' | 'unresolved';

export interface CodexModelResolution {
  model: string;
  kind: ResolutionKind;
  /** Present only on `substituted`, so callers can log what was asked for. */
  requested?: string;
}

/**
 * Parse a model name into its identity.
 *
 * The release date is stripped BEFORE the version is read — otherwise
 * `gpt-5-2025-08-07` reads as major 5, minor 2025 and never matches a request
 * for `gpt-5`.
 */
function parseIdentity(name: string): ModelIdentity | null {
  const lower = name.trim().toLowerCase();
  const dateMatch = lower.match(DEPLOYMENT_DATE_PATTERN);
  const withoutDate = dateMatch ? lower.slice(0, dateMatch.index) : lower;

  // Dotted and dashed minor versions are the same model: the app sends `gpt-5.2`
  // for the deployment CodeMie names `gpt-5-2-...`.
  const canonical = withoutDate.replace(/\./g, '-').replace(/-+$/, '');

  const versionMatch = canonical.match(/^gpt-(\d+)(?:-(\d+))?/);
  if (!versionMatch) return null;

  const rest = canonical.slice(versionMatch[0].length).replace(/^-/, '');

  return {
    major: Number(versionMatch[1]),
    minor: Number(versionMatch[2] ?? 0),
    variant: rest,
  };
}

function sameIdentity(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.major === b.major && a.minor === b.minor && a.variant === b.variant;
}

/**
 * Rank deployments newest-first, so a caller with no pinned model can still
 * choose a sensible substitute — the same choice `connect` would have pinned.
 */
export function rankDeploymentsByRecency(available: string[]): string[] {
  return available
    .map((id) => {
      const identity = parseIdentity(id);
      const dateMatch = id.toLowerCase().match(DEPLOYMENT_DATE_PATTERN);
      return {
        id,
        score: [
          identity?.major ?? 0,
          identity?.minor ?? 0,
          /mini|nano/i.test(id) ? 0 : 1,
          dateMatch ? Number(dateMatch[1]) : 0,
          dateMatch ? Number(dateMatch[2]) : 0,
          dateMatch ? Number(dateMatch[3]) : 0,
        ],
      };
    })
    .sort((a, b) => {
      for (let i = 0; i < a.score.length; i++) {
        const diff = (b.score[i] ?? 0) - (a.score[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return a.id.localeCompare(b.id);
    })
    .map((entry) => entry.id);
}

/**
 * Resolve the model a Codex client asked for to a deployment the gateway has.
 *
 * Returns the request unchanged when it is already a known deployment, the
 * matching dated deployment when the request identifies one, the pinned
 * fallback when nothing matches, or the request untouched when there is no
 * fallback to offer. Never throws — an unresolvable request is passed upstream
 * so the gateway's own error reaches the client.
 */
export function resolveCodexDeployment(
  requested: string,
  available: string[],
  pinnedFallback: string | undefined
): CodexModelResolution {
  if (available.includes(requested)) {
    return { model: requested, kind: 'exact' };
  }

  const wanted = parseIdentity(requested);
  if (wanted) {
    const match = available.find((candidate) => {
      const identity = parseIdentity(candidate);
      return identity !== null && sameIdentity(identity, wanted);
    });
    if (match) return { model: match, kind: 'resolved' };
  }

  if (pinnedFallback && available.includes(pinnedFallback)) {
    return { model: pinnedFallback, kind: 'substituted', requested };
  }

  return { model: requested, kind: 'unresolved' };
}
