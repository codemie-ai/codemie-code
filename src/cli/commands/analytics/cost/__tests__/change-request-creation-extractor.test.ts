import { describe, expect, it } from 'vitest';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { extractChangeRequestCreationEvidence as extract } from '../change-request-creation-extractor.js';

const start = '2026-10-22T10:00:00.000Z';
const end = '2026-10-22T10:00:01.000Z';
function pair(name = 'Bash', input: unknown = { command: 'gh pr create --title "literal ; | title" --body \'body && text\'' }, content: unknown = 'https://github.com/acme/repo/pull/36', id = 't1'): unknown[] {
  return [
    { uuid: `u-${id}`, timestamp: start, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } },
    { uuid: `r-${id}`, timestamp: end, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } },
  ];
}
function session(messages: unknown[], extra = {}): ParsedSession {
  return { sessionId: 'root-session', agentName: 'claude', metadata: {}, messages, ...extra } as ParsedSession;
}
const gh = { type: 'pr_created', provider: 'github', host: 'github.com', repository: 'acme/repo', number: 36,
  url: 'https://github.com/acme/repo/pull/36', timestamp: end, source: 'gh_cli', toolUseId: 't1', owner: 'root' };

describe('change request creation evidence', () => {
  it('exports exact bounded metadata from a successful direct gh invocation', () => {
    expect(extract(session(pair()))).toEqual({ status: 'available', events: [gh] });
  });
  it.each(['https://gitlab.com/team/sub/repo/-/merge_requests/36', 'https://gitbud.epam.com:8443/team/sub/repo/-/merge_requests/36'])('supports glab nested projects and managed hosts: %s', (url) => {
    expect(extract(session(pair('Bash', { command: 'glab mr create --repo team/sub/repo --title "a | b"' }, `Creating merge request\n${url}?x=secret#fragment`))).events[0]).toEqual({
      ...gh, type: 'mr_created', provider: 'gitlab', host: new URL(url).host, repository: 'team/sub/repo', url, source: 'glab_cli',
    });
  });
  it('treats head as source and matches explicit target', () => {
    expect(extract(session(pair('Bash', { command: 'gh pr create -R acme/repo --head fork:branch' }))).events).toHaveLength(1);
  });
  it('recognizes GitHub MCP text JSON success', () => {
    expect(extract(session(pair('mcp__github__create_pull_request', { owner: 'acme', repo: 'repo' }, [{ type: 'text', text: JSON.stringify({ number: 36, html_url: gh.url }) }]))).events[0]).toEqual({ ...gh, source: 'github_mcp' });
  });
  it.each(['team/sub/repo', 'team%2Fsub%2Frepo', 123, '123'])('recognizes reference GitLab MCP project %s using iid not global id', (project_id) => {
    expect(extract(session(pair('mcp__gitlab__create_merge_request', { project_id }, { web_url: 'https://gitbud.epam.com/team/sub/repo/-/merge_requests/36', iid: 36, id: 999, project_id: 123 }))).events[0]).toEqual({ ...gh,
      type: 'mr_created', provider: 'gitlab', host: 'gitbud.epam.com', repository: 'team/sub/repo', url: 'https://gitbud.epam.com/team/sub/repo/-/merge_requests/36', source: 'gitlab_mcp',
    });
  });
  it.each(['gh pr create && echo x', 'gh pr create | cat', 'gh pr create > file', 'gh pr create\necho x', 'gh pr create --title "$(echo unsafe)"', 'gh pr create --help', 'gh pr create --web', 'glab mr create --repo 123', 'glab mr create --web'])('rejects unsupported direct creation form %s', (command) => {
    expect(extract(session(pair('Bash', { command })))).toEqual({ status: 'partial', events: [] });
  });
  it.each(['echo "gh pr create"', '# gh pr create', 'env gh pr create', 'gh pr view 36', 'glab mr view 36'])('never interprets wrappers/examples/reads: %s', (command) => {
    expect(extract(session(pair('Bash', { command }))).events).toEqual([]);
  });
  it.each([
    'http://github.com/acme/repo/pull/36', 'https://example.com/acme/repo/pull/36',
    'https://user:secret@github.com/acme/repo/pull/36', 'https://github.com/acme%2Frepo/x/pull/36',
    'https://github.com/acme/../repo/pull/36', 'https://github.com/acme/repo/issues/36',
    'https://github.com/acme/repo/pull/36/files', 'https://github.com/acme/repo/pull/9007199254740992',
    'already exists: https://github.com/acme/repo/pull/36', 'https://github.com/acme/repo/pull/36\nhttps://github.com/acme/repo/pull/37',
    'Failed post-creation action\nhttps://github.com/acme/repo/pull/36',
  ])('rejects invalid or non-success result %s', (result) => {
    expect(extract(session(pair('Bash', { command: 'gh pr create' }, result)))).toEqual({ status: 'partial', events: [] });
  });
  it.each([
    ['gh pr create -R wrong/repo', gh.url],
    ['glab mr create -R other.host/team/repo', 'https://gitlab.com/team/repo/-/merge_requests/36'],
  ])('rejects conflicting CLI selectors %s', (command, url) => {
    expect(extract(session(pair('Bash', { command }, url))).events).toEqual([]);
  });
  it.each([
    ['mcp__github__create_pull_request', { owner: 'wrong', repo: 'repo' }, { html_url: gh.url, number: 36 }],
    ['mcp__github__create_pull_request', {}, { html_url: gh.url, number: 37 }],
    ['mcp__gitlab__create_merge_request', { project_id: 12 }, { web_url: 'https://gitlab.com/team/repo/-/merge_requests/36', iid: 36, project_id: 13 }],
    ['mcp__gitlab__create_merge_request', { project_id: 'wrong/repo' }, { web_url: 'https://gitlab.com/team/repo/-/merge_requests/36', iid: 36, project_id: 13 }],
    ['mcp__gitlab__create_merge_request', { project_id: 13 }, { web_url: 'https://gitlab.com/team/repo/-/merge_requests/36', iid: 37, project_id: 13 }],
  ])('rejects inconsistent MCP identities', (name, input, result) => {
    expect(extract(session(pair(name as string, input, result)))).toEqual({ status: 'partial', events: [] });
  });
  it('rejects conflicting structured and text MCP envelopes', () => {
    const rows = pair('mcp__github__create_pull_request', {}, { structuredContent: { html_url: gh.url, number: 36 }, content: [{ type: 'text', text: JSON.stringify({ html_url: 'https://github.com/acme/repo/pull/37', number: 37 }) }] });
    expect(extract(session(rows))).toEqual({ status: 'partial', events: [] });
  });
  it('keeps equal MR numbers distinct across project and host identities', () => {
    const rows = ['https://gitlab.com/a/repo/-/merge_requests/36', 'https://gitbud.epam.com/a/repo/-/merge_requests/36', 'https://gitlab.com/b/repo/-/merge_requests/36'].flatMap((url, i) => pair('Bash', { command: 'glab mr create' }, url, `tool-${i}`));
    expect(extract(session(rows)).events).toHaveLength(3);
  });
  it('rejects errors, nonzero exit codes, missing results and timestamps', () => {
    for (const change of [
      (rows: ReturnType<typeof pair>) => rows.pop(),
      (rows: ReturnType<typeof pair>) => { delete (rows[1] as { timestamp?: string }).timestamp; },
      (rows: ReturnType<typeof pair>) => { Object.assign(rows[1] as object, { toolUseResult: { exitCode: 1 } }); },
      (rows: ReturnType<typeof pair>) => { ((rows[1] as { message: { content: object[] } }).message.content[0] as { is_error?: boolean }).is_error = true; },
    ]) {
      const rows = pair(); change(rows);
      expect(extract(session(rows))).toEqual({ status: 'partial', events: [] });
    }
  });
  it('deduplicates exact replay and rejects conflicting reuse of a tool id', () => {
    expect(extract(session([...pair(), ...pair()])).events).toEqual([gh]);
    expect(extract(session([...pair(), ...pair('Bash', { command: 'gh pr create -R other/repo' })])).events).toEqual([]);
  });
  it('uses linked child ownership and excludes replay from child', () => {
    const launch = pair('Agent', {}, 'done', 'launch');
    const child = { agentId: 'child', toolUseId: 'launch', parentAgentId: 'root', messages: pair(), filePath: '/fake' };
    expect(extract(session(launch, { subagents: [child] })).events).toEqual([{ ...gh, owner: 'subagent', ownerId: 'child' }]);
    expect(extract(session([...launch, ...pair()], { subagents: [child] })).events).toEqual([gh]);
    expect(extract(session([], { subagents: [{ ...child, toolUseId: undefined }] })).events).toEqual([]);
  });
  it('does not attribute child creation to a session that only replays its earlier launch', () => {
    const launch = pair('Agent', {}, 'done', 'launch') as Array<{ timestamp: string }>;
    launch.forEach((row) => { row.timestamp = '2026-10-22T09:00:00.000Z'; });
    const child = { agentId: 'child', toolUseId: 'launch', parentAgentId: 'root', messages: pair(), filePath: '/fake' };
    expect(extract(session(launch, { subagents: [child] }), { start: Date.parse(start) }).events).toEqual([]);
  });
  it('does not ignore nonzero string exit codes or contradictory response host fields', () => {
    const rows = pair();
    Object.assign(rows[1] as object, { toolUseResult: { exitCode: '1' } });
    expect(extract(session(rows)).events).toEqual([]);
    expect(extract(session(pair('mcp__github__create_pull_request', {}, { structuredContent: { html_url: gh.url, number: 36 }, host: 'evil.example' }))).events).toEqual([]);
  });
  it('requires both invocation and result inside the exclusive window', () => {
    expect(extract(session(pair()), { start: Date.parse(end) }).events).toEqual([]);
    expect(extract(session(pair()), { end: Date.parse(end) }).events).toEqual([]);
    expect(extract(session(pair()), { start: Date.parse(start), end: Date.parse(end) + 1 }).events).toEqual([gh]);
  });
  it('keeps verified events when another candidate fails and bounds event count', () => {
    const rows = Array.from({ length: 101 }, (_, i) => pair('Bash', { command: 'gh pr create' }, `https://github.com/acme/repo/pull/${i + 1}`, `t${i}`)).flat();
    expect(extract(session(rows))).toMatchObject({ status: 'partial' });
    expect(extract(session(rows)).events).toHaveLength(100);
    expect(extract(session([...pair(), ...pair('Bash', { command: 'gh pr create' }, 'error', 'bad')]))).toEqual({ status: 'partial', events: [gh] });
    expect(extract(session(pair('Bash', { command: 'gh pr create' }, gh.url, 'x'.repeat(257)))).events).toEqual([]);
  });
  it.each([
    ['gh pr create --title "--help" --body "--repo"', gh.url],
    ['glab mr create --title "--web" --description "--hostname"', 'https://gitlab.com/team/repo/-/merge_requests/36'],
  ])('preserves literal flag-looking CLI option values: %s', (command, url) => {
    expect(extract(session(pair('Bash', { command }, url))).events).toHaveLength(1);
  });
  it.each([
    ['gh pr create', 'https://github.com/acme/error-handler/pull/36'],
    ['glab mr create', 'https://gitlab.com/preview/repo/-/merge_requests/36'],
  ])('accepts success URLs containing failure vocabulary: %s', (command, url) => {
    expect(extract(session(pair('Bash', { command }, url))).events).toHaveLength(1);
  });
  it.each(['host', 'hostname'])('rejects conflicting %s in secondary MCP representations', (field) => {
    const payload = { html_url: gh.url, number: 36 };
    const rows = pair('mcp__github__create_pull_request', {}, { structuredContent: payload,
      content: [{ type: 'text', text: JSON.stringify({ ...payload, [field]: 'evil.example' }) }] });
    expect(extract(session(rows))).toEqual({ status: 'partial', events: [] });
  });
  it('marks missing creation call IDs partial and keeps other valid events', () => {
    const malformed = { timestamp: start, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr create' } }] } };
    expect(extract(session([malformed, ...pair()]))).toEqual({ status: 'partial', events: [gh] });
  });

  it.each(['error', 'failed', 'failure', 'already', 'exists', 'preview'])('accepts glab progress with %s in the branch', (word) => {
    const url = 'https://gitlab.com/team/repo/-/merge_requests/36';
    expect(extract(session(pair('Bash', { command: 'glab mr create' }, `Creating merge request for fix-${word}-handling into main in team/repo\n${url}`))).events).toHaveLength(1);
  });
  it('matches GitHub MCP repository identities without case sensitivity', () => {
    expect(extract(session(pair('mcp__github__create_pull_request', { owner: 'Acme', repo: 'Repo' }, { number: 36, html_url: gh.url }))).events).toHaveLength(1);
  });
  it.each(['gh', 'glab'])('validates attached repository selectors for %s', (cli) => {
    const url = cli === 'gh' ? gh.url : 'https://gitlab.com/acme/repo/-/merge_requests/36';
    for (const flag of ['--repo=', '-R']) {
      for (const repo of ['acme/repo', 'wrong/repo']) {
        expect(extract(session(pair('Bash', { command: `${cli} ${cli === 'gh' ? 'pr' : 'mr'} create ${flag}${repo}` }, url))).events).toHaveLength(repo === 'acme/repo' ? 1 : 0);
      }
    }
  });
  it('marks boundary-straddling pairs partial but ignores wholly outside pairs', () => {
    expect(extract(session(pair()), { observedEnd: Date.parse(start) + 500 })).toEqual({ status: 'partial', events: [] });
    expect(extract(session(pair()), { end: Date.parse(end) })).toEqual({ status: 'partial', events: [] });
    expect(extract(session(pair()), { start: Date.parse(end) })).toEqual({ status: 'partial', events: [] });
    expect(extract(session(pair()), { end: Date.parse(start) })).toEqual({ status: 'available', events: [] });
    expect(extract(session(pair()), { start: Date.parse(end) + 1 })).toEqual({ status: 'available', events: [] });
  });
  it('still rejects an existing PR URL and errors after a progress line', () => {
    expect(extract(session(pair('Bash', { command: 'gh pr create' }, `a pull request already exists:\n${gh.url}`))).events).toHaveLength(0);
    expect(extract(session(pair('Bash', { command: 'glab mr create' }, 'Creating merge request for fix-error into main in team/repo\nerror: creation failed\nhttps://gitlab.com/team/repo/-/merge_requests/36'))).events).toHaveLength(0);
  });

  it.each(['--host gitlab.com', '--hostname=gitlab.com'])('rejects unsupported host flag %s', (flag) => {
    expect(extract(session(pair('Bash', { command: `glab mr create ${flag}` }, 'https://gitlab.com/team/repo/-/merge_requests/36')))).toEqual({ status: 'partial', events: [] });
  });

});
