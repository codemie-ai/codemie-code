# codemie-codenotch — CodeMie providers for Codenotch

A standalone [Codenotch](https://github.com/vinzdg/codenotch) plugin that puts
CodeMie budget and session spending in the Mac notch, fed by your existing
CodeMie CLI setup — no separate sign-in.

Two providers are registered:

- **CodeMie Budget** — every budget bucket on the account (CLI / platform /
  premium), led by a **Total budget** headline with spent, remaining and the
  reset date.
- **CodeMie Claude** — per-bucket spending shaped like Codenotch's usual
  Claude provider, plus live session activity on the same ring
  (`codemie-claude` execs the real Claude Code, which files sessions in
  `~/.claude`).

Data comes from the same place as the CodeMie statusline:
`GET {baseUrl}/v1/analytics/budget_usage`, authenticated with CodeMie's own
SSO credential store (`~/.codemie/credentials/*.enc`, AES-256-GCM with the
legacy CBC fallback). A 60-second on-disk cache spares the backend.

## Build

```sh
swift build -c release          # in this directory
swift test                      # 49 tests
```

The package is deliberately independent of the npm build: a native macOS CLI
has no business in the TypeScript toolchain, and keeping it standalone lets it
be distributed later by any channel (npm wrapper, brew, direct download)
without touching either.

## Install

Registration is a single command; Codenotch picks the providers up while it
runs (no app restart):

```sh
# put the binary somewhere stable first — the manifest records its path
cp .build/release/codemie-codenotch ~/.local/bin/
cp -R .build/release/codemie-codenotch_codemie-codenotch.bundle ~/.local/bin/
~/.local/bin/codemie-codenotch register
```

`register` writes two plugin directories under
`~/Library/Application Support/Codenotch/Plugins/`. `unregister` removes them.
Both providers appear in Codenotch settings connected by default and can be
toggled, reordered and deleted like any built-in provider.

The plugin protocol (manifest schema, wire JSON, exit codes) is specified in
[`docs/design/plugin-protocol.md`](https://github.com/vinzdg/codenotch/blob/main/docs/design/plugin-protocol.md)
in the Codenotch repo.

## Layout

- `Sources/CodemieCodenotchCore/` — config parsing, SSO credential decryption,
  budget API client + cache, snapshot builders, registrar
- `Sources/codemie-codenotch/` — the executable (`register` / `unregister` /
  `snapshot`) and the bundled glyph assets
- `Scripts/render-glyphs.swift` — regenerates the two glyph PNGs
- `Tests/codemie-codenotchTests/` — 49 swift-testing tests
