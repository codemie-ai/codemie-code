#!/usr/bin/env node
import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('opencode');
if (!agent) {
  console.error('OpenCode agent not found. Run: codemie doctor');
  process.exit(1);
}
const cli = new AgentCLI(agent);
await cli.run(process.argv);
