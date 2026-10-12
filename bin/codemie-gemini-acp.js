#!/usr/bin/env node

/**
 * Gemini CLI ACP Agent Entry Point
 * Direct entry point for codemie-gemini-acp command
 *
 * ACP (Agent Communication Protocol) adapter for editor integration.
 * Uses Gemini CLI's native --acp mode for stdio JSON-RPC communication.
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('gemini-acp');
if (!agent) {
  console.error('✗ Gemini CLI ACP agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
