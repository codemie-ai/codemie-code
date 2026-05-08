import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'artifacts', 'install');

const files = [
  ['install/windows/install.ps1', 'install.ps1'],
  ['install/windows/install.cmd', 'install.cmd'],
  ['install/macos/install.sh', 'install.sh']
];

// Checksums intentionally cover the generated artifacts, including version headers.
// They are for release artifact verification, not source-file verification.

await mkdir(outDir, { recursive: true });

const checksums = [];

for (const [source, target] of files) {
  const sourcePath = path.join(root, source);
  const targetPath = path.join(outDir, target);
  await copyFile(sourcePath, targetPath);

  const originalContent = await readFile(targetPath, 'utf8');
  const content = addArtifactHeader(target, originalContent, packageJson);
  await writeFile(targetPath, content, 'utf8');

  const sha256 = createHash('sha256').update(content).digest('hex');
  checksums.push(`${sha256}  ${target}`);
}

const manifest = {
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  generatedAt: new Date().toISOString(),
  artifacts: checksums.map((line) => {
    const [sha256, fileName] = line.split(/\s+/);
    return { fileName, sha256 };
  })
};

await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(path.join(outDir, 'checksums.txt'), `${checksums.join('\n')}\n`, 'utf8');

console.log(`Prepared installer artifacts for ${packageJson.name}@${packageJson.version}`);
console.log(`Output: ${path.relative(root, outDir)}`);

function addArtifactHeader(fileName, content, packageJson) {
  const versionLine = `CodeMie installer artifact for ${packageJson.name}@${packageJson.version}`;

  if (fileName.endsWith('.cmd')) {
    return `rem ${versionLine}\r\n${content}`;
  }

  if (fileName.endsWith('.sh') && content.startsWith('#!')) {
    const firstNewline = content.indexOf('\n');
    if (firstNewline !== -1) {
      return `${content.slice(0, firstNewline + 1)}# ${versionLine}\n${content.slice(firstNewline + 1)}`;
    }
  }

  return `# ${versionLine}\n${content}`;
}
