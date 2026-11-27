DONE

Commit: f5888f34
Changed paths:
- src/cli/completion/zsh.ts
- src/cli/completion/__tests__/zsh.test.ts (+ __snapshots__/zsh.test.ts.snap)
- tests/helpers/zsh-pty.ts
- tests/integration/completion/zsh.test.ts

Test command: npx vitest run src/cli/completion tests/integration/completion  (EXIT=0, 113 passed)

Notes:
- RED seen first (module missing), then GREEN. Lint and tsc clean.
- Script: #compdef <name>, header line 2; guard works for autoload (funcstack) and source (compdef).
- zsh-pty helper runs the REAL completion system (_main_complete -> _complete -> compdef-registered fn); compadd wrapped with -O for capture, sentinel with random token, 15s timeout, no fixed sleeps. Calling the function outside _main_complete does not work (_describe misbehaves), hence the real-dispatch design. Captured candidates are de-duplicated because _describe calls compadd twice per item.
- Do not use _describe -t <tag> without _tags: options silently vanish. Emitter uses plain _describe (offers commands and options at every position, same as bash).
- Accidental full-suite run changed file modes of 3 bin/*-acp.js; restored to 644.
