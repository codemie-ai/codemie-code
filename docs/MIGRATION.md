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

If you prefer the shorter name, add this to your `~/.zshrc` or `~/.bashrc`:

```sh
alias code=codemie
```

Then reload your shell:

```sh
source ~/.zshrc   # or ~/.bashrc
```

### Stale symlink note

If you installed `@codemieai/code` globally **before this release**, npm may have already created a `code` symlink in your global bin directory. Upgrading via `npm update -g @codemieai/code` removes it for a fresh install of the new package, but existing symlinks from older installs may persist.

To verify and clean up:

```sh
# Check if the stale symlink exists
which code

# If it still points to codemie, reinstall to clear it
npm unlink -g @codemieai/code && npm install -g @codemieai/code
```
