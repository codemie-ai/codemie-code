/**
 * Simple Streaming Test
 * 
 * Tests basic streaming functionality with async iterators
 */

import { describe, it, expect } from 'vitest';

describe('Simple Streaming Test', () => {
  it('should stream simple string values', async () => {
    // Create a simple async generator that streams values
    async function* simpleStream() {
      yield 'Hello';
      yield ' ';
      yield 'World';
      yield '!';
    }

    // Collect streamed values
    const values: string[] = [];
    for await (const chunk of simpleStream()) {
      values.push(chunk);
    }

    // Verify all values were streamed
    expect(values).toEqual(['Hello', ' ', 'World', '!']);
    expect(values.join('')).toBe('Hello World!');
  });

  it('should stream numbers with delay', async () => {
    // Create an async generator that streams numbers with a small delay
    async function* numberStream() {
      for (let i = 1; i <= 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        yield i;
      }
    }

    // Collect streamed numbers
    const numbers: number[] = [];
    for await (const num of numberStream()) {
      numbers.push(num);
    }

    // Verify all numbers were streamed in order
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    expect(numbers.length).toBe(5);
  });

  it('should stream objects with properties', async () => {
    interface StreamEvent {
      type: string;
      data: string;
    }

    // Create an async generator that streams event objects
    async function* eventStream(): AsyncGenerator<StreamEvent> {
      yield { type: 'start', data: 'Starting...' };
      yield { type: 'processing', data: 'Processing...' };
      yield { type: 'complete', data: 'Done!' };
    }

    // Collect streamed events
    const events: StreamEvent[] = [];
    for await (const event of eventStream()) {
      events.push(event);
    }

    // Verify event stream
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('start');
    expect(events[1].type).toBe('processing');
    expect(events[2].type).toBe('complete');
  });

  it('should handle stream with callback pattern', async () => {
    type EventCallback = (event: { type: string; content?: string }) => void;

    // Simulate an agent-like streaming function
    async function streamWithCallback(onEvent: EventCallback): Promise<void> {
      onEvent({ type: 'thinking_start' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      onEvent({ type: 'content_chunk', content: 'Hello' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      onEvent({ type: 'content_chunk', content: ' Stream' });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      onEvent({ type: 'thinking_end' });
      
      onEvent({ type: 'complete' });
    }

    // Collect events via callback
    const events: Array<{ type: string; content?: string }> = [];
    await streamWithCallback((event) => {
      events.push(event);
    });

    // Verify callback-based streaming
    expect(events).toHaveLength(5);
    expect(events[0].type).toBe('thinking_start');
    expect(events[1].content).toBe('Hello');
    expect(events[2].content).toBe(' Stream');
    expect(events[3].type).toBe('thinking_end');
    expect(events[4].type).toBe('complete');
  });

  it('should handle stream cancellation', async () => {
    // Create a long-running stream
    async function* longStream() {
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        yield i;
      }
    }

    // Cancel after collecting a few values
    const values: number[] = [];
    const maxValues = 5;
    
    for await (const value of longStream()) {
      values.push(value);
      if (values.length >= maxValues) {
        break; // Cancel the stream
      }
    }

    // Verify stream was cancelled early
    expect(values).toHaveLength(maxValues);
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });

  it('should handle stream errors gracefully', async () => {
    // Create a stream that throws an error
    async function* errorStream() {
      yield 'value1';
      yield 'value2';
      throw new Error('Stream error!');
    }

    // Try to consume the stream
    const values: string[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const value of errorStream()) {
        values.push(value);
      }
    } catch (error) {
      caughtError = error as Error;
    }

    // Verify error was caught and partial values were collected
    expect(values).toEqual(['value1', 'value2']);
    expect(caughtError).toBeTruthy();
    expect(caughtError?.message).toBe('Stream error!');
  });

  it('should support backpressure with buffering', async () => {
    // Create a stream with buffered values
    async function* bufferedStream() {
      const buffer = ['chunk1', 'chunk2', 'chunk3', 'chunk4', 'chunk5'];
      
      for (const chunk of buffer) {
        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, 5));
        yield chunk;
      }
    }

    // Consume with slow processing
    const processed: string[] = [];
    const startTime = Date.now();
    
    for await (const chunk of bufferedStream()) {
      // Simulate slow consumer
      await new Promise(resolve => setTimeout(resolve, 10));
      processed.push(chunk.toUpperCase());
    }
    
    const duration = Date.now() - startTime;

    // Verify all chunks were processed despite slow consumption
    expect(processed).toEqual(['CHUNK1', 'CHUNK2', 'CHUNK3', 'CHUNK4', 'CHUNK5']);
    expect(duration).toBeGreaterThan(50); // Should take at least 50ms with delays
  });
});
