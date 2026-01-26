#!/usr/bin/env node

/**
 * Copy /mr skill from project scope to global scope
 *
 * This script copies the project-level /mr skill to ~/.claude/skills/mr/
 * making it available globally across all projects.
 *
 * Usage:
 *   npm run build && node dist/scripts/copy-mr-skill-to-global.js
 *   OR
 *   npx tsx scripts/copy-mr-skill-to-global.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter } from '../src/skills/utils/frontmatter.js';
import { SkillMetadataSchema } from '../src/skills/core/types.js';
import { resolveHomeDir } from '../src/utils/paths.js';
import { SkillManager } from '../src/skills/index.js';
import * as readline from 'readline';

interface CopyResult {
  success: boolean;
  message: string;
  copiedFiles?: string[];
}

/**
 * Validate source skill exists and has valid frontmatter
 */
async function validateSourceSkill(sourceDir: string): Promise<void> {
  const skillPath = path.join(sourceDir, 'SKILL.md');

  // Check file exists
  try {
    await fs.access(skillPath, fs.constants.R_OK);
  } catch {
    throw new Error(`Source skill not found: ${skillPath}`);
  }

  // Validate frontmatter
  const content = await fs.readFile(skillPath, 'utf-8');
  const { metadata } = parseFrontmatter(content, skillPath);
  const validated = SkillMetadataSchema.parse(metadata);

  console.log(`✓ Source skill validated: ${validated.name}`);
  console.log(`  Description: ${validated.description}`);
}

/**
 * Check if target already exists and prompt user for overwrite
 */
async function checkTargetConflict(targetDir: string): Promise<void> {
  const targetSkillPath = path.join(targetDir, 'SKILL.md');

  try {
    await fs.access(targetSkillPath, fs.constants.F_OK);

    // File exists - prompt user
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `\n⚠️  Global /mr skill already exists. Overwrite? (y/N): `,
        resolve
      );
    });

    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('❌ Operation cancelled by user');
      process.exit(0);
    }

    // Create backup before overwriting
    const backupDir = `${targetDir}.backup-${Date.now()}`;
    await fs.rename(targetDir, backupDir);
    console.log(`✓ Backup created: ${backupDir}`);
  } catch {
    // File doesn't exist - proceed
    console.log('✓ No conflict detected');
  }
}

/**
 * Create necessary directories for the skill
 */
async function prepareDirectories(targetDir: string): Promise<void> {
  // Create main directory
  await fs.mkdir(targetDir, { recursive: true });

  // Create references subdirectory
  const refsDir = path.join(targetDir, 'references');
  await fs.mkdir(refsDir, { recursive: true });

  console.log(`✓ Directories created: ${targetDir}`);
}

/**
 * Copy all skill files from source to target
 */
async function copySkillFiles(
  sourceDir: string,
  targetDir: string
): Promise<string[]> {
  const filesToCopy = [
    { source: 'SKILL.md', target: 'SKILL.md' },
    { source: 'references/branch-naming.md', target: 'references/branch-naming.md' },
    { source: 'references/examples.md', target: 'references/examples.md' },
  ];

  const copiedFiles: string[] = [];

  for (const { source, target } of filesToCopy) {
    const sourcePath = path.join(sourceDir, source);
    const targetPath = path.join(targetDir, target);

    // Ensure subdirectory exists
    const targetSubdir = path.dirname(targetPath);
    await fs.mkdir(targetSubdir, { recursive: true });

    // Copy file
    await fs.copyFile(sourcePath, targetPath);
    copiedFiles.push(source);

    console.log(`✓ Copied: ${source}`);
  }

  return copiedFiles;
}

/**
 * Validate the copied skill has valid frontmatter
 */
async function validateCopiedSkill(skillPath: string): Promise<void> {
  // Verify file exists
  await fs.access(skillPath, fs.constants.R_OK);

  // Validate frontmatter
  const content = await fs.readFile(skillPath, 'utf-8');
  const { metadata } = parseFrontmatter(content, skillPath);
  SkillMetadataSchema.parse(metadata);

  console.log(`✓ Copied skill validated successfully`);
}

/**
 * Test that the skill is discoverable by SkillManager
 */
async function testDiscovery(): Promise<void> {
  const manager = SkillManager.getInstance();
  manager.reload(); // Clear cache

  const skills = await manager.listSkills({
    cwd: process.cwd(),
    forceReload: true,
  });

  const mrSkills = skills.filter(s => s.metadata.name === 'mr');

  if (mrSkills.length > 0) {
    console.log(`✓ Skill discoverable (${mrSkills.length} instance(s) found)`);
    mrSkills.forEach(skill => {
      console.log(`  Source: ${skill.source}`);
      console.log(`  Priority: ${skill.computedPriority}`);
      console.log(`  Path: ${skill.filePath}`);
    });
  } else {
    console.warn('⚠️  Skill not immediately discoverable (may need agent restart)');
  }
}

/**
 * Print success message with next steps
 */
function printSuccess(targetDir: string, files: string[]): void {
  console.log('\n' + '='.repeat(60));
  console.log('✅ Successfully copied /mr skill to global scope!');
  console.log('='.repeat(60));
  console.log(`\n📁 Location: ${targetDir}`);
  console.log(`📄 Files copied: ${files.length}`);
  console.log(`\n🔄 Next steps:`);
  console.log(`1. The skill is now available globally across all projects`);
  console.log(`2. Use /mr in any project to create pull requests`);
  console.log(`3. Run "codemie skill list" to verify it's loaded`);
  console.log(`4. Run "codemie skill reload" to refresh if needed`);
  console.log(`\n💡 Tip: Project-level skills (if present) take priority over global skills.\n`);
}

/**
 * Print error message with troubleshooting tips
 */
function printError(error: unknown): void {
  console.error('\n' + '='.repeat(60));
  console.error('❌ Failed to copy /mr skill');
  console.error('='.repeat(60));
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) {
    console.error(`\nStack trace:\n${error.stack}`);
  }
  console.error(`\n🔍 Troubleshooting:`);
  console.error(`- Check source exists: .codemie/skills/mr/SKILL.md`);
  console.error(`- Check permissions: ~/.claude/skills/`);
  console.error(`- Check disk space: df -h ~`);
  console.error(`- Validate frontmatter: codemie skill validate\n`);
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  try {
    console.log('\n🚀 Starting /mr skill copy to global scope...\n');

    // Phase 1: Validate source
    console.log('Phase 1: Validating source skill...');
    const sourceDir = path.join(process.cwd(), '.codemie', 'skills', 'mr');
    await validateSourceSkill(sourceDir);

    // Phase 2: Check target
    console.log('\nPhase 2: Checking target location...');
    const targetDir = resolveHomeDir('.claude/skills/mr');
    await checkTargetConflict(targetDir);

    // Phase 3: Prepare directories
    console.log('\nPhase 3: Preparing directories...');
    await prepareDirectories(targetDir);

    // Phase 4: Copy files
    console.log('\nPhase 4: Copying skill files...');
    const files = await copySkillFiles(sourceDir, targetDir);

    // Phase 5: Validate
    console.log('\nPhase 5: Validating copied skill...');
    await validateCopiedSkill(path.join(targetDir, 'SKILL.md'));
    await testDiscovery();

    // Phase 6: Success feedback
    printSuccess(targetDir, files);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

// Run main function
main();
