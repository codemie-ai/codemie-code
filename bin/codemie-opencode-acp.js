#!/usr/bin/env node

/**
 * OpenCode ACP Agent Entry Point
 * Direct entry point for codemie-opencode-acp command
 *
 * ACP (Agent Communication Protocol) adapter for editor integration.
 * Uses OpenCode's native `acp` subcommand for stdio JSON-RPC communication.
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('opencode-acp');
if (!agent) {
  console.error('✗ OpenCode ACP agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
