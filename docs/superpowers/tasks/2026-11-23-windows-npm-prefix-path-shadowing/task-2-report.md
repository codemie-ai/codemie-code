DONE
commit: 228a240d
files: src/utils/path-shadow.ts, src/utils/paths.ts, src/utils/__tests__/path-shadow.test.ts, src/utils/__tests__/paths.test.ts
test_command: npx vitest run src/utils/__tests__/path-shadow.test.ts src/utils/__tests__/paths.test.ts
notes:
- Exports: classifyShadow(input), ShadowVerdict, ShadowInput from @/utils/path-shadow.js; isSamePathResolved(a,b): Promise<boolean> from @/utils/paths.js (realpath.native, raw fallback).
- classifyShadow takes sync samePath; takes dirname of each match itself (handles / and \ separators). Callers pre-resolve if needed.
- Tests: 69 passed; tsc and eslint clean. Symlink test uses a junction and returns early if not permitted.
