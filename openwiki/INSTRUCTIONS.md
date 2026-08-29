# OpenWiki Brief — CodeMie Code (`@codemieai/code`)

This wiki serves AI coding agents working in this repository. Prioritize the
context an agent needs to make correct, convention-compliant changes.

## Scope and priorities

1. **Architecture first** — the plugin-based 5-layer architecture, layer
   responsibilities, and dependency flow (`CLI -> Registry -> Plugin`).
   Key sources: `src/cli/`, `src/agents/registry.ts`, `src/agents/plugins/`,
   `src/providers/plugins/`.
2. **Agent plugin system** — how plugins under `src/agents/plugins/` are
   structured, registered, installed (`codemie install <agent>`), and launched;
   the `bin/codemie-<agent>.js` wrapper pattern; the difference between agent
   plugins and injected runtime plugins (`codemie-code-hooks/`,
   `reasoning-sanitizer/`).
3. **Provider plugin system** — SSO (default, owns the local proxy), jwt,
   litellm, bedrock, ollama, subscription providers; the proxy plugin chain
   under `src/providers/plugins/sso/proxy/plugins/`.
4. **CLI surface** — commander command factories in `src/cli/commands/`
   registered in `src/cli/index.ts`; entry points in `bin/` declared in
   `package.json:bin`.
5. **Configuration** — profiles, ConfigLoader, env vars, `~/.codemie` paths
   (`getCodemiePath()`).

## Conventions the wiki must capture

- ES modules: always `.js` extensions on imports, no `require()`/`__dirname`,
  use `@/` alias instead of deep relative imports.
- Project error classes, `logger.debug()` (never raw `console.log`),
  `sanitizeLogArgs()` for anything credential-adjacent.
- Conventional Commits enforced by commitlint; Vitest for tests.

## Do NOT document

- Anything matched by `.openwikiignore` (build output, `.ai-run/` agent
  artifacts, `docs/superpowers/` working files).
- Workflow and policy owned by `.ai-run/guides/` — git workflow, quality
  gates, testing rules, security policies, coding standards. Those guides are
  hand-curated and authoritative for process; never restate or paraphrase
  them in wiki pages. If a page needs that context, link the guide path.
- Hand-written user docs under `docs/` as primary evidence — summarize and
  link to them instead of duplicating their content.
