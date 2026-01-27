# CodeMie Extension for Gemini CLI

## Overview

The CodeMie extension enables event-driven observability for Gemini CLI, providing:

- Session tracking and metrics collection
- Conversation synchronization to CodeMie platform
- Real-time analytics and insights
- Enterprise SSO integration

## Installation

This extension is automatically installed when using CodeMie CLI with the `ai-run-sso` provider.

### Manual Installation

If needed, you can manually copy this extension to:

```
~/.gemini/extensions/codemie/
```

Gemini CLI automatically discovers and loads extensions from this directory.

## Features

### Event Tracking

The extension registers hooks for key Gemini CLI events:

- **SessionStart**: Captures session initialization
- **SessionEnd**: Records session completion
- **AfterAgent**: Tracks agent execution completion
- **PreCompress**: Monitors context compression events
- **Notification**: Logs user notifications and permission requests

### Metrics Collection

Automatically collects and syncs:

- Conversation metadata (session ID, timestamps, duration)
- Message history (user prompts, assistant responses)
- Tool usage statistics
- Error tracking and diagnostics

### SSO Integration

When using `ai-run-sso` provider:

- Seamless authentication with CodeMie platform
- Centralized model management
- Usage analytics per user/team
- Compliance and audit logging

## Configuration

No manual configuration required. The extension uses environment variables set by CodeMie CLI:

- `CODEMIE_SESSION_ID`: Unique session identifier
- `CODEMIE_URL`: CodeMie platform endpoint
- `CODEMIE_INTEGRATION_ID`: Integration identifier for analytics

## Troubleshooting

### Extension Not Loading

1. Verify installation location: `~/.gemini/extensions/codemie/`
2. Check manifest file exists: `gemini-extension.json`
3. Ensure hooks are properly configured: `hooks/hooks.json`

### Hooks Not Firing

1. Verify `codemie` CLI is in PATH
2. Check Gemini CLI version compatibility
3. Review Gemini CLI logs for errors

## Support

For issues or questions:

- Documentation: https://codemie.lab.epam.com/docs
- Support: support@codemieai.com
- GitHub: https://github.com/codemie-ai/codemie-code

## License

Copyright © 2025 AI/Run CodeMie. All rights reserved.
