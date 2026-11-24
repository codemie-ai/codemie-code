import { MigrationRegistry } from './registry.js';
import { RewriteHookCommandPathsMigration } from './006-resolve-hook-command-paths.migration.js';

// Re-runs the 006 rewrite now that resolveHookCommand also repairs missing codemie
// paths and the PowerShell `& ` call operator. See EPMCDME-15907.
class RepairHookShellAndStalePathsMigration extends RewriteHookCommandPathsMigration {
  id = '008-repair-hook-shell-and-stale-paths';
  description = 'Repair installed hook commands: missing codemie paths and PowerShell call operator';
}

MigrationRegistry.register(new RepairHookShellAndStalePathsMigration());
