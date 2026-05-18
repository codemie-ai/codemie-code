import { readFile } from "node:fs/promises";
import { basename, normalize } from "node:path";
import { lookup } from "mime-types";
import type { File } from "codemie-sdk";
import { PathSecurityError } from "@/utils/errors.js";

/**
 * Read files from local paths and convert to SDK File format
 * @param filePaths Array of local file paths
 * @returns Array of File objects with content and metadata
 */
export async function readFilesFromPaths(
  filePaths: string[],
): Promise<File[]> {
  return Promise.all(
    filePaths.map(async (filePath) => {
      if (normalize(filePath).includes("..")) {
        throw new PathSecurityError(filePath, "path traversal not allowed");
      }
      const content = await readFile(filePath);
      const name = basename(filePath);
      const mime_type = lookup(filePath) || "application/octet-stream";
      return { name, content, mime_type };
    }),
  );
}
