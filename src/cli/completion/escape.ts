/**
 * Escaping helpers for static completion scripts.
 *
 * Every function collapses line breaks to a single space and returns the
 * text meant to be placed INSIDE a single-quoted string of the target shell.
 * The caller supplies the surrounding quotes.
 */

function collapseNewlines(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Content for a single-quoted bash string: `'${escapeBash(s)}'`.
 * Only `'` is special inside single quotes; it becomes `'\''`.
 */
export function escapeBash(s: string): string {
  return collapseNewlines(s).replace(/'/g, `'\\''`);
}

/**
 * Description part of a zsh `_describe` element embedded in single quotes:
 * `'name:${escapeZshDescribe(desc)}'`. Everything after the first colon is
 * the description, so `:`, `\`, `%`, `[`, `]` are kept as-is; only `'` is
 * escaped (`'\''`). The name part (where `:` must be written `\:`) is NOT
 * handled here.
 */
export function escapeZshDescribe(s: string): string {
  return collapseNewlines(s).replace(/'/g, `'\\''`);
}

/**
 * Content for a single-quoted fish string: `'${escapeFish(s)}'`.
 * Inside fish single quotes only `\\` and `\'` are escapes.
 */
export function escapeFish(s: string): string {
  return collapseNewlines(s).replace(/\\/g, '\\\\').replace(/'/g, `\\'`);
}
