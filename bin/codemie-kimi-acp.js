#!/usr/bin/env node

/**
 * Kimi Code ACP Agent Entry Point
 * Direct entry point for codemie-kimi-acp command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('kimi-acp');
if (!agent) {
  console.error('✗ Kimi ACP agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
