#!/usr/bin/env node

/**
 * Oh My Pi Agent Entry Point
 * Direct entry point for codemie-omp command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('omp');
if (!agent) {
  console.error('✗ Oh My Pi agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
