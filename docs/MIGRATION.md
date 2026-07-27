# Migration Guide

## Removing the `code` CLI alias (v0.10.x → next)

### What changed

The `code` npm bin alias has been removed from `@codemieai/code`. Running `code` after upgrading will no longer invoke the CodeMie CLI.

**Why:** The `code` alias collides with the VS Code CLI (`code`) that is widely installed on developer machines. This collision caused confusing behaviour and is a potential security footgun.

### Who is affected

Users who invoked CodeMie via the `code` command instead of `codemie`.

### What to do

**Option 1 (recommended): Use `codemie` instead.**

```sh
# Before
code chat

# After
codemie chat
```

All CodeMie commands are available under `codemie` and `codemie-code`.

**Option 2: Add your own shell alias.**

> **Warning:** `alias code=codemie` will shadow the VS Code `code` command. If you use VS Code's CLI (`code .`, `code myfile.ts`), this alias will break it. Only do this if you do not rely on VS Code's `code` CLI, or use a different shorthand (e.g. `alias cm=codemie`).

If you prefer the shorter name and do not use VS Code's `code` CLI, add this to your `~/.zshrc` or `~/.bashrc`:

```sh
alias code=codemie
# Or use a shorthand that doesn't conflict:
# alias cm=codemie
```

Then reload your shell:

```sh
source ~/.zshrc   # or ~/.bashrc
```

### Stale symlink note

If you installed `@codemieai/code` globally **before this release**, npm may have already created a `code` symlink in your global bin directory. Running `npm update -g @codemieai/code` alone does **not** remove the stale symlink — npm does not unlink bin entries that are removed from `package.json` during an update. A full uninstall and reinstall is required.

To verify and clean up:

```sh
# Check if the stale symlink exists
which code   # macOS/Linux; on Windows use: where code

# To remove it, uninstall and reinstall the package
npm uninstall -g @codemieai/code && npm install -g @codemieai/code
```
