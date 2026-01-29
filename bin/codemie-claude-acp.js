#!/usr/bin/env node

/**
 * Claude Code ACP Agent Entry Point
 * Direct entry point for codemie-claude-acp command
 *
 * ACP (Agent Communication Protocol) adapter for editor integration.
 * Uses Zed's claude-code-acp wrapper for stdio JSON-RPC communication.
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('claude-acp');
if (!agent) {
  console.error('✗ Claude ACP agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
