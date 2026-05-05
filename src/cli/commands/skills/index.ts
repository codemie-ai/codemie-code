/**
 * Commander wiring for `codemie skills`.
 *
 * The wrapper delegates installation/management to the upstream `skills`
 * CLI while gating commands on CodeMie SSO authentication, blocking
 * upstream telemetry/audit egress, and emitting minimal lifecycle metrics.
 */

import { Command } from 'commander';
import { createAddCommand } from './add.js';
import { createUpdateCommand } from './update.js';
import { createRemoveCommand } from './remove.js';
import { createListCommand } from './list.js';
import { createFindCommand } from './find.js';

export function createSkillsCommand(): Command {
  const command = new Command('skills').description(
    'Install, manage, and discover skills via the upstream skills CLI and the CodeMie catalog'
  );

  command.addCommand(createAddCommand());
  command.addCommand(createUpdateCommand());
  command.addCommand(createRemoveCommand());
  command.addCommand(createListCommand());
  command.addCommand(createFindCommand());

  return command;
}
