/** Internal, read-only dynamic completion candidates. */
import { existsSync } from 'fs';
import { discoverPluginSources, readPluginSettingsQuietly } from '../../plugins/core/plugin-discovery.js';
import { parseManifest } from '../../plugins/core/manifest-readonly.js';
import { readProfileEntries } from '../../utils/config-profile-reader.js';
import { getCodemiePath } from '../../utils/paths.js';

async function pluginNames(cwd: string): Promise<string[]> {
  const settings = await readPluginSettingsQuietly();
  const sources = await discoverPluginSources(cwd, settings);
  const names = new Set<string>();
  // Unlike full resolution, this deliberately does not load components. A manifest
  // with malformed component paths can therefore be listed but fail at runtime.
  for (const { dirs } of sources) {
    for (const dir of dirs) {
      try {
        if (existsSync(dir)) names.add((await parseManifest(dir)).name);
      } catch {
        // Match the resolver: skip this source, not all other plugins.
      }
    }
  }
  return [...names];
}

async function main(): Promise<void> {
  try {
    const kind = process.argv[2];
    let names: string[];
    if (kind === 'profiles') {
      names = (await readProfileEntries(getCodemiePath('codemie-cli.config.json'), process.cwd()))
        .map(profile => profile.name);
    } else if (kind === 'plugins') {
      names = await pluginNames(process.cwd());
    } else {
      return;
    }
    // The protocol is line-based; all C0/C1 control characters are unsafe.
    const safeNames = names.filter(name => name.length > 0 &&
      [...name].every(char => {
        const code = char.codePointAt(0)!;
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      }));
    if (safeNames.length) process.stdout.write(`${safeNames.join('\n')}\n`);
  } catch {
    // Completion failures must not disrupt the shell or print configuration data.
  }
}

process.stdout.on('error', () => {});
void main();
