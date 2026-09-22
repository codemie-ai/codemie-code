import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodeMieClient } from 'codemie-sdk';

export interface UploadedWorkflowFile {
  fileName: string;
  fileUrl: string;
}

export async function uploadWorkflowFile(
  client: CodeMieClient,
  filePath: string,
): Promise<UploadedWorkflowFile> {
  const absolutePath = path.resolve(filePath);
  const fileName = path.basename(filePath);
  const content = await fs.readFile(absolutePath);
  const response = await client.files.upload({
    name: fileName,
    content,
    mimeType: 'application/octet-stream',
  });

  return {
    fileName,
    fileUrl: response.file_url,
  };
}
