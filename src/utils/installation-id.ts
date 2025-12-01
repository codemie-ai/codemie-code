/**
 * Installation ID generator and manager
 * Generates a persistent unique identifier for this CodeMie installation
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const INSTALLATION_ID_PATH = join(homedir(), '.codemie', 'installation-id');

/**
 * Get or create installation ID
 * Returns a persistent UUID that uniquely identifies this CodeMie installation
 */
export async function getInstallationId(): Promise<string> {
  try {
    // Try to read existing ID
    const id = await readFile(INSTALLATION_ID_PATH, 'utf-8');
    return id.trim();
  } catch {
    // Generate new ID if file doesn't exist
    const id = randomUUID();

    // Ensure directory exists
    await mkdir(join(homedir(), '.codemie'), { recursive: true });

    // Save for future use
    await writeFile(INSTALLATION_ID_PATH, id, 'utf-8');

    return id;
  }
}
