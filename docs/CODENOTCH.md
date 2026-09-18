# Codenotch integration

[Codenotch](https://github.com/vinzdg/codenotch) is a macOS notch app that
shows AI provider usage as rings on the screen edge. The CodeMie CLI installs
it and — with one flag — adds CodeMie budget and Claude session spending to it,
fed by your existing CodeMie profile. No separate sign-in, no separate binary.

## Install

```bash
codemie install codenotch                    # the app itself, from the latest release
codemie install codenotch --budget-plugin    # the app + the CodeMie usage provider
codemie uninstall codenotch                  # removes the app and the provider
```

`--budget-plugin` registers a single provider with Codenotch, which picks it
up live (no app restart):

- **CodeMie Usage** — every budget bucket on your account (CLI / platform /
  premium) shaped like Codenotch's usual Claude provider, led by the CLI
  bucket, plus live session activity on the ring.

It appears in Codenotch settings connected by default and can be toggled,
reordered, or removed like any built-in provider. Budget data comes from the
authenticated CodeMie profile (`codemie setup` / `codemie profile login`) —
the same `GET {baseUrl}/v1/analytics/budget_usage` endpoint the statusline
uses, with a 60-second cache so Codenotch's polling never hammers the backend.

## How it works

Codenotch's provider plugin protocol
([`docs/design/plugin-protocol.md`](https://github.com/vinzdg/codenotch/blob/main/docs/design/plugin-protocol.md))
is a manifest plus an executable it can poll. Registration writes a manifest
into `~/Library/Application Support/Codenotch/Plugins/` whose executable is
the CodeMie CLI itself:

```
codemie codenotch snapshot --provider codemie-claude
```

The `codenotch` bridge command is internal (hidden from `--help`) and is the
only moving part: it reads `~/.codemie` config and the CLI's own SSO
credential store, fetches the budget rows, and prints the protocol JSON on
stdout. Nothing else crosses the process boundary — Codenotch never sees your
credentials, only numbers.

Because the bridge ships inside the regular `@codemieai/code` npm package,
every release of the CLI carries it — no repository clone and no Swift
toolchain needed anywhere.

## Layout

- `src/cli/commands/codenotch/index.ts` — the hidden bridge command
- `src/cli/commands/codenotch/budget.ts` — profile, credentials, budget fetch, cache
- `src/cli/commands/codenotch/snapshot.ts` — protocol payload builder
- `src/cli/commands/codenotch/installer.ts` — app install, plugin registration
- `src/cli/commands/codenotch/assets/` — the provider glyph
