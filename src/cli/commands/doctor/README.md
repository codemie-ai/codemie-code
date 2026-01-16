# Doctor Command Architecture

The `codemie doctor` command has been refactored into a modular, extensible architecture.

## Directory Structure

```
doctor/
├── index.ts                    # Main orchestrator
├── types.ts                    # Type definitions
├── formatter.ts                # Display logic
├── checks/                     # Standard health checks
│   ├── NodeVersionCheck.ts
│   ├── NpmCheck.ts
│   ├── AIConfigCheck.ts
│   ├── AgentsCheck.ts
│   ├── ToolsCheck.ts
│   ├── WorkflowsCheck.ts
│   └── index.ts
└── providers/                  # Provider-specific checks
    ├── BaseProviderCheck.ts
    ├── AIRunSSOProviderCheck.ts
    ├── StandardProviderCheck.ts
    └── index.ts
```

## Architecture Principles

### 1. Separation of Concerns

- **Health Checks**: Independent modules that perform specific checks
- **Provider Checks**: Specialized checks for different AI providers
- **Formatter**: Display logic separated from business logic
- **Orchestrator**: Main command coordinates execution

### 2. Extensibility

#### Adding a New Health Check

Create a new check class implementing the `HealthCheck` interface:

```typescript
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class MyCustomCheck implements HealthCheck {
  name = 'My Custom Check';

  async run(): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    // Your check logic here
    details.push({
      status: 'ok',
      message: 'Check passed'
    });

    return { name: this.name, success, details };
  }
}
```

Then register it in `index.ts`:

```typescript
import { MyCustomCheck } from './checks/MyCustomCheck.js';

const checks: HealthCheck[] = [
  // ... existing checks
  new MyCustomCheck()
];
```

#### Adding a Provider-Specific Check

Create a provider check extending `BaseProviderCheck`:

```typescript
import { BaseProviderCheck } from './BaseProviderCheck.js';
import { HealthCheckResult, HealthCheckDetail } from '../types.js';
import { CodeMieConfigOptions } from '../../../../utils/config-loader.js';

export class MyProviderCheck extends BaseProviderCheck {
  readonly supportedProviders = ['my-provider'];

  async check(config: CodeMieConfigOptions): Promise<HealthCheckResult> {
    const details: HealthCheckDetail[] = [];
    let success = true;

    // Your provider-specific check logic
    details.push({
      status: 'ok',
      message: 'Provider check passed'
    });

    return this.createResult('My Provider Check', success, details);
  }
}
```

Register it in `providers/index.ts`:

```typescript
class ProviderCheckRegistry {
  private checks: ProviderHealthCheck[] = [
    // ... existing checks
    new MyProviderCheck()
  ];
}
```

### 3. Reusability

All health checks are independent, reusable modules that can be:
- Run individually
- Tested in isolation
- Composed into different health check suites
- Used by other commands or tools

### 4. Maintainability

#### Single Responsibility

Each class has one job:
- `NodeVersionCheck`: Check Node.js version
- `AIConfigCheck`: Validate AI configuration
- `AIRunSSOProviderCheck`: Check AI-Run SSO provider
- `HealthCheckFormatter`: Display results

#### Consistent Patterns

All checks follow the same pattern:
1. Implement `HealthCheck` interface
2. Return `HealthCheckResult` with details
3. Use standard status types: `ok`, `warn`, `error`, `info`

#### Type Safety

Full TypeScript coverage ensures:
- Correct interface implementations
- Type-safe provider checks
- Validated result structures

## Types

### HealthStatus

```typescript
type HealthStatus = 'ok' | 'warn' | 'error' | 'info';
```

### HealthCheckDetail

```typescript
interface HealthCheckDetail {
  status: HealthStatus;
  message: string;
  hint?: string;  // Optional hint for fixing issues
}
```

### HealthCheckResult

```typescript
interface HealthCheckResult {
  name: string;
  success: boolean;
  details: HealthCheckDetail[];
}
```

### HealthCheck

```typescript
interface HealthCheck {
  name: string;
  run(): Promise<HealthCheckResult>;
}
```

### ProviderHealthCheck

```typescript
interface ProviderHealthCheck {
  supports(provider: string): boolean;
  check(config: CodeMieConfigOptions): Promise<HealthCheckResult>;
}
```

## Provider Support

The system currently supports these providers:

- **ai-run-sso**: AI-Run SSO authentication with integration validation
- **openai**: OpenAI API with model verification
- **azure**: Azure OpenAI with endpoint validation
- **litellm**: LiteLLM proxy gateway
- **gemini**: Google Gemini API

Each provider can have custom health checks tailored to its authentication method and features.

## Benefits

### Before (Monolithic)

- ❌ 276-line function with mixed concerns
- ❌ Hard to add new checks
- ❌ Hard to test individual checks
- ❌ Provider logic scattered throughout
- ❌ Display logic mixed with business logic

### After (Modular)

- ✅ Small, focused classes (20-80 lines each)
- ✅ Easy to add new checks (just create a new class)
- ✅ Each check can be tested independently
- ✅ Provider checks automatically discovered via registry
- ✅ Clean separation of display and logic
- ✅ Type-safe and extensible

## Future Enhancements

Potential improvements:

1. **JSON Output Mode**: For CI/CD integration
2. **Selective Checks**: Run only specific checks
3. **Severity Levels**: Distinguish critical vs. warning
4. **Auto-Fix Suggestions**: Commands to fix detected issues
5. **Custom Check Registration**: Plugin system for external checks
6. **Parallel Execution**: Run independent checks concurrently
