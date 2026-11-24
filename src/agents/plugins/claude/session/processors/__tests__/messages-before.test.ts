/**
 * takeMessagesBefore: a message.id group follows its first line; a line without a timestamp
 * follows the previous stamped line.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { takeMessagesBefore } from '../messages-before.js';

const CUTOFF = Date.parse('2026-10-31T12:00:00Z');
const BEFORE = '2026-10-31T11:59:00Z';
const AFTER = '2026-10-31T12:01:00Z';

const line = (uuid: string, timestamp?: string, groupId?: string) => ({
  uuid,
  ...(timestamp && { timestamp }),
  ...(groupId && { message: { id: groupId } })
});
const uuidsBefore = (messages: ReturnType<typeof line>[]) =>
  takeMessagesBefore(messages, CUTOFF).map(m => m.uuid);

describe('takeMessagesBefore', () => {
  it('a group whose first chunk is before the cutoff is before, its later chunk included', () => {
    expect(uuidsBefore([line('c1', BEFORE, 'msg-1'), line('c2', AFTER, 'msg-1')])).toEqual(['c1', 'c2']);
  });

  it('a group whose first chunk is after the cutoff is after, its earlier-stamped chunk included', () => {
    expect(uuidsBefore([line('c1', AFTER, 'msg-1'), line('c2', BEFORE, 'msg-1')])).toEqual([]);
  });

  it('a line without a timestamp after a pre-cutoff line is before', () => {
    expect(uuidsBefore([line('s', BEFORE), line('n')])).toEqual(['s', 'n']);
  });

  it('a line without a timestamp after a post-cutoff line is after', () => {
    expect(uuidsBefore([line('s', BEFORE), line('t', AFTER), line('n')])).toEqual(['s']);
  });
});
