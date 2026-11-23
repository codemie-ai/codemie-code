status: DONE

commit: 9e985da6
changed: src/agents/core/ticket-parser.ts, src/agents/core/story-resolver.ts, src/agents/core/__tests__/ticket-parser.test.ts, src/agents/core/__tests__/story-resolver.test.ts
test: npx vitest run src/agents/core/__tests__/ticket-parser.test.ts src/agents/core/__tests__/story-resolver.test.ts (RED 6 failed, GREEN 93 passed); tsc --noEmit and eslint src/agents/core clean (hooks passed)

Interfaces:
- type TicketTracker = 'jira'|'azure-devops'|'github'|'gitlab'; export const TICKET_REF_RE (built from TICKET_RE.source)
- extractTicketMentions options gain tracker?; extractTicketMarker(text, tracker?); parsePromptFields(prompt, tracker?)
- resolveMarkerStory/resolveMentionStory(promptText, tracker?); ResolveStoryInput.tracker?; resolveStoryFor passes it through
Renames: none. Existing callers (repo-fields.ts, claude-code-otlp.plugin.ts) unchanged; they do not pass tracker yet.
Behavior: AB#N upper-cased; org/repo#N and #N keep spelling; bare #N and "story: 42" only for github/gitlab; lookbehind excludes &#123;, #fff, headings. Marker regex extended to AB#/org/repo#/digits.
Concerns: node_modules was absent; ran npm install (no package.json change). Callers must still pass tracker (later task). Bare #123456 (numeric color) is attributed under github/gitlab.
