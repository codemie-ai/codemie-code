# OpenCode and Pi effort-level fix

## Findings

- The CodeMie CLI already defines the canonical levels as `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `codemie-opencode` already forwards its selected level as `--variant <level>`.
- The built-in `codemie-code` wrapper uses the same OpenCode binary but does not currently declare the reasoning-effort forwarding block.
- OpenCode selects a named model variant. Passing `--variant max` is not enough unless the injected model definition contains a `max` variant with the correct request options.
- The current OpenCode provider defaults expose only part of the desired palette. The CodeMie model catalogue should explicitly provide the extended variants for GPT-5.6 and GPT-6-family Responses API models.
- Pi's generated `models.json` currently maps both `xhigh` and `max` to `high` in `src/agents/plugins/pi/pi.models.ts`. The generated `.pi/codemie/agent/models.json` is not the source of truth.
- GPT-6 routing/classification is intentionally out of scope here because it is already addressed by a separate PR.
- The current Pi package configured by CodeMie is `@earendil-works/pi-coding-agent`; no Pi fork change is needed for this mapping fix.

## Minimal implementation

1. Add the OpenCode reasoning-effort declaration to the built-in `codemie-code` metadata so the CLI forwards all six canonical levels as `--variant`.
2. Add an explicit OpenCode variant map for GPT-5.6 and GPT-6-family model IDs. Each level will send the corresponding `reasoningEffort` value, together with the existing OpenAI reasoning metadata.
3. Include the same variant map in static GPT-5.6 fallback configurations and dynamic model configurations.
4. Change Pi's generated `thinkingLevelMap` so `xhigh` remains `xhigh` and `max` remains `max`.
5. Add focused regression tests for dynamic/static OpenCode variants, built-in CLI forwarding, and Pi's generated map.

## Non-goals

- Do not modify GPT-6 Responses API detection, context limits, or family classification.
- Do not modify the `@codemieai/codemie-opencode` binary fork or publish a new binary.
- Do not edit generated `.pi` files manually.

## Verification

- Run the focused OpenCode, Pi, and effort-injection unit tests.
- Run TypeScript type-checking and linting for changed files.
- Review the final diff, commit the plan and implementation, and push the existing fork branch.

## Expected scope

Approximately 7 source/test files plus this plan, with a small implementation change. The existing unrelated `.codemie/codemie-cli.config.json` worktree change must remain untouched.
