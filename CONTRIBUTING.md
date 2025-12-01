# Contributing

Contributions are welcome! We appreciate any help you can provide to improve the project. Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before you start.

## How to Contribute

1.  **Fork the repository** on GitHub.
2.  **Clone your fork** to your local machine.
3.  **Create a new branch** for your changes: `git checkout -b my-feature-branch`.
4.  **Make your changes** and commit them following our [commit message format](#commit-message-format).
5.  **Push your changes** to your fork: `git push origin my-feature-branch`.
6.  **Create a pull request** from your fork to the main repository following our [PR title format](#pull-request-format).

## Commit Message Format

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for clear and semantic commit messages.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

- **feat**: A new feature for the user
- **fix**: A bug fix
- **docs**: Documentation changes only
- **style**: Code style changes (formatting, semicolons, etc.) with no code logic change
- **refactor**: Code change that neither fixes a bug nor adds a feature
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **chore**: Changes to build process, tools, dependencies, or other maintenance tasks
- **ci**: Changes to CI/CD configuration files and scripts

### Scope (optional but recommended)

The scope provides additional contextual information and is contained within parentheses:
- **agents**: Changes to agent system (plugins, registry, core)
- **cli**: CLI commands and interface
- **config**: Configuration system
- **analytics**: Analytics and tracking
- **workflows**: CI/CD workflow management
- **auth**: Authentication and SSO
- **proxy**: Proxy server functionality
- **tools**: Built-in agent tools (filesystem, git, etc.)
- **docs**: Documentation updates

### Rules

- **Description**: Use imperative mood ("add" not "added" or "adds")
- **Capitalization**: Start with lowercase letter
- **Length**: First line max 72 characters, body lines max 100 characters
- **Body**: Separate from description with blank line, wrap at 100 characters
- **Footer**: Reference issues using `Fixes #123` or `Closes #456`
- **Breaking Changes**: Mark with `BREAKING CHANGE:` in footer or `!` after type/scope

### Examples

✅ **Valid:**

```
feat(analytics): add API response tracking for all agents

Implement comprehensive tracking of API requests and responses across
all agent types (Claude, Codex, Gemini, CodeMie Native).

Includes automatic content extraction from multiple API formats and
privacy-first redaction of sensitive data.

Closes #123
```

```
fix(config): resolve profile switching for legacy configs

Migration from v1 to v2 config format was not preserving
the active profile setting.

Fixes #456
```

```
docs: update README with new analytics commands
```

```
chore(deps): bump @langchain/core to v1.0.4
```

```
feat(cli)!: change default timeout from 30s to 60s

BREAKING CHANGE: The default API timeout has been increased from 30
seconds to 60 seconds to accommodate longer-running requests. Users
relying on the 30s timeout should explicitly set the timeout flag.
```

❌ **Invalid:**

```
Add analytics support              # Missing type
analytics: Add support             # Wrong type format
feat(analytics) add support        # Missing colon
feat(analytics): Added support     # Wrong mood (use "add" not "Added")
feat(analytics): Add Support       # Description should be lowercase
Feat(analytics): add support       # Type should be lowercase
```

## Pull Request Format

PR titles must follow the same Conventional Commits format:

```
<type>(<scope>): <description>
```

### PR Guidelines

- **Title**: Use Conventional Commits format (same as commits)
- **Description**: Provide clear context about:
  - **What**: What changes were made
  - **Why**: Motivation and context
  - **How**: Approach and implementation details
  - **Testing**: How the changes were tested
- **References**: Link related issues using `Fixes #123`, `Closes #456`, or `Relates to #789`
- **Breaking Changes**: Clearly document any breaking changes in the PR description
- **Commits**: Each commit in the PR should follow the commit message format

### PR Description Template

```markdown
## Summary
Brief overview of the changes

## Motivation
Why these changes are needed

## Changes
- Detailed list of changes
- One item per significant change

## Testing
How the changes were tested

## Breaking Changes
List any breaking changes (if applicable)

## Related Issues
Fixes #123
Relates to #456
```

### Examples

✅ **Valid PR Titles:**
```
feat(analytics): add unified tracking system for all agents
fix(config): resolve multi-provider profile switching
docs: add contribution guidelines for commit messages
chore: update CI pipeline with validation checks
```

❌ **Invalid PR Titles:**
```
Add analytics                    # Missing type and scope
Analytics support                # Missing type format
feat: Add Analytics Support      # Description should be lowercase
feature(analytics): add support  # Use "feat" not "feature"
```

## Setting up the Development Environment

To get the project running locally, follow these steps:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/codemie-ai/codemie-code.git
    cd codemie-code
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Build the project:**
    ```bash
    npm run build
    ```
4.  **Link the package** to use the `codemie` command globally:
    ```bash
    npm link
    ```

## Running Tests and Validation

### Run All Tests
```bash
npm test                # Run tests in watch mode
npm run test:run        # Run tests once
npm run test:unit       # Run unit tests only
npm run test:integration # Run integration tests only
```

### Run Validation Checks

**IMPORTANT:** Before creating a pull request, run the full CI checks locally:

```bash
# Run full CI checks (commit validation + license + lint + build + tests)
npm run ci

# Run CI with secrets detection (requires Docker)
npm run ci:full
```

**Note:** `npm run ci` includes commit validation and will **fail** if your last commit doesn't follow the Conventional Commits format. This ensures you catch format issues before pushing.

**Individual validation commands:**

```bash
# Validate your last commit message
npm run validate:commit

# Check for exposed secrets (requires Docker)
npm run validate:secrets

# Check dependency licenses
npm run license-check

# Run linting
npm run lint

# Fix linting issues automatically
npm run lint:fix

# Build TypeScript
npm run build
```

### Pre-Commit Checklist

Before committing, ensure:

1. ✅ Commit message follows Conventional Commits format
2. ✅ Code passes ESLint with zero warnings: `npm run lint`
3. ✅ TypeScript compiles: `npm run build`
4. ✅ All tests pass: `npm run test:run`
5. ✅ No secrets exposed: `npm run validate:secrets` (optional, requires Docker)
6. ✅ Dependencies have approved licenses: `npm run license-check`

**Quick check:** Run `npm run ci` to verify everything passes before pushing.
