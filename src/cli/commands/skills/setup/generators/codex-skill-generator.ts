import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dedent from 'dedent';
import type { SkillDetail } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';

function getSkillsDir(scope: 'global' | 'local' = 'global', workingDir?: string): string {
  if (scope === 'local' && workingDir) {
    return path.join(workingDir, '.codex', 'skills');
  }

  return path.join(os.homedir(), '.codex', 'skills');
}

function generateSlug(skill: SkillDetail): string {
  const baseName = skill.name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return baseName || skill.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function createSkillMetadata(skill: SkillDetail): string {
  const slug = generateSlug(skill);
  const description = skill.description || skill.name;

  return dedent`
    ---
    name: ${slug}
    description: ${description}
    ---
  `;
}

function createSkillContent(skill: SkillDetail): string {
  const metadata = createSkillMetadata(skill);
  const content = skill.content || `# ${skill.name}\n\n${skill.description || ''}`;

  return dedent`
    ${metadata}

    ${content}
  `;
}

export async function registerCodexSkill(
  skill: SkillDetail,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<string> {
  const slug = generateSlug(skill);
  const skillDir = path.join(getSkillsDir(scope, workingDir), slug);
  const skillFile = path.join(skillDir, 'SKILL.md');

  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, createSkillContent(skill), 'utf-8');

  logger.debug('Registered Codex skill', { slug, skillFile });
  return slug;
}

export async function unregisterCodexSkill(
  slug: string,
  scope: 'global' | 'local' = 'global',
  workingDir?: string
): Promise<void> {
  const skillDir = path.join(getSkillsDir(scope, workingDir), slug);

  await fs.rm(skillDir, { recursive: true, force: true });
  logger.debug('Unregistered Codex skill', { slug, skillDir });
}
