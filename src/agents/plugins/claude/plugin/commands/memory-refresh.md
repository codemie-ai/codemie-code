# Refresh and Audit CLAUDE Memory Files

**Instructions:**

**Step 1: Get Overview**

List all CLAUDE.md files in the project hierarchy and identify key directories that should have documentation.

Key directories to check:
* Root directory → `CLAUDE.md`
* Agent system → `src/agents/CLAUDE.md`
* Provider system → `src/providers/CLAUDE.md`
* CLI commands → `src/cli/CLAUDE.md`
* Analytics system → `src/analytics/CLAUDE.md`
* Workflow management → `src/workflows/CLAUDE.md`

**Step 2: Iterative Review**

Process each directory systematically, starting with the root `CLAUDE.md` file:

**If CLAUDE.md exists:**
- Load the current content
- Compare documented patterns against actual implementation
- Identify outdated, incorrect, or missing information

**If CLAUDE.md does NOT exist:**
- Follow the memory-init process (see `.claude/commands/memory-init.md`):
  1. Investigate architecture of the directory and subdirectories
  2. Analyze design patterns, dependencies, abstractions, naming conventions
  3. Create new CLAUDE.md file capturing this knowledge

**Step 3: Update and Refactor**

For each memory file (existing or newly created):
- Verify all technical claims against the current codebase
- Remove obsolete information
- Consolidate duplicate entries
- Ensure information is in the most appropriate file

When information belongs to a specific subcomponent, ensure it's placed correctly:
* Agent-specific patterns → `src/agents/CLAUDE.md`
* Provider integration details → `src/providers/CLAUDE.md`
* CLI command patterns → `src/cli/CLAUDE.md`
* Analytics system details → `src/analytics/CLAUDE.md`
* Workflow management patterns → `src/workflows/CLAUDE.md`

**Documentation Content Guidelines (applies to both new and refreshed files):**
- Purpose and responsibility of this module
- Key architectural decisions
- Important implementation details
- Common patterns used throughout the code
- Any gotchas or non-obvious behaviors

Focus on clarity, accuracy, and relevance. Remove any information that no longer serves the project.
