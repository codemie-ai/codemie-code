/**
 * Resolves the enumerable candidate sets used by the completion script.
 *
 * Stable values are resolved from in-process registries at build time. Profile
 * and plugin names are looked up separately when the shell needs them.
 */

// Side-effect imports: ensure provider and framework plugins are registered
// even if this module is loaded outside the normal CLI entry point.
import '@/providers/index.js';
import '@/frameworks/plugins/index.js';

import { AgentRegistry } from '@/agents/registry.js';
import { getUserFacingAgentName } from '@/agents/core/agent-aliases.js';
import { FrameworkRegistry } from '@/frameworks/core/registry.js';
import { ProviderRegistry } from '@/providers/core/registry.js';
import { getAllTemplates } from '@/workflows/registry.js';
import { SUPPORTED_SHELLS } from './types.js';
import type { CandidateMap } from './types.js';

const TARGET_AGENTS = ['claude', 'codex', 'gemini'];
const OUTPUT_FORMATS = ['text', 'json', 'jsonl'];
const REPORT_FORMATS = ['html', 'json', 'both'];
const BMAD_PRESETS = ['sdlc', 'minimal', 'interactive'];
const BMAD_CHANNELS = ['latest', 'next'];
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function manageableAgentNames(): string[] {
  return AgentRegistry.getManageableAgents().map((adapter) =>
    getUserFacingAgentName(adapter.name)
  );
}

function frameworkNames(group: 'framework' | 'documentation'): string[] {
  return FrameworkRegistry.getFrameworksByGroup(group).map((adapter) => adapter.metadata.name);
}

function workflowIds(): string[] {
  return getAllTemplates().map((template) => template.id);
}

/**
 * Build the static candidate map for the distributed completion scripts.
 */
export function buildCandidateMap(): CandidateMap {
  const agents = manageableAgentNames();
  const frameworks = frameworkNames('framework');
  const docsTools = frameworkNames('documentation');
  const installable = unique([...agents, ...frameworks, ...docsTools]);

  return {
    agents,
    'install-names': installable,
    'uninstall-names': installable,
    providers: ProviderRegistry.getProviderNames(),
    profiles: [],
    workflows: unique(workflowIds()),
    'docs-tools': docsTools,
    frameworks,
    'init-names': unique([...frameworks, ...docsTools]),
    targets: [...TARGET_AGENTS],
    formats: [...OUTPUT_FORMATS],
    'report-formats': [...REPORT_FORMATS],
    presets: [...BMAD_PRESETS],
    'bmad-channels': [...BMAD_CHANNELS],
    'reasoning-efforts': [...REASONING_EFFORTS],
    shells: [...SUPPORTED_SHELLS],
    plugins: [],
  };
}
