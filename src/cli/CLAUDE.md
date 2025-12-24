# CLI Command Development Guide

This guide provides documentation for developing CLI commands in the CodeMie CLI.

**Context**: This file is loaded automatically when working in `src/cli/**`. It contains patterns for command development and CLI integration.

---

## Overview

The CLI System uses a **modular command pattern** that enables:
- Self-contained command modules with factory pattern
- Minimal main CLI that delegates to commands
- Easy testing and composition
- Commander.js-based architecture

---

## CLI Architecture

### Main CLI (`index.ts`)

Commander.js orchestrator - minimal, delegates to commands

### Commands (`commands/`)

Self-contained command modules:
- `setup.ts`: Interactive multi-provider configuration wizard
- `install.ts`/`uninstall.ts`: Agent lifecycle management
- `doctor/`: Extensible health check system with provider-specific checks
- `profile.ts`: Profile management (list, switch, delete, rename)
- `workflow.ts`: CI/CD workflow installation
- `auth.ts`: SSO authentication management
- `version.ts`: Version information
- `analytics.ts`: Usage analytics and reporting

**Pattern**: Each command is a factory function (`createXCommand()`) returning a Commander instance

---

## Command Factory Pattern

### Creating a New Command

```typescript
import { Command } from 'commander';

export function createMyCommand(): Command {
  return new Command('mycommand')
    .description('Description of what this command does')
    .argument('[arg]', 'Optional argument description')
    .option('-f, --flag', 'Option description')
    .action(async (arg, options) => {
      // Command logic here
      try {
        // Implementation
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
}
```

### Registering Command

In `src/cli/index.ts`:

```typescript
import { createMyCommand } from './commands/mycommand.js';

// Add to program
program.addCommand(createMyCommand());
```

---

## Command Patterns

### Pattern 1: Interactive Command (Setup Wizard)

Use `@clack/prompts` for interactive flows:

```typescript
import * as clack from '@clack/prompts';

export function createSetupCommand(): Command {
  return new Command('setup')
    .description('Configure CodeMie CLI')
    .action(async () => {
      clack.intro('CodeMie Setup');

      const provider = await clack.select({
        message: 'Select provider:',
        options: [
          { value: 'openai', label: 'OpenAI' },
          { value: 'ollama', label: 'Ollama (local)' }
        ]
      });

      const apiKey = await clack.password({
        message: 'Enter API key:',
        validate: (value) => value ? undefined : 'API key is required'
      });

      clack.outro('Setup complete!');
    });
}
```

### Pattern 2: List Command with Formatting

Display structured data clearly:

```typescript
import chalk from 'chalk';

export function createListCommand(): Command {
  return new Command('list')
    .description('List items')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const items = await fetchItems();

      if (options.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      console.log(chalk.bold('\nItems:'));
      items.forEach(item => {
        console.log(`  ${chalk.cyan(item.name)} - ${item.description}`);
      });
    });
}
```

### Pattern 3: Command with Subcommands

Organize related functionality:

```typescript
export function createProfileCommand(): Command {
  const profile = new Command('profile')
    .description('Manage profiles');

  // Subcommand: list
  profile
    .command('list')
    .description('List all profiles')
    .action(async () => {
      // List logic
    });

  // Subcommand: switch
  profile
    .command('switch')
    .argument('<name>', 'Profile name')
    .action(async (name) => {
      // Switch logic
    });

  return profile;
}
```

### Pattern 4: Command with Progress Indication

Show progress for long-running operations:

```typescript
import { spinner } from '@clack/prompts';

export function createInstallCommand(): Command {
  return new Command('install')
    .argument('<agent>', 'Agent to install')
    .action(async (agentName) => {
      const s = spinner();

      s.start(`Installing ${agentName}...`);

      try {
        await installAgent(agentName);
        s.stop(`${agentName} installed successfully`);
      } catch (error) {
        s.stop(`Failed to install ${agentName}`);
        console.error(error.message);
        process.exit(1);
      }
    });
}
```

---

## Testing Commands

### Integration Testing

Test commands end-to-end:

```typescript
import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('setup command', () => {
  it('should show help', async () => {
    const { stdout } = await execAsync('codemie setup --help');
    expect(stdout).toContain('Configure CodeMie CLI');
  });

  it('should handle errors gracefully', async () => {
    try {
      await execAsync('codemie setup --invalid-flag');
    } catch (error) {
      expect(error.message).toContain('unknown option');
    }
  });
});
```

---

## Best Practices

### Error Handling

- Always use try-catch in command actions
- Provide clear, actionable error messages
- Exit with non-zero code on errors
- Log errors appropriately for debugging

```typescript
.action(async (options) => {
  try {
    await performAction();
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
});
```

### User Feedback

- Use spinners for long operations
- Show progress where appropriate
- Use colors for better readability
- Provide success confirmations

### Command Documentation

- Write clear descriptions
- Document all options and arguments
- Provide examples in help text
- Keep help text concise

```typescript
.description('Install an agent')
.argument('<agent>', 'Agent name (claude, codex, gemini, deepagents)')
.option('-v, --verbose', 'Show detailed output')
.addHelpText('after', `
Examples:
  $ codemie install claude
  $ codemie install codex --verbose
`)
```

---

## Configuration Access

Commands often need to access configuration:

```typescript
import { ConfigLoader } from '../../utils/config-loader.js';

.action(async (options) => {
  const config = await ConfigLoader.load(process.cwd(), {
    name: options.profile
  });

  console.log(`Using provider: ${config.provider}`);
  console.log(`Using model: ${config.model}`);
});
```

---

## Common Utilities

### File Operations

Use `src/utils/` utilities:

```typescript
import { ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

await ensureDir('~/.codemie');
logger.info('Directory created');
```

### Process Execution

Use `exec` utility for running commands:

```typescript
import { exec } from '../utils/exec.js';

try {
  const output = await exec('npm', ['install', 'package'], {
    timeout: 60000
  });
  console.log(output);
} catch (error) {
  console.error(`Command failed: ${error.message}`);
}
```

---

## Validation Checklist

Before submitting a new command:

- ✅ Factory function follows naming: `createXCommand()`
- ✅ Registered in `src/cli/index.ts`
- ✅ Clear description and help text
- ✅ All options and arguments documented
- ✅ Error handling implemented
- ✅ User feedback (spinners, colors, messages)
- ✅ Integration test written
- ✅ ESLint passes (`npm run lint`)
- ✅ Builds successfully (`npm run build`)
- ✅ Manual testing completed

---

## Reference Implementations

Study these commands for examples:
- **`setup.ts`**: Interactive wizard with multi-step flow
- **`profile.ts`**: Command with subcommands (list, switch, delete)
- **`install.ts`**: Progress indication and error handling
- **`doctor/`**: Extensible system with pluggable checks
- **`analytics.ts`**: Complex data aggregation and export

---

## Architecture Benefits

✅ **Modular**: Each command is self-contained and testable
✅ **Composable**: Commands can be easily combined and reused
✅ **Maintainable**: Clear separation of concerns
✅ **Type-Safe**: Full TypeScript support with Commander.js
✅ **User-Friendly**: Consistent UX across all commands
