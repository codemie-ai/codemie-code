DONE

## Commit
`1fe7aa8262` — feat(cli): add pure identifier resolution for assistants/skills registration

## Changed files
- `src/cli/commands/shared/identifier-resolution.ts` (new)
- `src/cli/commands/shared/__tests__/identifier-resolution.test.ts` (new)

## Test command
```
npx vitest run --project unit src/cli/commands/shared/__tests__/identifier-resolution.test.ts > /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/test.local.log 2>&1; echo "EXIT=$?"; tail -25 /Users/Nikita_Levyankov/repos/codemie-ai/codemie-code/docs/superpowers/tasks/2026-09-18-codemie-assistant-skill-registration/test.local.log
```

- RED run (before implementation): `EXIT=1`, failure was `Error: Cannot find module '../identifier-resolution.js'` — expected reason (module not found).
- GREEN run (after implementation): `EXIT=0`, 8/8 tests passed.
- `npx tsc --noEmit`: clean (exit 0).

## Signatures exported (`src/cli/commands/shared/identifier-resolution.ts`)
```ts
export interface ResolvableItem {
  id: string;
  name: string;
  slug?: string;
}

export function resolveIdentifiers<T extends ResolvableItem>(
  kind: 'assistant' | 'skill',
  identifiers: string[],
  catalog: T[]
): T[];
```

Implementation is a single pass building `id`/`slug`/`name`-bucket maps (all keys lower-cased), then maps `identifiers` in order: id match wins, then slug, then exact name (only if unambiguous — multiple name matches throw `AmbiguousIdentifierError` with every candidate, never picking one). No match (including an empty-string identifier, which never matches even items with no `slug`) throws `RegistrationItemNotFoundError`. Pure function — no I/O, no logger, no API client. Imports `RegistrationItemNotFoundError`/`AmbiguousIdentifierError` from `@/utils/errors.js` (Task 1's classes, unmodified).

## Concerns
- None. `git show --stat HEAD` lists exactly the two files the brief declared.
- Note: the first commit attempt omitted the required "Generated with AI / Co-Authored-By" trailer; caught immediately and fixed with `git commit --amend` before any push or further work (nothing else was staged/lost — pre-commit hooks re-ran cleanly on the amend).
