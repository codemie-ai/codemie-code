/**
 * OpenCode v2 keeps a whole message in one `session_message` row. These tests pin how such a
 * row becomes the v1 message and parts the session processors consume.
 */
import { describe, it, expect } from 'vitest';
import { messageFromV2Row, partsFromV2Row, type V2MessageRow } from '../opencode.storage-v2.js';
import type { OpenCodeToolPart } from '../opencode-message-types.js';

const ROW_ID = 'msg_1';
const SESSION_ID = 'ses_1';
/** A blob OpenCode had not finished writing. */
const MALFORMED_DATA = '{"time":';
/** Result content that is not `text`, though it carries a text of its own. */
const FILE_CONTENT = { type: 'file', uri: 'file:///work/project/a.png', text: 'a.png' };

type RowData = Record<string, unknown>;

function row(type: 'user' | 'assistant', data: RowData): V2MessageRow {
  return { id: ROW_ID, session_id: SESSION_ID, type, data: JSON.stringify(data) };
}

const userRow = (data: RowData = {}): V2MessageRow => row('user', data);
const assistantRow = (data: RowData = {}): V2MessageRow => row('assistant', data);

/** The ids of the part made from the content item at `index`. */
const partIds = (index: number) => ({ id: `${ROW_ID}:${index}`, messageID: ROW_ID, sessionID: SESSION_ID });

function toolContent(state: RowData, time?: Record<string, number>): RowData {
  return { type: 'tool', id: 'call_1', name: 'shell', state, ...(time && { time }) };
}

/** The part of an assistant row whose only content is one tool call. */
function toolPartOf(state: RowData, time?: Record<string, number>): OpenCodeToolPart {
  const [part] = partsFromV2Row(assistantRow({ content: [toolContent(state, time)] }));
  return part as OpenCodeToolPart;
}

describe('messageFromV2Row', () => {
  describe('user row', () => {
    it('should map the row to a user message with its ids and creation time', () => {
      const message = messageFromV2Row(userRow({ time: { created: 100 }, text: 'hello', files: [] }));

      expect(message).toEqual({ id: ROW_ID, sessionID: SESSION_ID, role: 'user', time: { created: 100 } });
    });

    it('should default the creation time to 0 when the row has no time', () => {
      const message = messageFromV2Row(userRow({ text: 'hello' }));

      expect(message.time).toEqual({ created: 0 });
    });
  });

  describe('assistant row', () => {
    it('should carry the provider, model and agent of the turn', () => {
      const message = messageFromV2Row(
        assistantRow({
          time: { created: 100 },
          agent: 'build',
          model: { id: 'gpt-6.1-sol', providerID: 'codemie-openai' },
        })
      );

      expect(message).toEqual({
        id: ROW_ID,
        sessionID: SESSION_ID,
        role: 'assistant',
        time: { created: 100 },
        providerID: 'codemie-openai',
        modelID: 'gpt-6.1-sol',
        agent: 'build',
      });
    });

    it('should include the completion time of a finished turn', () => {
      const message = messageFromV2Row(assistantRow({ time: { created: 100, streamed: 150, completed: 200 } }));

      expect(message.time).toEqual({ created: 100, completed: 200 });
    });

    it.each([
      { label: 'absent', time: { created: 100 } },
      { label: 'not a number', time: { created: 100, completed: null } },
    ])('should omit the completion time when it is $label', ({ time }) => {
      const message = messageFromV2Row(assistantRow({ time }));

      expect(message.time).toStrictEqual({ created: 100 });
    });

    it('should map a failed turn to the v1 error name and message', () => {
      const message = messageFromV2Row(
        assistantRow({ error: { type: 'provider.invalid-request', message: 'Invalid model name', status: 400 } })
      );

      expect(message).toHaveProperty('error', {
        name: 'provider.invalid-request',
        data: { message: 'Invalid model name' },
      });
    });

    it("should name the error 'error' when the failure has no type", () => {
      const message = messageFromV2Row(assistantRow({ error: { message: 'boom' } }));

      expect(message).toHaveProperty('error.name', 'error');
    });

    it('should leave the error unset for a turn that did not fail', () => {
      const message = messageFromV2Row(assistantRow({ time: { created: 100 } }));

      expect(message).not.toHaveProperty('error');
    });
  });

  it('should throw on a malformed JSON blob', () => {
    expect(() => messageFromV2Row({ ...userRow(), data: MALFORMED_DATA })).toThrow(SyntaxError);
  });
});

describe('partsFromV2Row', () => {
  describe('user row', () => {
    it('should turn the prompt into one text part addressed by the row id', () => {
      const parts = partsFromV2Row(userRow({ time: { created: 100 }, text: 'hello', files: [] }));

      expect(parts).toEqual([{ ...partIds(0), type: 'text', text: 'hello' }]);
    });

    it.each([
      { label: 'empty', data: { text: '' } },
      { label: 'absent', data: {} },
    ])('should return no parts when the prompt text is $label', ({ data }) => {
      expect(partsFromV2Row(userRow(data))).toEqual([]);
    });
  });

  describe('assistant row', () => {
    it('should return no parts for a turn without content', () => {
      expect(partsFromV2Row(assistantRow({ time: { created: 100 } }))).toEqual([]);
    });

    it('should map text and reasoning content to parts of the same type', () => {
      const parts = partsFromV2Row(
        assistantRow({
          content: [
            { type: 'reasoning', text: 'Checking the files.' },
            { type: 'text', text: 'Two files.' },
          ],
        })
      );

      expect(parts).toEqual([
        { ...partIds(0), type: 'reasoning', text: 'Checking the files.' },
        { ...partIds(1), type: 'text', text: 'Two files.' },
      ]);
    });

    it('should keep a reasoning item without text as an empty part', () => {
      const parts = partsFromV2Row(assistantRow({ content: [{ type: 'reasoning' }] }));

      expect(parts).toEqual([{ ...partIds(0), type: 'reasoning', text: '' }]);
    });

    it('should keep text and tool content in content order, addressed by position', () => {
      const parts = partsFromV2Row(
        assistantRow({
          content: [
            { type: 'text', text: 'Running it.' },
            toolContent({ status: 'completed' }),
            { type: 'text', text: 'Done.' },
          ],
        })
      );

      expect(parts.map((part) => [part.id, part.type])).toEqual([
        [`${ROW_ID}:0`, 'text'],
        [`${ROW_ID}:1`, 'tool'],
        [`${ROW_ID}:2`, 'text'],
      ]);
    });

    it('should drop content of an unknown type without renumbering the rest', () => {
      const parts = partsFromV2Row(
        assistantRow({
          content: [
            { type: 'text', text: 'Before.' },
            { type: 'snapshot', hash: 'abc' },
            { type: 'text', text: 'After.' },
          ],
        })
      );

      expect(parts.map((part) => part.id)).toEqual([`${ROW_ID}:0`, `${ROW_ID}:2`]);
    });

    describe('tool content', () => {
      it('should map the call to a tool part with its call id, tool name and input', () => {
        const part = toolPartOf({ status: 'completed', input: { command: 'echo hi' } });

        expect(part).toMatchObject({
          ...partIds(0),
          type: 'tool',
          callID: 'call_1',
          tool: 'shell',
          state: { input: { command: 'echo hi' } },
        });
      });

      it.each([
        { v2Status: 'streaming', v1Status: 'pending' },
        { v2Status: 'running', v1Status: 'running' },
        { v2Status: 'completed', v1Status: 'completed' },
        { v2Status: 'error', v1Status: 'error' },
      ])('should map the $v2Status status to $v1Status', ({ v2Status, v1Status }) => {
        expect(toolPartOf({ status: v2Status }).state.status).toBe(v1Status);
      });

      it('should treat a status it does not know as pending', () => {
        expect(toolPartOf({ status: 'a-future-status' }).state.status).toBe('pending');
      });

      it('should join the text of the result into the output, ignoring other content', () => {
        const part = toolPartOf({
          status: 'completed',
          content: [{ type: 'text', text: 'hi\n' }, FILE_CONTENT, { type: 'text', text: 'bye\n' }],
        });

        expect(part.state.output).toBe('hi\nbye\n');
      });

      it('should leave the output unset when the result has no text', () => {
        const part = toolPartOf({ status: 'completed', content: [FILE_CONTENT] });

        expect(part.state).not.toHaveProperty('output');
      });

      it('should take the error message of a failed call', () => {
        const part = toolPartOf({ status: 'error', error: { message: 'command not found' } });

        expect(part.state.error).toBe('command not found');
      });

      it('should carry the metadata of the call', () => {
        const part = toolPartOf({ status: 'completed', metadata: { exit: 0 } });

        expect(part.state.metadata).toEqual({ exit: 0 });
      });

      it.each(['output', 'error', 'metadata'])('should leave %s unset when the call state has none', (key) => {
        expect(toolPartOf({ status: 'completed' }).state).not.toHaveProperty(key);
      });

      it('should time the call from when it ran to when it completed', () => {
        const part = toolPartOf({ status: 'completed' }, { created: 10, ran: 20, completed: 30 });

        expect(part.state.time).toEqual({ start: 20, end: 30 });
      });

      it('should start a call that never ran at its creation time', () => {
        const part = toolPartOf({ status: 'streaming' }, { created: 10 });

        expect(part.state.time?.start).toBe(10);
      });
    });
  });

  it('should throw on a malformed JSON blob', () => {
    expect(() => partsFromV2Row({ ...assistantRow(), data: MALFORMED_DATA })).toThrow(SyntaxError);
  });
});
