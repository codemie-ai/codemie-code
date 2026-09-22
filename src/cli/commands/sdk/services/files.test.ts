import type { CodeMieClient } from 'codemie-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { uploadWorkflowFile } from './files.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

describe('uploadWorkflowFile', () => {
  beforeEach(() => {
    vi.mocked(fs.readFile).mockReset();
  });

  it('uploads the selected file and returns its URL', async () => {
    const content = Buffer.from('workflow input');
    vi.mocked(fs.readFile).mockResolvedValue(content);
    const upload = vi.fn().mockResolvedValue({ file_url: 'https://files.example/input.txt' });
    const client = {
      files: { upload },
    } as unknown as CodeMieClient;

    await expect(uploadWorkflowFile(client, './fixtures/input.txt')).resolves.toEqual({
      fileName: 'input.txt',
      fileUrl: 'https://files.example/input.txt',
    });
    expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('fixtures'));
    expect(upload).toHaveBeenCalledWith({
      name: 'input.txt',
      content,
      mimeType: 'application/octet-stream',
    });
  });
});
