# Testing Patterns

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: Vitest test placement, project selection, CODEMIE_HOME isolation and mocking order; gate commands live in `.ai-run/guides/quality-gates.md`

## Organization and naming

### Rules
- R6. Put a unit test in the `__tests__/` directory beside the source it covers (`.lintstagedrc.mjs` picks pre-commit tests by that adjacency). Evidence: `.lintstagedrc.mjs::adjacentTests`

## Running tests

### Rules
- R2. Run `npm run build` before the `cli` project (its tests spawn `bin/codemie.js`, which imports `../dist/`; CI downloads the build artifact instead). Evidence: `tests/helpers/isolated-cli.ts::runIsolatedCli`
- R3. Run `npx vitest run --project unit --project cli` unless agent tests are requested (`npm test`'s agent stage runs `npm run build`, `npm link`, installs the supported `claude` CLI into `~/.local/bin`, installs the Claude plugin into the real `~/.codemie/claude-plugin`, and may launch an SSO login). Evidence: `tests/setup/agent-build-setup.ts::setup`

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| writing an integration test that runs the real CLI | `tests/helpers/isolated-cli.ts::runIsolatedCli` | private CODEMIE_HOME and HOME, reports signal and spawn errors | exemplar is a test |

## Fixtures and factories

### Rules
- R1. Read and write CodeMie state in tests through `getCodemieHome()`/`getCodemiePath()` (each Vitest project sets `CODEMIE_HOME` to a per-run temp dir; a `homedir()` join escapes it). Evidence: `vitest.config.ts::testCodemieHome`

## Mocking

### Rules
- R4. Declare `vi.mock()` factories before the module under test loads and import it with `await import()` inside the test (module-level imports resolve before mocks apply). Evidence: `src/utils/__tests__/processes.test.ts::installGlobal`
- R5. Resolve a path from a path utility through a lazy static getter, not a static field initialiser (a field computed at class load ignores a later `CODEMIE_HOME` change or a `vi.spyOn` in `beforeEach`). Evidence: `src/utils/config.ts::ConfigLoader.GLOBAL_CONFIG`
