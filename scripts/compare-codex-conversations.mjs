#!/usr/bin/env node

/**
 * Compare raw Codex rollout transcripts against CodeMie session metadata and
 * extracted conversation payloads.
 *
 * Purpose:
 * - scan Codex rollout files under ~/.codex/sessions
 * - find the corresponding CodeMie codex session under ~/.codemie/sessions
 * - inspect the generated conversation payload file
 * - highlight mismatches in key areas (matching, ids, user/assistant counts,
 *   commentary leakage, missing final answers)
 *
 * Notes:
 * - Codex rollout ids are external session ids, not CodeMie session ids.
 * - Matching first uses explicit ids, then conversation payload ids, then a
 *   cwd + time heuristic.
 * - Conversation files are JSONL. We support a few filename variants to make
 *   investigation resilient to typos and historical naming.
 */

import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';

const DEFAULT_CODEX_HOME = join(homedir(), '.codex');
const DEFAULT_CODEMIE_SESSIONS = join(homedir(), '.codemie', 'sessions');
const DEFAULT_TIME_WINDOW_MINUTES = 180;
const MAX_SAMPLE_MESSAGES = 3;

function parseArgs(argv) {
  const options = {
    codexHome: DEFAULT_CODEX_HOME,
    codemieSessions: DEFAULT_CODEMIE_SESSIONS,
    sessionId: undefined,
    limit: undefined,
    json: false,
    timeWindowMinutes: DEFAULT_TIME_WINDOW_MINUTES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--codex-home') {
      options.codexHome = resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--codemie-sessions') {
      options.codemieSessions = resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--session-id') {
      options.sessionId = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === '--time-window-minutes') {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.timeWindowMinutes = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`compare-codex-conversations

Usage:
  node scripts/compare-codex-conversations.mjs [options]

Options:
  --codex-home <path>           Codex home directory (default: ~/.codex)
  --codemie-sessions <path>     CodeMie sessions directory (default: ~/.codemie/sessions)
  --session-id <id>             Only inspect a single Codex external session id
  --limit <n>                   Only inspect the newest N rollout files
  --time-window-minutes <n>     Heuristic session-match window in minutes (default: 180)
  --json                        Print JSON report
  --help, -h                    Show help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.codexHome)) {
    throw new Error(`Codex home does not exist: ${options.codexHome}`);
  }

  if (!existsSync(options.codemieSessions)) {
    throw new Error(`CodeMie sessions directory does not exist: ${options.codemieSessions}`);
  }

  const rollouts = await collectCodexRollouts(join(options.codexHome, 'sessions'));
  const filteredRollouts = rollouts
    .filter((rollout) => !options.sessionId || rollout.externalSessionId === options.sessionId)
    .sort((left, right) => right.startedAtMs - left.startedAtMs);

  const rolloutSlice = options.limit ? filteredRollouts.slice(0, options.limit) : filteredRollouts;
  const codemieSessions = await loadCodemieSessions(options.codemieSessions);
  const report = buildReport(rolloutSlice, codemieSessions, options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHumanReport(report, options);
}

async function collectCodexRollouts(codexSessionsPath) {
  if (!existsSync(codexSessionsPath)) {
    return [];
  }

  const rolloutFiles = await findFilesRecursive(codexSessionsPath, (entry) =>
    entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')
  );

  const results = [];

  for (const filePath of rolloutFiles) {
    const analysis = await analyzeCodexRollout(filePath);
    if (analysis) {
      results.push(analysis);
    }
  }

  return results;
}

async function analyzeCodexRollout(filePath) {
  const lines = await readJsonlTolerant(filePath);
  if (lines.length === 0) {
    return null;
  }

  let sessionMeta;
  let lastTurnContext;

  const eventUsers = [];
  const responseUsers = [];
  const assistantCommentary = [];
  const assistantFinal = [];
  const assistantOther = [];

  for (const [index, record] of lines.entries()) {
    if (record?.type === 'session_meta') {
      sessionMeta = record.payload;
      continue;
    }

    if (record?.type === 'turn_context') {
      lastTurnContext = record.payload;
      continue;
    }

    if (record?.type === 'event_msg') {
      const payload = record.payload ?? {};
      if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
        eventUsers.push(createMessageSummary({
          text: payload.message,
          timestamp: record.timestamp ?? sessionMeta?.timestamp,
          sourceIndex: index,
          sourceType: 'event_user_message',
        }));
      }
      continue;
    }

    if (record?.type !== 'response_item') {
      continue;
    }

    const payload = record.payload ?? {};
    if (payload.type !== 'message') {
      continue;
    }

    const role = typeof payload.role === 'string' ? payload.role : undefined;
    const phase = typeof payload.phase === 'string' ? payload.phase : undefined;
    const text = extractCodexText(payload.content ?? payload.output);
    if (!text) {
      continue;
    }

    const summary = createMessageSummary({
      text,
      timestamp: record.timestamp ?? sessionMeta?.timestamp,
      sourceIndex: index,
      sourceType: `response_${role ?? 'unknown'}_${phase ?? 'none'}`,
    });

    if (role === 'user') {
      responseUsers.push(summary);
      continue;
    }

    if (role === 'assistant' && phase === 'final_answer') {
      assistantFinal.push(summary);
      continue;
    }

    if (role === 'assistant' && phase === 'commentary') {
      assistantCommentary.push(summary);
      continue;
    }

    if (role === 'assistant') {
      assistantOther.push(summary);
    }
  }

  if (!sessionMeta?.id) {
    return null;
  }

  const fileStats = await stat(filePath);
  const startedAtMs = toTimestampMs(sessionMeta.timestamp) ?? fileStats.mtimeMs;
  const expectedUsers = dedupeMessages([...eventUsers, ...responseUsers]);
  const model = stringOrUndefined(lastTurnContext?.model) ?? stringOrUndefined(sessionMeta.model_provider);

  return {
    filePath,
    fileName: basename(filePath),
    externalSessionId: sessionMeta.id,
    startedAtMs,
    metadata: {
      cwd: stringOrUndefined(sessionMeta.cwd),
      timestamp: stringOrUndefined(sessionMeta.timestamp),
      cliVersion: stringOrUndefined(sessionMeta.cli_version),
      model,
    },
    counts: {
      rawRecords: lines.length,
      eventUsers: eventUsers.length,
      responseUsers: responseUsers.length,
      expectedUsers: expectedUsers.length,
      assistantFinal: assistantFinal.length,
      assistantCommentary: assistantCommentary.length,
      assistantOther: assistantOther.length,
    },
    messages: {
      eventUsers,
      responseUsers,
      expectedUsers,
      assistantFinal,
      assistantCommentary,
      assistantOther,
    },
  };
}

async function loadCodemieSessions(codemieSessionsPath) {
  const entries = await readdir(codemieSessionsPath);
  const sessions = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const filePath = join(codemieSessionsPath, entry);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    } catch {
      continue;
    }

    if (parsed?.agentName !== 'codex') {
      continue;
    }

    const baseName = entry.slice(0, -'.json'.length);
    const conversationFile = await findConversationFile(codemieSessionsPath, baseName);
    const conversationAnalysis = conversationFile
      ? await analyzeCodemieConversationFile(conversationFile)
      : null;

    sessions.push({
      filePath,
      fileName: entry,
      baseName,
      sessionId: parsed.sessionId,
      raw: parsed,
      startedAtMs: typeof parsed.startTime === 'number' ? parsed.startTime : undefined,
      matchKeys: collectCodemieMatchKeys(parsed, conversationAnalysis),
      conversationFile,
      conversationAnalysis,
    });
  }

  return sessions;
}

async function findConversationFile(dirPath, baseName) {
  const candidates = [
    `${baseName}_conversation.jsonl`,
    `${baseName}_conversations.jsonl`,
    `${baseName}_conversations.json`,
    `${baseName}_converations.jsonl`,
    `${baseName}_converations.json`,
  ];

  for (const candidate of candidates) {
    const fullPath = join(dirPath, candidate);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

async function analyzeCodemieConversationFile(filePath) {
  const records = await readJsonlTolerant(filePath);
  const historyEntries = [];
  const payloadConversationIds = new Set();
  const lastProcessedSourceIndices = [];

  for (const record of records) {
    const conversationId = record?.payload?.conversationId;
    if (typeof conversationId === 'string' && conversationId.trim()) {
      payloadConversationIds.add(conversationId);
    }

    const history = Array.isArray(record?.payload?.history) ? record.payload.history : [];
    for (const entry of history) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const role = typeof entry.role === 'string' ? entry.role : undefined;
      const message = typeof entry.message === 'string' ? entry.message : undefined;
      if (!role || !message || !message.trim()) {
        continue;
      }

      historyEntries.push(createMessageSummary({
        text: message,
        timestamp: typeof entry.date === 'string' ? entry.date : undefined,
        sourceIndex: typeof entry.history_index === 'number' ? entry.history_index : undefined,
        sourceType: role,
      }));
    }

    const lastProcessed = typeof record?.lastProcessedMessageUuid === 'string'
      ? record.lastProcessedMessageUuid
      : undefined;
    const parsedIndex = parseTrailingSourceIndex(lastProcessed);
    if (parsedIndex !== undefined) {
      lastProcessedSourceIndices.push(parsedIndex);
    }
  }

  const userEntries = dedupeMessages(historyEntries.filter((entry) => entry.sourceType === 'User'));
  const assistantEntries = dedupeMessages(historyEntries.filter((entry) => entry.sourceType === 'Assistant'));

  return {
    filePath,
    payloadCount: records.length,
    payloadConversationIds: [...payloadConversationIds],
    maxLastProcessedSourceIndex: lastProcessedSourceIndices.length > 0
      ? Math.max(...lastProcessedSourceIndices)
      : undefined,
    counts: {
      historyEntries: historyEntries.length,
      userEntries: userEntries.length,
      assistantEntries: assistantEntries.length,
    },
    messages: {
      userEntries,
      assistantEntries,
    },
  };
}

function collectCodemieMatchKeys(session, conversationAnalysis) {
  const keys = new Set();

  const correlationAgentSessionId = session?.correlation?.agentSessionId;
  const runtimeExternalId = session?.runtimeCheckpoint?.externalSessionId;
  const syncConversationId = session?.sync?.conversations?.conversationId;

  for (const value of [
    correlationAgentSessionId,
    runtimeExternalId,
    syncConversationId,
    ...(conversationAnalysis?.payloadConversationIds ?? []),
  ]) {
    if (typeof value === 'string' && value.trim() && value !== 'unknown') {
      keys.add(value);
    }
  }

  return [...keys];
}

function buildReport(rollouts, codemieSessions, options) {
  const comparisons = rollouts.map((rollout) =>
    compareRolloutToCodemie(rollout, codemieSessions, options)
  );

  const summary = {
    rolloutCount: comparisons.length,
    matchedCount: comparisons.filter((item) => item.match.found).length,
    unmatchedCount: comparisons.filter((item) => !item.match.found).length,
    missingConversationFileCount: comparisons.filter((item) =>
      item.match.found && !item.codemie?.conversation?.exists
    ).length,
    conversationIdMismatchCount: comparisons.filter((item) =>
      item.comparison.problems.some((problem) => problem.code === 'conversation_id_mismatch')
    ).length,
    commentaryLeakCount: comparisons.filter((item) =>
      item.comparison.problems.some((problem) => problem.code === 'assistant_commentary_leak')
    ).length,
    missingFinalAnswerCount: comparisons.filter((item) =>
      item.comparison.problems.some((problem) => problem.code === 'missing_final_answers')
    ).length,
    missingUserMessageCount: comparisons.filter((item) =>
      item.comparison.problems.some((problem) => problem.code === 'missing_user_messages')
    ).length,
  };

  return {
    scannedAt: new Date().toISOString(),
    options,
    summary,
    comparisons,
  };
}

function compareRolloutToCodemie(rollout, codemieSessions, options) {
  const matched = findBestCodemieMatch(rollout, codemieSessions, options.timeWindowMinutes);
  const codemie = matched?.session;

  const comparison = {
    problems: [],
    overlaps: undefined,
  };

  if (!codemie) {
    comparison.problems.push({
      code: 'no_codemie_session_match',
      message: 'No matching CodeMie codex session was found',
    });
  } else if (!codemie.conversationAnalysis) {
    comparison.problems.push({
      code: 'missing_conversation_file',
      message: 'CodeMie session exists, but no conversation payload file was found',
    });
  } else {
    const extracted = codemie.conversationAnalysis;
    const sourceUsers = rollout.messages.expectedUsers;
    const sourceFinal = rollout.messages.assistantFinal;
    const sourceCommentary = rollout.messages.assistantCommentary;
    const extractedUsers = extracted.messages.userEntries;
    const extractedAssistant = extracted.messages.assistantEntries;

    const overlap = {
      sourceUsers: compareMessageSets(sourceUsers, extractedUsers),
      sourceFinalAnswers: compareMessageSets(sourceFinal, extractedAssistant),
      sourceCommentaryVsExtractedAssistant: compareMessageSets(sourceCommentary, extractedAssistant),
    };
    comparison.overlaps = overlap;

    if (sourceUsers.length > extractedUsers.length || overlap.sourceUsers.missing.length > 0) {
      comparison.problems.push({
        code: 'missing_user_messages',
        message: 'Extracted conversation is missing user messages from the rollout',
        details: {
          sourceUsers: sourceUsers.length,
          extractedUsers: extractedUsers.length,
          missingExamples: overlap.sourceUsers.missing.slice(0, MAX_SAMPLE_MESSAGES),
        },
      });
    }

    if (sourceFinal.length > extractedAssistant.length || overlap.sourceFinalAnswers.missing.length > 0) {
      comparison.problems.push({
        code: 'missing_final_answers',
        message: 'Extracted conversation is missing assistant final answers from the rollout',
        details: {
          sourceFinalAnswers: sourceFinal.length,
          extractedAssistant: extractedAssistant.length,
          missingExamples: overlap.sourceFinalAnswers.missing.slice(0, MAX_SAMPLE_MESSAGES),
        },
      });
    }

    if (overlap.sourceCommentaryVsExtractedAssistant.matched.length > 0) {
      comparison.problems.push({
        code: 'assistant_commentary_leak',
        message: 'Commentary assistant messages were extracted into the conversation payload',
        details: {
          leakedCount: overlap.sourceCommentaryVsExtractedAssistant.matched.length,
          leakedExamples: overlap.sourceCommentaryVsExtractedAssistant.matched.slice(0, MAX_SAMPLE_MESSAGES),
        },
      });
    }

    const extractedConversationIds = extracted.payloadConversationIds;
    if (
      extractedConversationIds.length > 0 &&
      !extractedConversationIds.includes(rollout.externalSessionId)
    ) {
      comparison.problems.push({
        code: 'conversation_id_mismatch',
        message: 'Conversation payload ids do not contain the Codex rollout session id',
        details: {
          codexExternalSessionId: rollout.externalSessionId,
          payloadConversationIds: extractedConversationIds,
        },
      });
    }

    if (extractedConversationIds.length > 1) {
      comparison.problems.push({
        code: 'multiple_conversation_ids',
        message: 'Conversation payload file contains multiple conversation ids for one CodeMie session',
        details: {
          payloadConversationIds: extractedConversationIds,
        },
      });
    }
  }

  return {
    codex: {
      externalSessionId: rollout.externalSessionId,
      filePath: rollout.filePath,
      metadata: rollout.metadata,
      counts: rollout.counts,
      samples: {
        expectedUsers: sampleMessages(rollout.messages.expectedUsers),
        assistantFinal: sampleMessages(rollout.messages.assistantFinal),
        assistantCommentary: sampleMessages(rollout.messages.assistantCommentary),
      },
    },
    match: matched
      ? {
          found: true,
          method: matched.method,
          score: matched.score,
          timeDeltaMs: matched.timeDeltaMs,
        }
      : {
          found: false,
        },
    codemie: codemie
      ? {
          sessionId: codemie.sessionId,
          filePath: codemie.filePath,
          status: codemie.raw?.status,
          workingDirectory: codemie.raw?.workingDirectory,
          correlationAgentSessionId: codemie.raw?.correlation?.agentSessionId,
          syncConversationId: codemie.raw?.sync?.conversations?.conversationId,
          conversation: codemie.conversationAnalysis
            ? {
                exists: true,
                filePath: codemie.conversationFile,
                payloadConversationIds: codemie.conversationAnalysis.payloadConversationIds,
                counts: codemie.conversationAnalysis.counts,
                samples: {
                  userEntries: sampleMessages(codemie.conversationAnalysis.messages.userEntries),
                  assistantEntries: sampleMessages(codemie.conversationAnalysis.messages.assistantEntries),
                },
              }
            : {
                exists: false,
              },
        }
      : null,
    comparison,
  };
}

function findBestCodemieMatch(rollout, codemieSessions, timeWindowMinutes) {
  const explicitMatches = codemieSessions
    .filter((session) => session.matchKeys.includes(rollout.externalSessionId))
    .map((session) => ({
      session,
      method: 'explicit_id',
      score: 100,
      timeDeltaMs: absoluteTimeDelta(rollout.startedAtMs, session.startedAtMs),
    }));

  if (explicitMatches.length > 0) {
    return explicitMatches.sort(compareMatches)[0];
  }

  const maxTimeDeltaMs = timeWindowMinutes * 60 * 1000;
  const heuristicMatches = codemieSessions
    .filter((session) => session.raw?.workingDirectory === rollout.metadata.cwd)
    .map((session) => ({
      session,
      method: 'cwd_and_time',
      score: scoreHeuristicMatch(rollout, session, maxTimeDeltaMs),
      timeDeltaMs: absoluteTimeDelta(rollout.startedAtMs, session.startedAtMs),
    }))
    .filter((match) => match.score > 0);

  if (heuristicMatches.length > 0) {
    return heuristicMatches.sort(compareMatches)[0];
  }

  return null;
}

function scoreHeuristicMatch(rollout, session, maxTimeDeltaMs) {
  const timeDeltaMs = absoluteTimeDelta(rollout.startedAtMs, session.startedAtMs);
  if (timeDeltaMs === undefined || timeDeltaMs > maxTimeDeltaMs) {
    return 0;
  }

  const branchMatches =
    stringOrUndefined(session.raw?.gitBranch) &&
    stringOrUndefined(session.raw?.gitBranch) === stringOrUndefined(rollout.metadata.branch);

  const timeScore = Math.max(1, 60 - Math.floor(timeDeltaMs / 60000));
  return timeScore + (branchMatches ? 10 : 0);
}

function compareMatches(left, right) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const leftDelta = left.timeDeltaMs ?? Number.MAX_SAFE_INTEGER;
  const rightDelta = right.timeDeltaMs ?? Number.MAX_SAFE_INTEGER;
  return leftDelta - rightDelta;
}

function compareMessageSets(sourceMessages, targetMessages) {
  const targetPool = targetMessages.map((message) => normalizeText(message.text));
  const matched = [];
  const missing = [];

  for (const message of sourceMessages) {
    const normalized = normalizeText(message.text);
    const foundIndex = targetPool.indexOf(normalized);
    if (foundIndex >= 0) {
      matched.push(sampleMessage(message));
      targetPool.splice(foundIndex, 1);
    } else {
      missing.push(sampleMessage(message));
    }
  }

  return {
    matched,
    missing,
  };
}

function createMessageSummary({ text, timestamp, sourceIndex, sourceType }) {
  return {
    text,
    timestamp: typeof timestamp === 'string' ? timestamp : undefined,
    sourceIndex,
    sourceType,
  };
}

function sampleMessages(messages) {
  return messages.slice(0, MAX_SAMPLE_MESSAGES).map(sampleMessage);
}

function sampleMessage(message) {
  return {
    text: shorten(message.text, 200),
    timestamp: message.timestamp,
    sourceIndex: message.sourceIndex,
    sourceType: message.sourceType,
  };
}

function dedupeMessages(messages) {
  const seen = new Set();
  const deduped = [];

  for (const message of messages) {
    const key = `${message.sourceType}|${message.sourceIndex ?? ''}|${normalizeText(message.text)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(message);
  }

  return deduped;
}

function extractCodexText(content) {
  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text;
        }
        return undefined;
      })
      .filter((item) => typeof item === 'string' && item.trim());

    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  if (content && typeof content === 'object' && typeof content.text === 'string' && content.text.trim()) {
    return content.text;
  }

  return undefined;
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function shorten(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function parseTrailingSourceIndex(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const index = Number.parseInt(value.slice(value.lastIndexOf('@') + 1), 10);
  return Number.isFinite(index) ? index : undefined;
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }

  return undefined;
}

function absoluteTimeDelta(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return undefined;
  }

  return Math.abs(left - right);
}

async function readJsonlTolerant(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const lines = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      lines.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines during investigation.
    }
  }

  return lines;
}

async function findFilesRecursive(rootPath, include) {
  const results = [];
  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findFilesRecursive(entryPath, include));
      continue;
    }

    if (include(entry)) {
      results.push(entryPath);
    }
  }

  return results;
}

function printHumanReport(report, options) {
  const { summary, comparisons } = report;

  console.log('Codex conversation comparison');
  console.log(`- scanned at: ${report.scannedAt}`);
  console.log(`- codex home: ${options.codexHome}`);
  console.log(`- codemie sessions: ${options.codemieSessions}`);
  console.log(`- rollout files scanned: ${summary.rolloutCount}`);
  console.log(`- matched sessions: ${summary.matchedCount}`);
  console.log(`- unmatched sessions: ${summary.unmatchedCount}`);
  console.log(`- missing conversation files: ${summary.missingConversationFileCount}`);
  console.log(`- conversation id mismatches: ${summary.conversationIdMismatchCount}`);
  console.log(`- commentary leaks: ${summary.commentaryLeakCount}`);
  console.log(`- missing final answers: ${summary.missingFinalAnswerCount}`);
  console.log(`- missing user messages: ${summary.missingUserMessageCount}`);

  const problematic = comparisons.filter((item) => item.comparison.problems.length > 0);
  if (problematic.length === 0) {
    console.log('\nNo obvious mismatches found.');
    return;
  }

  console.log(`\nProblem sessions (${problematic.length}):`);

  for (const item of problematic) {
    console.log(`\n- codex session: ${item.codex.externalSessionId}`);
    console.log(`  rollout: ${item.codex.filePath}`);
    console.log(`  match: ${item.match.found ? `${item.match.method} (score=${item.match.score})` : 'none'}`);

    if (item.codemie) {
      console.log(`  codemie session: ${item.codemie.sessionId}`);
      console.log(`  status: ${item.codemie.status}`);
      console.log(`  conversation file: ${item.codemie.conversation.exists ? item.codemie.conversation.filePath : 'missing'}`);
    }

    console.log(`  source counts: users=${item.codex.counts.expectedUsers} finals=${item.codex.counts.assistantFinal} commentary=${item.codex.counts.assistantCommentary}`);

    if (item.codemie?.conversation?.exists) {
      console.log(`  extracted counts: users=${item.codemie.conversation.counts.userEntries} assistant=${item.codemie.conversation.counts.assistantEntries}`);
      if (item.codemie.conversation.payloadConversationIds.length > 0) {
        console.log(`  payload ids: ${item.codemie.conversation.payloadConversationIds.join(', ')}`);
      }
    }

    for (const problem of item.comparison.problems) {
      console.log(`  * ${problem.code}: ${problem.message}`);
      if (problem.details?.missingExamples?.length > 0) {
        console.log(`    missing examples: ${problem.details.missingExamples.map((entry) => JSON.stringify(entry.text)).join(' | ')}`);
      }
      if (problem.details?.leakedExamples?.length > 0) {
        console.log(`    leaked examples: ${problem.details.leakedExamples.map((entry) => JSON.stringify(entry.text)).join(' | ')}`);
      }
    }
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
