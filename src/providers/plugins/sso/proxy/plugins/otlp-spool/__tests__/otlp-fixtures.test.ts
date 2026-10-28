/**
 * EPMCDME-16440 task 1: OTLP wire fixtures + plan-time evidence.
 * @group unit
 *
 * FIXTURES (fixtures/*.bin + manifest.json) are produced by a real protobuf encoder, not by hand:
 *   generator (kept OUTSIDE the repo): C:/codemie-dev/_local/epmcdme-16440/scratch/gen_otlp_fixtures.py
 *   rerun: C:/codemie-dev/codemie/.venv/Scripts/python.exe -I C:/codemie-dev/_local/epmcdme-16440/scratch/gen_otlp_fixtures.py \
 *            <this repo>/src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/fixtures
 * It uses the backend venv READ-ONLY (opentelemetry.proto + protobuf 5.29.6). The manifest (session/project observations,
 * top-level resource-entry boundaries, sizes, sha256) is re-derived by re-parsing the bytes with the real proto classes;
 * only the intended verdict is typed, and the generator asserts it equals the verdict computed from the parsed message.
 * Verdict sources: spec.md item 6; backend otlp.py (_log_from_record, decode_traces, _append_metric_point, _decode_metric,
 * _note_project, parse_request) and session_binding.check_boundary (every stored row must carry the declared id; "" fails).
 * Deliberate spec-vs-backend differences (manifest `note`): session.id/session_id contradiction (backend would accept
 * session.id; spec holds it) and non-string ids. Histogram/summary/exp-histogram points are never stored by the backend
 * (only their project is noted), so the backend cannot reject them on session id; the client check is stricter.
 * Task 11's OTLP reader is validated against this manifest. The 5 MiB+1 oversize case is generated in-test, not stored.
 *
 * WIRE FIELD NUMBERS (opentelemetry-proto, confirmed by the encoder; top level of every Export*ServiceRequest):
 *   field 1 (tag 0x0a, length-delimited) = repeated ResourceLogs / ResourceSpans / ResourceMetrics. Concatenated
 *   requests are legal and merge by appending field 1 entries; boundaries are the entry [start,end) offsets in the manifest.
 *   Resource{1 attributes}; ResourceX{1 resource, 2 scope_X}; ScopeX{2 log_records|spans|metrics}; LogRecord.attributes=6,
 *   Span.attributes=9, Metric{1 name, 5 gauge, 7 sum, 9 histogram, 10 exponential_histogram, 11 summary}, data points'
 *   attributes: NumberDataPoint=7, HistogramDataPoint=9, ExponentialHistogramDataPoint=1, SummaryDataPoint=7.
 *   KeyValue{1 key, 2 AnyValue}; AnyValue{1 string, 2 bool, 3 int, 4 double, 5 array, 6 kvlist, 7 bytes}.
 *   Also ResourceX.scope_X=2, ScopeX.scope=1, Metric.name=1, LogRecord.body=5. All numbers dumped from the real
 *   protobuf descriptors (backend venv) during this task.
 *
 * PLAN-TIME EVIDENCE (read from source at base fd7d2ace unless marked):
 * (a) OTLP resource project origin: nothing in src sets `codemie_project_name` on the OTLP resource, nor OTEL_RESOURCE_ATTRIBUTES
 *     (grep of src, non-test: no match). Claude's own OTLP export gets only the env that connectors/claude-code-otlp.ts writes
 *     into ~/.claude/settings.json (CODEMIE_ENV_KEYS: ENABLE_TELEMETRY, ENHANCED_TELEMETRY_BETA, OTEL_EXPORTER_OTLP_ENDPOINT/
 *     HEADERS/PROTOCOL, OTEL_{LOGS,METRICS,TRACES}_EXPORTER, OTEL_LOG_TOOL_DETAILS; :82-90, values :104-112, :455-456). The only
 *     CLI-side producer of `codemie_project_name` is the hook event body (agents/core/event-fields/identity-fields.ts:21,46,
 *     read by spool session-project.ts:17-22). So a project value on OTLP records/resources can only come from the user's
 *     own OTEL_RESOURCE_ATTRIBUTES / Claude config: it is foreign evidence and must be checked for conflict, never trusted.
 * (b) .claude.json placement: KEY-NAMES-ONLY probe on this machine with CLAUDE_CONFIG_DIR unset found ~/.claude.json (home root,
 *     NOT inside ~/.claude/). Top-level key names include: userID, machineID, oauthAccount, hasAvailableSubscription,
 *     hasCompletedOnboarding, customApiKeyResponses, mcpServers, projects (+ ~70 caches). oauthAccount key names: accountUuid,
 *     emailAddress, organizationUuid, hasExtraUsageEnabled, billingType, accountCreatedAt, subscriptionCreatedAt,
 *     ccOnboardingFlags, claudeCodeTrialEndsAt, claudeCodeTrialDurationDays, seatTier, displayName, fullName, profileFetchedAt,
 *     organizationRole, workspaceRole, organizationName, organizationType, organizationRateLimitTier, userRateLimitTier.
 *     There is no key literally named subscriptionType. Values were never read into output. The CLAUDE_CONFIG_DIR placement
 *     (believed `<CLAUDE_CONFIG_DIR>/.claude.json`) could NOT be verified offline here (var unset; not run against Claude):
 *     treat as an assumption and probe both locations. Note this repo's getClaudeSettingsPath()
 *     (claude-code-otlp.allowlist.ts:52-54) ignores CLAUDE_CONFIG_DIR (always ~/.claude/settings.json), while claude.session.ts:73
 *     honours it for projects/.
 * (c) daemon state: DaemonState (cli/commands/proxy/daemon-manager.ts:9-31) has pid, port, url, profile (string, required),
 *     gatewayKey, telemetryMode?, targetUrl?, provider?, project?, model?, clientType?, syncApiUrl?, syncCodeMieUrl?, startedAt, health*.
 *     readState(stateFile = <codemie home>/proxy-daemon.json) returns null on any error (:35-42). There is NO base-path field;
 *     targetUrl is the model upstream, url the local loopback proxy.
 * (d) spool retention bound: spool-config.ts has only endedSessionGraceMs (OTLP_ENDED_SESSION_GRACE_MINUTES, 15 min, :64),
 *     abandonedSessionGraceMs (OTLP_ABANDONED_SESSION_GRACE_MINUTES, 60 min, :73), hooksOnlyWaitTicks (OTLP_SEND_MAX_ATTEMPTS,
 *     3 ticks x OTLP_SEND_INTERVAL_MINUTES 2 min, :50) and sweepIntervalMs (15 min). sweep.ts isDeletable() deletes ONLY
 *     fully drained sessions (isSessionDrained: size <= cursor for every stream), measured from the last spool-file mtime
 *     (ended: max(endedAt, mtime)). So a HELD (undrained) range has NO existing retention bound: it is never swept. Spec item 6's
 *     "existing spool retention bound" for head-of-line holds must therefore be defined by the implementer (natural choice:
 *     abandonedSessionGraceMs() since last spool write), then record loss with the hold reason.
 * (e) session birth vs epoch.json: SessionStatus (session-status.ts:44-46 createStatus, normalizeStatus :56) has NO created
 *     timestamp; writeStatus (:101-104) is an in-place writeFile (no rename), so the .status file birthtime is the session's
 *     local creation time until a sweep deletes it (sweep.ts deleteSession removes .status and stream files together) and a
 *     later producer write recreates it. mtime of status changes on every cursor write; spool-file mtimes are last-write only.
 *     Use statusFile birthtime (fallback: min spool-file birthtime, then mtime) vs epoch.json; birthtime support varies by
 *     filesystem (may be 0): a missing/zero birthtime must resolve to the conservative side (not legacy). No epoch code exists yet.
 * (f) Claude exporting settings.json `env` to hook processes: NOT verifiable offline here (needs running Claude). The repo
 *     itself relies on settings.json env for the Claude process (connectors/claude-code-otlp.ts writes OTEL_* there), and cli/commands/hook.ts
 *     reads CODEMIE_* from process.env (hook.ts:138,297). Conservative assumption: hook processes may NOT see settings.json
 *     env; read the effective endpoint from settings.json explicitly, and treat anything derived solely from a settings env
 *     inside a hook as unproven.
 * (g) cursor semantics: cursors are byte offsets into the per-stream spool file. advanceCursor (session-status.ts:131-139)
 *     is monotonic (Math.max), runs under updateStatus's session lock, no upper-bound check. isSendAllowed (spool-io.ts:225-243)
 *     is a pure locked re-check: status exists; policy kind is send for the stream; project equals case-insensitively;
 *     status.cursors[stream] === range.cursor EXACTLY; `filtered` flag matches; and range.end <= policy limit if any.
 *     Hooks: snapshotPendingHookRecords cuts at the last 0x0a, byteLength is the exact byte count (utf-8 safe), cursor advances
 *     to cursor+byteLength (forwarder.ts:224,244). OTLP: snapshotPendingBytes returns the WHOLE pending tail from cursor with no
 *     boundary cut (spool-io.ts:330-342; ack forwarder.ts:274 = cursor + bytes.length). A verified-prefix send can ack any
 *     prefix length because cursor/range.end are plain byte numbers; a recreated file resets cursor to 0 (appendSpool :301-306).
 * (h) URL roles (BaseAgentAdapter.ts, base fd7d2ace): buildProxyConfig (:996-1046) sets targetApiUrl = env.CODEMIE_BASE_URL
 *     (the MODEL upstream, throws if absent :1000-1003), syncApiUrl = CODEMIE_SYNC_API_URL, syncCodeMieUrl = CODEMIE_URL (:1044-1045;
 *     CodeMie/SSO base used for credential lookup, ssoUrl in plugins, and analytics sync). setupProxy (:1059-1091), only when
 *     shouldUseProxy (:974-989: provider set, authType != 'none', (sso provider || CODEMIE_AUTH_METHOD=jwt) && ssoConfig.enabled),
 *     starts CodeMieProxy, sets env.CODEMIE_TARGET_API_URL = original upstream (:1081), then overwrites env.CODEMIE_BASE_URL with
 *     the loopback proxy url and CODEMIE_API_KEY='proxy-handled' (:1084-1085). Agent envMapping then copies CODEMIE_BASE_URL
 *     into e.g. ANTHROPIC_BASE_URL (claude.plugin.ts:160). forwarder.resolveBaseUrl (forwarder.ts:195-200) uses daemon state
 *     targetUrl ?? url for the ANALYTICS POST. The four can all differ. config.ts:1488 exports config.baseUrl as CODEMIE_BASE_URL;
 *     config.ts:483 maps CODEMIE_URL to codeMieUrl (the analytics/SSO base).
 *     Native (no proxy) configured-model-route proof inputs, separate from the analytics destination: profile config baseUrl
 *     (CODEMIE_BASE_URL before setupProxy, or CODEMIE_PROFILE_CONFIG.baseUrl), CODEMIE_PROVIDER + provider registry (authType),
 *     CODEMIE_INTEGRATION_ID, CODEMIE_AUTH_METHOD, and Claude's effective ANTHROPIC_BASE_URL (settings.json env over process env;
 *     claude.plugin.ts:368-406 already detects a settings.json override). Analytics-side values (CODEMIE_URL,
 *     CODEMIE_SYNC_API_URL, daemon syncCodeMieUrl/url) must not be used as that proof. If none of the model-route inputs can be
 *     validated, routed=false and class Unknown.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VERDICTS = ['ok', 'session_id_absent', 'session_mismatch', 'project_conflict', 'otlp_unparseable'];
const SIGNALS = ['logs', 'traces', 'metrics'];
const MAX_SNAPSHOT_BYTES = 5_242_880;

interface Entry { start: number; end: number }
interface Obs { where: string; key: string; type: string; value: unknown }
interface Fixture {
  file: string | null; signal: string; note: string; generated_in_test: boolean; expected_verdict: string;
  parse_ok?: boolean; entries: Entry[]; session_observations: Obs[]; project_observations: Obs[];
  size: number; sha256: string | null;
}
interface Manifest {
  expected_session_id: string; expected_project: string; max_attributes_per_record: number;
  max_snapshot_bytes: number; fixtures: Fixture[];
}

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf-8')) as Manifest;
const stored = manifest.fixtures.filter((f) => f.file !== null);

describe('OTLP wire fixtures (decoder-derived manifest)', () => {
  it('manifest is well-formed and covers every verdict class and signal', () => {
    expect(manifest.max_snapshot_bytes).toBe(MAX_SNAPSHOT_BYTES);
    expect(manifest.max_attributes_per_record).toBe(256);
    expect(new Set(manifest.fixtures.map((f) => f.expected_verdict))).toEqual(new Set(VERDICTS));
    expect(new Set(manifest.fixtures.map((f) => f.signal))).toEqual(new Set(SIGNALS));
    for (const f of manifest.fixtures) {
      expect(VERDICTS).toContain(f.expected_verdict);
      expect(SIGNALS).toContain(f.signal);
    }
    const names = manifest.fixtures.map((f) => f.file);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every stored .bin has the manifest size and sha256, and no orphan files exist', () => {
    const onDisk = readdirSync(DIR).filter((n) => n.endsWith('.bin')).sort();
    expect(onDisk).toEqual(stored.map((f) => f.file as string).sort());
    for (const f of stored) {
      const bytes = readFileSync(join(DIR, f.file as string));
      expect(bytes.length, f.file as string).toBe(f.size);
      expect(createHash('sha256').update(bytes).digest('hex'), f.file as string).toBe(f.sha256);
    }
  });

  it('keeps stored fixtures small (tens of KB)', () => {
    const total = readdirSync(DIR).reduce((n, name) => n + statSync(join(DIR, name)).size, 0);
    expect(total).toBeLessThan(80 * 1024);
  });

  it('top-level resource entries tile the file; each starts with tag 0x0a and a matching varint length', () => {
    for (const f of stored.filter((x) => x.parse_ok)) {
      const bytes = readFileSync(join(DIR, f.file as string));
      expect(f.entries.length, f.file as string).toBeGreaterThan(0);
      let at = 0;
      for (const e of f.entries) {
        expect(e.start, f.file as string).toBe(at);
        expect(bytes[e.start]).toBe(0x0a);
        let len = 0;
        let shift = 0;
        let i = e.start + 1;
        for (;;) {
          const b = bytes[i++];
          len += (b & 0x7f) * 2 ** shift;
          if (!(b & 0x80)) break;
          shift += 7;
        }
        expect(i + len, f.file as string).toBe(e.end);
        at = e.end;
      }
      expect(at, f.file as string).toBe(bytes.length);
    }
  });

  it('unparseable fixtures carry no entries; the concatenated stream has 3', () => {
    for (const f of stored.filter((x) => x.parse_ok === false)) {
      expect(f.expected_verdict).toBe('otlp_unparseable');
      expect(f.entries).toEqual([]);
    }
    expect(manifest.fixtures.find((f) => f.file === 'logs-concatenated-3-records.bin')?.entries).toHaveLength(3);
  });

  it('ok fixtures observe only the expected session id and project (case-insensitive)', () => {
    for (const f of stored.filter((x) => x.expected_verdict === 'ok')) {
      const sess = f.session_observations.filter((o) => !o.where.startsWith('resource'));
      expect(sess.length, f.file as string).toBeGreaterThan(0);
      for (const o of f.session_observations) {
        if (o.value === '') continue; // empty session.id with session_id fallback fixture
        expect(o.value, f.file as string).toBe(manifest.expected_session_id);
      }
      for (const o of f.project_observations) {
        if (typeof o.value === 'string' && o.value.trim() === '') continue;
        expect(String(o.value).toLowerCase(), f.file as string).toBe(manifest.expected_project);
      }
    }
  });

  it('negative fixtures show the observation that justifies their verdict', () => {
    const get = (n: string): Fixture => manifest.fixtures.find((f) => f.file === n) as Fixture;
    const rec = (f: Fixture): Obs[] => f.session_observations.filter((o) => !o.where.startsWith('resource'));
    expect(rec(get('logs-resource-only-session-id.bin'))).toEqual([]);
    expect(get('logs-resource-only-session-id.bin').session_observations).toHaveLength(1);
    expect(rec(get('logs-lookalike-id-in-body.bin'))).toEqual([]);
    expect(new Set(rec(get('logs-mixed-ids.bin')).map((o) => o.value)).size).toBe(2);
    expect(rec(get('logs-non-string-id-int.bin'))[0]).toMatchObject({ type: 'int', value: 12345 });
    expect(rec(get('logs-empty-string-id.bin'))[0]).toMatchObject({ type: 'string', value: '' });
    const contra = rec(get('logs-session-id-vs-session_id-contradiction.bin'));
    expect(contra.map((o) => o.key).sort()).toEqual(['session.id', 'session_id']);
    expect(new Set(contra.map((o) => o.value)).size).toBe(2);
    expect(rec(get('traces-session_id-only-not-a-source.bin'))[0].key).toBe('session_id');
    expect(new Set(get('logs-project-conflict-two-records.bin').project_observations.map((o) => o.value)).size).toBe(2);
    const pc = get('logs-project-conflict-resource-vs-record.bin').project_observations;
    expect(pc.map((o) => o.where.split('[')[0]).sort()).toEqual(['record', 'resource']);
    const big = get('logs-257-plus-attributes.bin');
    expect((big as unknown as { max_attrs_on_a_unit: number }).max_attrs_on_a_unit).toBeGreaterThan(256);
  });

  it('covers all five metric data-point kinds', () => {
    const names = stored.filter((f) => f.signal === 'metrics').map((f) => f.file as string);
    for (const k of ['gauge', 'sum', 'histogram', 'summary', 'exp_histogram']) {
      expect(names.some((n) => n.startsWith(`metrics-${k}-`)), k).toBe(true);
    }
  });

  it('the oversized case is generated in-test, never stored', () => {
    const f = manifest.fixtures.find((x) => x.generated_in_test) as Fixture;
    expect(f).toMatchObject({ file: null, expected_verdict: 'otlp_unparseable', size: MAX_SNAPSHOT_BYTES + 1 });
    const body = Buffer.alloc(f.size);
    expect(body.length).toBeGreaterThan(manifest.max_snapshot_bytes);
  });
});
