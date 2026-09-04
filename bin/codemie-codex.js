#!/usr/bin/env node

/**
 * Codex Agent Entry Point
 * Direct entry point for codemie-codex command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';
import { installProcessGuards } from '../dist/utils/process-guards.js';

installProcessGuards();

const agent = AgentRegistry.getAgent('codex');
if (!agent) {
  console.error('✗ Codex agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
