import { logger } from '@/utils/logger.js';
import { detectGitBranch, detectGitCommitsByAuthor, detectGitHeadSha, detectGitRemoteRepo } from '@/utils/processes.js';
import type { GitCommitSummary } from '@/utils/processes.js';
import type { OtlpHookContext } from '../OtlpAgentAdapter.js';
import { resolveStoryFor } from '../story-resolver.js';

export type { GitCommitSummary };

/** Git and story fields, resolved from the hook's cwd and prompt. Common to every event. */
export interface RepoFields {
  git_branch: string;
  repo_remote: string;
  story_id: string;
  story_source: string;
}

/** Opt-in: full HEAD sha at the start of a session. */
export interface GitHeadStartFields {
  git_head_start: string;
}

/** Opt-in: full HEAD sha at the end of a session. */
export interface GitHeadEndFields {
  git_head_end: string;
}

/** A failed lookup yields empty fields, never a dropped event. */
export async function resolveRepoFields({ cwd, prompt }: OtlpHookContext): Promise<RepoFields> {
  const empty: RepoFields = { git_branch: '', repo_remote: '', story_id: '', story_source: '' };
  try {
    const [branch, remote] = cwd
      ? await Promise.all([detectGitBranch(cwd), detectGitRemoteRepo(cwd)])
      : [undefined, undefined];
    const story = await resolveStoryFor({ cwd, branch, prompt });
    return {
      git_branch: branch ?? '',
      repo_remote: remote ?? '',
      story_id: story?.storyId ?? '',
      story_source: story?.storySource ?? '',
    };
  } catch (error) {
    logger.debug(`[event-fields] repo field resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

async function resolveHeadSha(cwd: string): Promise<string> {
  try {
    return cwd ? ((await detectGitHeadSha(cwd)) ?? '') : '';
  } catch (error) {
    logger.debug(`[event-fields] git head resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

type GitHeadFields<W extends 'start' | 'end'> = W extends 'start' ? GitHeadStartFields : GitHeadEndFields;

export async function resolveGitHeadFields<W extends 'start' | 'end'>(
  { cwd }: OtlpHookContext,
  which: W
): Promise<GitHeadFields<W>> {
  const sha = await resolveHeadSha(cwd);
  return (which === 'start' ? { git_head_start: sha } : { git_head_end: sha }) as GitHeadFields<W>;
}

/** Opt-in for `agent.git.snapshot`: commits by `authorEmail` since `sinceIso`, metadata only. */
export interface GitCommitFields {
  git_commits: GitCommitSummary[];
}

/** A failed lookup yields an empty list, never a dropped event. */
export async function resolveGitCommitFields(
  cwd: string,
  sinceIso: string,
  authorEmail: string
): Promise<GitCommitFields> {
  try {
    return { git_commits: await detectGitCommitsByAuthor(cwd, sinceIso, authorEmail) };
  } catch (error) {
    logger.debug(`[event-fields] git commit resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return { git_commits: [] };
  }
}
