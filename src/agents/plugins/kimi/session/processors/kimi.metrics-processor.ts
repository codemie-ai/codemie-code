/**
 * Kimi Metrics Processor
 *
 * Extracts metrics from Kimi Code session wire events and writes them as
 * incremental MetricDelta records to the shared session metrics JSONL store.
 *
 * Unlike the previous one-delta-per-session implementation, this processor emits
 * one delta per completed assistant step, matching the per-message granularity
 * used by the Claude metrics processor. The shared analytics aggregator sums
 * these deltas into session/branch/project totals.
 *
 * Responsibilities:
 * - Detect Kimi Code sessions
 * - Emit one MetricDelta per completed step (identified by step.end event uuid)
 * - Count tool calls and results within each step
 * - Track file operations from display metadata nested inside loop events
 * - Capture user prompts, skill/agent invocations, and branch info
 * - Write incremental metric deltas to ~/.codemie/sessions/{sessionId}_metrics.jsonl
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta, FileOperationType, FileOperation } from '../../../../core/metrics/types.js';
import { logger } from '../../../../../utils/logger.js';
import type { KimiWireEvent, KimiWireEventDisplay } from '../types.js';

interface StepBucket {
  uuid: string;
  turnId: string;
  step: number;
  timestamp: number;
  toolCalls: Array<KimiWireEvent & { event: { name: string; toolCallId: string; uuid?: string } }>;
  toolResults: KimiWireEvent[];
  displays: KimiWireEventDisplay[];
}

export class KimiMetricsProcessor implements SessionProcessor {
  readonly name = 'kimi-metrics';
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.agentName === 'Kimi Code';
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const messages = session.messages as KimiWireEvent[];

      if (messages.length === 0) {
        logger.debug(`[${this.name}] No wire events to process for session ${session.sessionId}`);
        return { success: true, message: 'No wire events to process' };
      }

      const { MetricsWriter } = await import(
        '../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js'
      );
      const writer = new MetricsWriter(session.sessionId);

      let existingDeltas: MetricDelta[] = [];
      try {
        existingDeltas = await writer.readAll();
      } catch (error) {
        logger.debug(`[${this.name}] Could not read existing deltas: ${error instanceof Error ? error.message : String(error)}`);
      }
      const processedStepUuids = new Set(existingDeltas.map((d) => d.recordId));

      const steps = this.extractSteps(messages);
      const turnPrompts = this.extractTurnPrompts(messages);
      const sessionModel = (session.metadata as { model?: string }).model;
      const gitBranch = session.metadata?.gitBranch ?? session.metadata?.branch;

      const newDeltas: Array<Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>> = [];
      const promptedTurns = new Set<string>();

      for (const step of steps) {
        if (processedStepUuids.has(step.uuid)) {
          continue;
        }

        const { tools, toolStatus, fileOperations } = this.buildStepMetrics(step);
        const isFirstStepOfTurn = !promptedTurns.has(step.turnId);
        const userPrompts = isFirstStepOfTurn
          ? this.turnPromptToArray(turnPrompts.get(step.turnId))
          : [];
        if (userPrompts.length > 0) {
          promptedTurns.add(step.turnId);
        }
        const { skillInvocations, agentInvocations } = this.buildStepNamedInvocations(step);
        const commandInvocations = isFirstStepOfTurn
          ? this.buildStepCommandInvocations(step, turnPrompts.get(step.turnId))
          : {};

        const delta: Omit<MetricDelta, 'syncStatus' | 'syncAttempts'> = {
          recordId: step.uuid,
          sessionId: session.sessionId,
          agentSessionId: context.agentSessionId || session.sessionId,
          timestamp: step.timestamp,
          ...(gitBranch && { gitBranch }),
          ...(Object.keys(tools).length > 0 && { tools }),
          ...(Object.keys(toolStatus).length > 0 && { toolStatus }),
          ...(fileOperations.length > 0 && { fileOperations }),
          ...(userPrompts.length > 0 && { userPrompts }),
          ...(Object.keys(skillInvocations).length > 0 && { skillInvocations }),
          ...(Object.keys(agentInvocations).length > 0 && { agentInvocations }),
          ...(Object.keys(commandInvocations).length > 0 && { commandInvocations }),
          ...(sessionModel && { models: [sessionModel] }),
        };

        newDeltas.push(delta);
      }

      for (const delta of newDeltas) {
        await writer.appendDelta(delta);
      }

      // Preserve in-memory summary of the latest step for callers/tests.
      const lastStep = steps[steps.length - 1];
      if (lastStep) {
        const { tools, toolStatus, fileOperations } = this.buildStepMetrics(lastStep);
        const lastIsFirstStepOfTurn = lastStep.step === Math.min(...steps.filter((s) => s.turnId === lastStep.turnId).map((s) => s.step));
        session.metrics = {
          tools,
          toolStatus,
          fileOperations,
          userPrompts: lastIsFirstStepOfTurn ? this.turnPromptToArray(turnPrompts.get(lastStep.turnId)) : [],
          ...this.buildStepNamedInvocations(lastStep),
          commandInvocations: lastIsFirstStepOfTurn
            ? this.buildStepCommandInvocations(lastStep, turnPrompts.get(lastStep.turnId))
            : {},
        };
      }

      logger.info(`[${this.name}] Wrote ${newDeltas.length} metric delta(s) for session ${session.sessionId}`);
      logger.debug(`[${this.name}] Metrics file: ${writer.getFilePath()}`);

      return {
        success: true,
        message: `Generated ${newDeltas.length} delta(s)`,
        metadata: {
          recordsProcessed: messages.length,
          deltasWritten: newDeltas.length,
          syncUpdates: {
            metrics: {
              processedRecordIds: newDeltas.map((d) => d.recordId),
              lastProcessedTimestamp: Date.now(),
              totalDeltas: newDeltas.length
            }
          }
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[${this.name}] Processing failed:`, error);

      return {
        success: false,
        message: `Metrics processing failed: ${errorMessage}`
      };
    }
  }

  private extractSteps(events: KimiWireEvent[]): StepBucket[] {
    const stepEnds: StepBucket[] = [];
    const toolCalls: Array<KimiWireEvent & { event: { name: string; toolCallId: string; uuid?: string } }> = [];
    const toolResults: KimiWireEvent[] = [];
    const displays: Array<{ stepUuid?: string; display: KimiWireEventDisplay }> = [];
    const stepBeginUuids = new Map<string, { turnId: string; step: number }>();

    for (const event of events) {
      if (event.type !== 'context.append_loop_event' || !event.event) {
        continue;
      }

      const ev = event.event;

      if (ev.type === 'step.begin' && typeof ev.uuid === 'string') {
        stepBeginUuids.set(ev.uuid, { turnId: String(ev.turnId ?? '0'), step: Number(ev.step ?? 0) });
      }

      if (
        ev.type === 'tool.call' &&
        typeof ev.toolCallId === 'string' &&
        typeof ev.name === 'string'
      ) {
        toolCalls.push(event as KimiWireEvent & { event: { name: string; toolCallId: string; uuid?: string } });
      }

      if (ev.type === 'tool.result' && ev.result) {
        toolResults.push(event);
      }

      const display = this.resolveDisplay(event);
      if (display) {
        displays.push({ stepUuid: ev.stepUuid, display });
      }
    }

    // Build buckets from step.end events, matching related events by stepUuid.
    for (const event of events) {
      if (
        event.type !== 'context.append_loop_event' ||
        event.event?.type !== 'step.end' ||
        typeof event.event.uuid !== 'string'
      ) {
        continue;
      }

      const stepUuid = event.event.uuid;
      const beginInfo = stepBeginUuids.get(stepUuid);
      const turnId = beginInfo?.turnId ?? String(event.event.turnId ?? '0');
      const stepNumber = beginInfo?.step ?? Number(event.event.step ?? 0);

      const bucket: StepBucket = {
        uuid: stepUuid,
        turnId,
        step: stepNumber,
        timestamp: typeof event.time === 'number' ? event.time : Date.now(),
        toolCalls: toolCalls.filter((tc) => tc.event.stepUuid === stepUuid),
        toolResults: toolResults.filter((tr) => tr.event?.stepUuid === stepUuid),
        displays: displays
          .filter((d) => d.stepUuid === stepUuid)
          .map((d) => d.display),
      };

      stepEnds.push(bucket);
    }

    // Preserve chronological order by timestamp.
    stepEnds.sort((a, b) => a.timestamp - b.timestamp);
    return stepEnds;
  }

  private extractTurnPrompts(events: KimiWireEvent[]): Map<string, string> {
    const map = new Map<string, string>();
    let currentTurnId = '0';

    for (const event of events) {
      if (event.type === 'turn.prompt') {
        if (typeof event.event?.turnId === 'string') {
          currentTurnId = event.event.turnId;
        }
        const text = this.extractTextContent(event);
        if (text) {
          map.set(currentTurnId, text);
        }
      }

      if (event.type === 'context.append_message' && event.message?.role === 'user') {
        const origin = event.message.origin;
        if (origin?.kind === 'user') {
          const text = this.extractTextContentFromMessage(event.message);
          if (text) {
            // Prefer the explicit turnId on the message when available.
            const turnId = event.event?.turnId ? String(event.event.turnId) : currentTurnId;
            map.set(turnId, text);
          }
        }
      }
    }

    return map;
  }

  private turnPromptToArray(text: string | undefined): Array<{ count: number; text: string }> {
    return text ? [{ count: 1, text }] : [];
  }

  private buildStepMetrics(step: StepBucket): {
    tools: Record<string, number>;
    toolStatus: Record<string, { success: number; failure: number }>;
    fileOperations: FileOperation[];
  } {
    const tools: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const fileOperations: FileOperation[] = [];

    const toolCallById = new Map<string, KimiWireEvent & { event: { name: string; toolCallId: string; uuid?: string } }>();

    for (const toolCall of step.toolCalls) {
      const toolName = toolCall.event.name;
      tools[toolName] = (tools[toolName] || 0) + 1;
      if (!toolStatus[toolName]) {
        toolStatus[toolName] = { success: 0, failure: 0 };
      }
      toolCallById.set(toolCall.event.toolCallId, toolCall);
      if (typeof toolCall.event.uuid === 'string') {
        toolCallById.set(toolCall.event.uuid, toolCall);
      }
    }

    for (const resultEvent of step.toolResults) {
      const ev = resultEvent.event;
      if (!ev) continue;
      const matchedToolCall =
        (typeof ev.toolCallId === 'string' && toolCallById.get(ev.toolCallId)) ||
        (typeof ev.parentUuid === 'string' && toolCallById.get(ev.parentUuid));

      if (!matchedToolCall) {
        continue;
      }

      const toolName = matchedToolCall.event.name;
      const isError = ev.result?.isError === true;
      if (isError) {
        toolStatus[toolName].failure++;
      } else {
        toolStatus[toolName].success++;
      }
    }

    for (const display of step.displays) {
      if (display.kind !== 'file_io') {
        continue;
      }
      const operation = display.operation;
      if (operation !== 'read' && operation !== 'write' && operation !== 'edit' && operation !== 'delete') {
        continue;
      }

      const fileOp: FileOperation = {
        type: operation as FileOperationType,
        path: typeof display.path === 'string' ? display.path : undefined,
      };

      if (fileOp.path) {
        const language = this.deriveLanguage(fileOp.path);
        const format = this.deriveFormat(fileOp.path);
        if (language) fileOp.language = language;
        if (format) fileOp.format = format;
      }

      if (typeof display.before === 'string' && typeof display.after === 'string') {
        const lineStats = this.computeLineChanges(display.before, display.after);
        fileOp.linesAdded = lineStats.linesAdded;
        fileOp.linesRemoved = lineStats.linesRemoved;
        fileOp.linesModified = lineStats.linesModified;
      }

      fileOperations.push(fileOp);
    }

    return { tools, toolStatus, fileOperations };
  }

  private buildStepNamedInvocations(step: StepBucket): {
    skillInvocations: Record<string, number>;
    agentInvocations: Record<string, number>;
  } {
    const skillInvocations: Record<string, number> = {};
    const agentInvocations: Record<string, number> = {};

    for (const toolCall of step.toolCalls) {
      const args = toolCall.event.args;
      if (!args || typeof args !== 'object') {
        continue;
      }

      const toolName = toolCall.event.name;
      if (toolName === 'Skill' && typeof args.skill === 'string') {
        skillInvocations[args.skill] = (skillInvocations[args.skill] || 0) + 1;
      } else if ((toolName === 'Agent' || toolName === 'AgentSwarm') && typeof args.subagent_type === 'string') {
        agentInvocations[args.subagent_type] = (agentInvocations[args.subagent_type] || 0) + 1;
      } else if (toolName === 'Agent' && typeof args.description === 'string') {
        const agentType = this.inferAgentType(args.description);
        if (agentType) {
          agentInvocations[agentType] = (agentInvocations[agentType] || 0) + 1;
        }
      }
    }

    return { skillInvocations, agentInvocations };
  }

  private buildStepCommandInvocations(step: StepBucket, turnPrompt?: string): Record<string, number> {
    const commandInvocations: Record<string, number> = {};

    if (turnPrompt) {
      const command = this.extractSlashCommand(turnPrompt);
      if (command) {
        commandInvocations[command] = (commandInvocations[command] || 0) + 1;
      }
    }

    return commandInvocations;
  }

  private inferAgentType(description: string): string | undefined {
    const lower = description.toLowerCase();
    if (lower.includes('explore')) return 'explore';
    if (lower.includes('plan')) return 'plan';
    if (lower.includes('coder')) return 'coder';
    if (lower.includes('review')) return 'review';
    return undefined;
  }

  private extractTextContent(event: KimiWireEvent): string | undefined {
    const input = event.input;
    if (Array.isArray(input)) {
      for (const part of input) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
      }
    }
    return undefined;
  }

  private extractTextContentFromMessage(message: { content?: Array<{ type?: string; text?: string }> | string }): string | undefined {
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
      }
    }
    if (typeof content === 'string') {
      return content;
    }
    return undefined;
  }

  private extractSlashCommand(text: string): string | undefined {
    const match = text.trim().match(/^\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : undefined;
  }

  private resolveDisplay(event: KimiWireEvent): KimiWireEventDisplay | undefined {
    return event.event?.display ?? event.display;
  }

  private deriveLanguage(path: string): string | undefined {
    const ext = path.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts': return 'typescript';
      case 'tsx': return 'typescript';
      case 'js': return 'javascript';
      case 'jsx': return 'javascript';
      case 'py': return 'python';
      case 'go': return 'go';
      case 'rs': return 'rust';
      case 'java': return 'java';
      case 'kt': return 'kotlin';
      case 'rb': return 'ruby';
      case 'php': return 'php';
      case 'c': return 'c';
      case 'cpp': case 'cc': case 'cxx': return 'cpp';
      case 'h': case 'hpp': return 'cpp';
      case 'cs': return 'csharp';
      case 'swift': return 'swift';
      case 'md': return 'markdown';
      case 'json': return 'json';
      case 'yaml': case 'yml': return 'yaml';
      case 'toml': return 'toml';
      case 'sh': return 'shell';
      default: return undefined;
    }
  }

  private deriveFormat(path: string): string | undefined {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext || undefined;
  }

  private computeLineChanges(before: string, after: string): { linesAdded: number; linesRemoved: number; linesModified: number } {
    const beforeLines = this.splitLines(before);
    const afterLines = this.splitLines(after);
    const maxLen = Math.max(beforeLines.length, afterLines.length);
    let linesAdded = 0;
    let linesRemoved = 0;
    let linesModified = 0;

    for (let i = 0; i < maxLen; i++) {
      const b = beforeLines[i];
      const a = afterLines[i];
      if (b === undefined && a !== undefined) {
        linesAdded++;
      } else if (b !== undefined && a === undefined) {
        linesRemoved++;
      } else if (b !== a) {
        linesModified++;
      }
    }

    return { linesAdded, linesRemoved, linesModified };
  }

  private splitLines(text: string): string[] {
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }
}
