#!/usr/bin/env node

/**
 * Codex ACP Agent Entry Point
 * Direct entry point for codemie-codex-acp command
 *
 * ACP (Agent Communication Protocol) adapter for editor integration.
 * Uses @agentclientprotocol/codex-acp for stdio JSON-RPC communication.
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('codex-acp');
if (!agent) {
  console.error('✗ Codex ACP agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
