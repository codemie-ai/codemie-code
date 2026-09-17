# Technical Research

**Task**: Enable running shared or custom workflows directly from CodeMie CLI (EPMCDME-12353)
**Generated**: 2026-09-08
**Research path**: filesystem

---

## 1. Original Context

Currently, CodeMie CLI does not provide users with the ability to trigger or execute workflows that are shared (public/project) or custom (user-defined) directly from their terminal or shell.

### Requirements:
- A CLI command is available (e.g., `codemie run --workflow <workflow_id>`) for running any workflow the user has access to, including all "shared" or custom workflows.
- Users can execute workflows from terminal or IDE-integrated shells with input/output support.
- CLI command executes the workflow and returns console output or artifacts as supported.
- Command accepts workflow input variables/parameters.
- Feature is documented for both sharing workflows and running them via CLI.
- No regression for existing CLI usage patterns.

### Acceptance Criteria:
- [ ] CLI provides a documented command to run any accessible workflow (shared or custom) by ID or name.
- [ ] CLI command executes the workflow and returns console output or artifacts as supported.
- [ ] Command accepts workflow input variables/parameters.
- [ ] Feature is documented for both sharing workflows and running them via CLI.
- [ ] No regression for existing CLI usage patterns.

---

## 2. Codebase Findings

The CLI architecture has a modular commander-based structure under `src/cli/commands/`.
Existing SDK-related commands live under `src/cli/commands/sdk/`.

### 2.1 Key files and implementations:
1. `src/cli/commands/sdk/workflows.ts`:
   - Defines commander subcommand `sdk workflows` with subcommands `list`, `get`, `create`, `update`, `delete`.
   - Obtains an authenticated client via `getSdkClient()`.
   - Calls service methods defined in `./services/workflows.js`.
2. `src/cli/commands/sdk/services/workflows.ts`:
   - Contains wrapper functions around `client.workflows` (e.g., `listWorkflows`, `getWorkflow`, etc.).
   - Utilizes `codemie-sdk` library.
3. `C:\epam\codemie-dev\codemie-sdk\sdk\codemie-nodejs\src\services\workflow.ts`:
   - Contains `run(workflowId, userInput, ...)` method which triggers a workflow run by creating a new workflow execution:
     ```typescript
     async run(workflowId: string, userInput?: string | Record<string, unknown>, fileName?: string, sessionId?: string, ...): Promise<AnyJson>
     ```

---

## 3. Design & Architecture Proposal

To fully cover the user requirements and maintain professional consistency with other subcommands, we will implement **two entry points** in the CLI for executing workflows:

1. **Top-Level `run` Command (`codemie run`):**
   - Syntax: `codemie run [workflow-id-or-name] [options]`
   - Options:
     - `-w, --workflow <id-or-name>`: Alternative way to specify the workflow.
     - `-i, --input <string-or-json>`: Inputs or variable values for execution.
     - `-f, --file <path>`: Associated file parameter.
     - `-s, --session <id>`: Target session ID.
     - `--json`: Output full raw execution details in JSON format.
   - Fits the description `codemie run --workflow <workflow_id>` perfectly.

2. **SDK Subcommand `run` (`codemie sdk workflows run`):**
   - Syntax: `codemie sdk workflows run <id-or-name> [options]`
   - Options:
     - `-i, --input <string-or-json>`: Inputs or variable values for execution.
     - `-f, --file <path>`: Associated file parameter.
     - `-s, --session <id>`: Target session ID.
     - `--json`: Output full raw execution details in JSON format.

### 3.1 ID and Name Resolution Logic:
If the user specifies a target (e.g., `"My Workflow"`) that is not a standard workflow ID (which typically starts with `wfl_`), we will:
1. Call `client.workflows.list({ search: idOrName })`.
2. Look for a workflow whose `name` exactly matches `idOrName` (case-insensitive) or whose `id` matches `idOrName`.
3. If exactly one match is found (or one exact name match is found), use that workflow's ID.
4. If no workflows or multiple ambiguous workflows are found, fail gracefully with a clear error message.

### 3.2 Code Modifications:

#### A. Add `runWorkflow` Service Method:
In `src/cli/commands/sdk/services/workflows.ts`:
```typescript
export async function runWorkflow(
  client: CodeMieClient,
  workflowId: string,
  userInput?: string | Record<string, unknown>,
  fileName?: string,
  sessionId?: string,
): Promise<unknown> {
  return client.workflows.run(workflowId, userInput, fileName, sessionId);
}
```

#### B. Update `src/cli/commands/sdk/workflows.ts`:
Add the `run` subcommand to the `workflows` subcommand collection.
Import `runWorkflow` and implement input parsing, name-resolution, and execution triggers.

#### C. Create `src/cli/commands/run.ts`:
Implement the top-level `run` command as described.

#### D. Register top-level `run` in `src/cli/index.ts`:
Add `import { createRunCommand } from './commands/run.js';` and `program.addCommand(createRunCommand());`.

---

## 4. Testing Plan

We will add comprehensive tests to verify this feature under `tests/integration/cli-commands/workflow.test.ts`.

### New Test Cases:
1. **List Workflows Command:** Verify that existing `workflow list` (and the SDK workflow listing commands) still work correctly.
2. **Top-Level Run Command (Help / Prerequisite):** Test that calling `codemie run --help` or `codemie run` with missing parameters behaves correctly.
3. **Workflow Name Resolution & Execution Mocking:** Verify that both ID and name lookup routes are resolved correctly and successfully trigger `runWorkflow`.
