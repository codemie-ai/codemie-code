/**
 * Active time of a Codex session: the sum of its turns, from the parent rollout's
 * `task_started` / `task_complete` events. Idle gaps between turns are not counted.
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

interface Turn {
  start: number;
  end?: number;
}

interface TurnEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    turn_id?: string;
    turn_attribution?: { turn_id?: string };
  };
}

/**
 * Active milliseconds of the turns of one rollout inside [runStart, sessionEnd].
 *
 * A turn without `task_complete` ends at the last record before the next `task_started`, or at
 * the end of the file. Unparsable lines are skipped. 0 means there is nothing to write.
 */
export async function computeActiveDuration(
  parentRolloutPath: string,
  runStart: number,
  sessionEnd: number
): Promise<number> {
  const turns: Turn[] = [];
  const open = new Map<string, Turn>();
  let lastTs: number | undefined;

  const closeOpen = (): void => {
    for (const turn of open.values()) {
      turn.end = lastTs ?? turn.start;
    }
    open.clear();
  };

  const stream = createReadStream(parentRolloutPath, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!raw) continue;
      let record: TurnEvent;
      try {
        record = JSON.parse(raw) as TurnEvent;
      } catch {
        continue;
      }
      const ts = record.timestamp ? Date.parse(record.timestamp) : NaN;
      const payload = record.payload;
      if (record.type === 'event_msg' && !isNaN(ts)) {
        if (payload?.type === 'task_started') {
          // A turn still open here never completed: it ended at the last record before this one
          closeOpen();
          const id = payload.turn_attribution?.turn_id ?? payload.turn_id ?? `turn-${turns.length}`;
          const turn: Turn = { start: ts };
          turns.push(turn);
          open.set(id, turn);
        } else if (payload?.type === 'task_complete' && payload.turn_id) {
          const turn = open.get(payload.turn_id);
          if (turn) {
            turn.end = ts;
            open.delete(payload.turn_id);
          }
        }
      }
      if (!isNaN(ts)) lastTs = ts;
    }
  } catch {
    return 0;
  } finally {
    lines.close();
    stream.destroy();
  }
  closeOpen();

  let total = 0;
  for (const turn of turns) {
    const end = Math.min(turn.end ?? turn.start, sessionEnd);
    total += Math.max(0, end - Math.max(turn.start, runStart));
  }
  return Math.max(0, Math.min(total, sessionEnd - runStart));
}
