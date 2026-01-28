/**
 * Terminal Control Codes and Escape Sequences
 */

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const KEYS = {
  ESCAPE: ESC,
  ARROW_UP: `${CSI}A`,
  ARROW_DOWN: `${CSI}B`,
} as const;

export const CURSOR = {
  up: (n: number): string => `${CSI}${n}A`,
  toLineStart: '\r',
} as const;

export const CLEAR = {
  toEndOfLine: `${CSI}K`,
  entireLine: `${CSI}2K`,
} as const;

export const CONTROL = {
  BACKSPACE: '\b',
  DELETE: '\u007F',
  CTRL_C: '\u0003',
  CTRL_P: '\u0010',
  CTRL_H: '\u0008',
  CTRL_T: '\u0014',
  CTRL_S: '\u0013',
  CTRL_I: '\u0009',
  TAB: '\t',
} as const;

export const NEWLINE = {
  CR: '\r',
  LF: '\n',
  CRLF: '\r\n',
  LFCR: '\n\r',
} as const;

export function startsWithEscape(data: string): boolean {
  return data.startsWith(ESC);
}

export function isKey(sequence: string, key: keyof typeof KEYS): boolean {
  return sequence === KEYS[key];
}
