import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface FocusNode {
  tagName: string;
  offsetParent: object;
  focus(): void;
}

function focusHarness() {
  const document: { activeElement?: FocusNode } = {};
  const nodes: FocusNode[] = ['button', 'button', 'summary'].map((tagName) => ({
    tagName, offsetParent: {}, focus() { document.activeElement = this; },
  }));
  // The selector boundary models native focusable controls; execute the actual modal handler.
  const modal = {
    querySelectorAll(selector: string): FocusNode[] {
      const tags = selector.split(',').map((part) => part.trim().match(/^[a-z]+/)?.[0]);
      return nodes.filter((node) => tags.includes(node.tagName));
    },
    contains(node: FocusNode): boolean { return nodes.includes(node); },
  };
  const source = readFileSync(new URL('../client/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('modalEsc = function (ev) {');
  const end = source.indexOf("document.addEventListener('keydown', modalEsc)", start);
  const handler = runInNewContext(`${source.slice(start, end)} modalEsc`, { document, modal, closeSessionModal() {} }) as (event: unknown) => void;
  function tab(node: FocusNode, shiftKey = false): boolean {
    document.activeElement = node;
    let prevented = false;
    handler({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { nodes, document, tab };
}

describe('session modal keyboard traversal', () => {
  it('CR-015 allows forward traversal from header controls to the unlinked disclosure', () => {
    const { nodes, tab } = focusHarness();
    expect(tab(nodes[1])).toBe(false);
  });

  it('CR-015 wraps backwards to the disclosure and forwards from it', () => {
    const { nodes, document, tab } = focusHarness();
    expect(tab(nodes[0], true)).toBe(true);
    expect(document.activeElement).toBe(nodes[2]);
    expect(tab(nodes[2])).toBe(true);
    expect(document.activeElement).toBe(nodes[0]);
  });
});
