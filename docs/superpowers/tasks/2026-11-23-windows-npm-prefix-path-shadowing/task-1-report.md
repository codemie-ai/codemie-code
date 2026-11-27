DONE
commit: 90a9a0cf
files: src/utils/processes.ts, src/utils/__tests__/processes.test.ts
test_command: npx vitest run src/utils/__tests__/processes.test.ts
notes: New export `getCommandMatches(command, timeoutMs?)` returning `{status:'answered', matches: string[]} | {status:'unanswered'}`. Non-zero exit gives answered with []; throw/timeout gives unanswered. commandExists/getCommandPath untouched. RED seen (3 failing), then GREEN 65/65; typecheck and eslint clean.
