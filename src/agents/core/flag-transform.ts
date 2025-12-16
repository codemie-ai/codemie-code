/**
 * Generic flag transformation utility
 *
 * Transforms multiple CLI flags based on declarative mapping configuration
 */

import type { FlagMappings, FlagMapping, AgentConfig } from './types.js';

/**
 * Transform multiple CLI flags based on declarative mappings
 *
 * @param args - Original command-line arguments
 * @param mappings - Declarative flag mappings configuration
 * @param _config - Agent configuration (for future use)
 * @returns Transformed arguments array
 *
 * @example
 * // Multiple flag mappings
 * transformFlags(
 *   ['--task', 'hello', '--profile', 'work', '--verbose'],
 *   {
 *     '--task': { type: 'flag', target: '-p' },
 *     '--profile': { type: 'flag', target: '--workspace' }
 *   },
 *   {}
 * )
 * // Returns: ['-p', 'hello', '--workspace', 'work', '--verbose']
 *
 * @example
 * // Subcommand transformation
 * transformFlags(
 *   ['--task', 'test', '--json'],
 *   { '--task': { type: 'subcommand', target: 'exec' } },
 *   {}
 * )
 * // Returns: ['exec', 'test', '--json']
 */
export function transformFlags(
  args: string[],
  mappings: FlagMappings | undefined,
  _config: AgentConfig
): string[] {
  // If no mappings defined, return args unchanged
  if (!mappings) {
    return args;
  }

  const result: string[] = [];
  let subcommandData: { target: string; value: string; position?: 'before' | 'after' } | null = null;

  // Process arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    // Check if this flag has a mapping
    const mapping = mappings[arg];

    if (mapping && nextArg !== undefined) {
      // Transform this flag
      const transformed = transformSingleFlag(mapping, nextArg);

      if (mapping.type === 'subcommand') {
        // Store subcommand data for later insertion
        subcommandData = {
          target: mapping.target || '',
          value: nextArg,
          position: mapping.position
        };
      } else {
        // For flag and positional types, add directly
        result.push(...transformed);
      }

      i++; // Skip next arg (the value)
    } else {
      // No mapping, keep as-is
      result.push(arg);
    }
  }

  // Insert subcommand at the beginning if needed
  if (subcommandData) {
    if (subcommandData.position === 'after') {
      // Subcommand, then other args, then value
      result.unshift(subcommandData.target);
      result.push(subcommandData.value);
    } else {
      // Default: subcommand, value, then other args
      result.unshift(subcommandData.target, subcommandData.value);
    }
  }

  return result;
}

/**
 * Transform a single flag based on its mapping
 */
function transformSingleFlag(mapping: FlagMapping, value: string): string[] {
  switch (mapping.type) {
    case 'flag':
      // Transform: --flag "value" → <target> "value"
      if (mapping.target) {
        return [mapping.target, value];
      }
      // Fallback: just the value
      return [value];

    case 'positional':
      // Transform: --flag "value" → "value"
      return [value];

    case 'subcommand':
      // Handled separately in main function
      return [];

    default:
      // Shouldn't happen with TypeScript, but safe fallback
      return [value];
  }
}
