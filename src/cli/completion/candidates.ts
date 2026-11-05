/**
 * Resolves the enumerable candidate sets used by the completion script.
 *
 * Everything here is resolved once, at generation time, from the same
 * registries the CLI itself uses. `profiles` reads user config and `plugins`
 * reads plugin settings/cache; the rest are static or come from in-process
 * registries.
 */

// Side-effect imports: ensure provider and framework plugins are registered
// even if this module is loaded outside the normal CLI entry point.
import '@/providers/index.js';
import '@/frameworks/plugins/index.js';

import { AgentRegistry } from '@/agents/registry.js';
import { getUserFacingAgentName } from '@/agents/core/agent-aliases.js';
import { FrameworkRegistry } from '@/frameworks/core/registry.js';
import { ProviderRegistry } from '@/providers/core/registry.js';
import { resolvePlugins, readPluginSettings } from '@/plugins/core/index.js';
import { ConfigLoader } from '@/utils/config.js';
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

async function profileNames(): Promise<string[]> {
  try {
    const profiles = await ConfigLoader.listProfiles(process.cwd());
    return profiles.map((profile) => profile.name);
  } catch {
    return [];
  }
}

async function pluginNames(): Promise<string[]> {
  try {
    const settings = await readPluginSettings();
    const plugins = await resolvePlugins({ cwd: process.cwd(), settings });
    return plugins.map((plugin) => plugin.manifest.name);
  } catch {
    return [];
  }
}

function workflowIds(): string[] {
  return getAllTemplates().map((template) => template.id);
}

/**
 * Build the full candidate map. Called once per `codemie completion` run.
 */
export async function buildCandidateMap(): Promise<CandidateMap> {
  const agents = manageableAgentNames();
  const frameworks = frameworkNames('framework');
  const docsTools = frameworkNames('documentation');
  const installable = unique([...agents, ...frameworks, ...docsTools]);

  return {
    agents,
    'install-names': installable,
    'uninstall-names': installable,
    providers: ProviderRegistry.getProviderNames(),
    profiles: await profileNames(),
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
    plugins: await pluginNames(),
  };
}
