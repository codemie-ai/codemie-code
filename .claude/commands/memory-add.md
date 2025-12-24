# Add New Knowledge to CLAUDE Memory Files

FYI: You, Claude Code, manage persistent memory using `CLAUDE.md` files for shared project context. The system recursively searches upward from the current working directory to load all relevant `CLAUDE.md` files, ensuring project-level context is available. Subdirectory `CLAUDE.md` files are only loaded when working within those subfolders, keeping the active context focused and efficient.

Additionally, placing a `CLAUDE.md` in your home directory (e.g., `~/.claude/CLAUDE.md`) provides a global, cross-project memory that is merged into every session under your home directory.

## Summary of Memory File Behavior

**Shared Project Memory (`CLAUDE.md`)**:
- Located in the repository root or any working directory
- Checked into version control for team-wide context sharing
- Loaded recursively from the current directory up to the root

**On-Demand Subdirectory Loading**:
- `CLAUDE.md` files in child folders are loaded only when editing files in those subfolders
- Prevents unnecessary context bloat

**Global User Memory (`~/.claude/CLAUDE.md`)**:
- Acts as a personal, cross-project memory
- Automatically merged into sessions under your home directory

---

## Instructions

If during your session:
* You learned something new about the project
* I corrected you on a specific implementation detail
* I corrected source code you generated
* You struggled to find specific information and had to infer details about the project
* You lost track of the project structure and had to look up information in the source code

...that is relevant, was not known initially, and should be persisted, add it to the appropriate `CLAUDE.md` file. If the information is relevant for a subdirectory only, place or update it in the `CLAUDE.md` file within that subdirectory.

When specific information belongs to a particular subcomponent, ensure you place it in the CLAUDE file for that component.

**For example (CodeMie CLI)**:
* Information about agent plugins → `src/agents/CLAUDE.md`
* Information about provider integration → `src/providers/CLAUDE.md`
* Information about CLI commands → `src/cli/CLAUDE.md`
* Information about analytics system → `src/analytics/CLAUDE.md`
* Information about workflow management → `src/workflows/CLAUDE.md`

This ensures important knowledge is retained and available in future sessions.
