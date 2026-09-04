#!/usr/bin/env node

/**
 * OpenWiki Agent Entry Point
 * Direct entry point for codemie-openwiki command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';
import { installProcessGuards } from '../dist/utils/process-guards.js';

installProcessGuards();

const agent = AgentRegistry.getAgent('openwiki');
if (!agent) {
  console.error('✗ OpenWiki agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
