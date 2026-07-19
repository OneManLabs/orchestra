#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [stagingArgument, outputArgument] = process.argv.slice(2);
if (!stagingArgument || !outputArgument) {
  process.stderr.write('Usage: node generate-wix-fragment.mjs <staging-directory> <output.wxs>\n');
  process.exit(2);
}

const staging = path.resolve(stagingArgument);
const output = path.resolve(outputArgument);
const excluded = new Set(['FleetCanvasAgentService.exe', 'FleetCanvasAgentService.xml']);
const tree = await scan(staging, '');
const componentIds = [];

const directoryXml = renderDirectoryContents(tree, '    ');
const refs = componentIds.map((id) => `      <ComponentRef Id="${id}" />`).join('\n');
const document = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="INSTALLFOLDER">
${directoryXml}
    </DirectoryRef>
  </Fragment>
  <Fragment>
    <ComponentGroup Id="RuntimeComponents">
${refs}
    </ComponentGroup>
  </Fragment>
</Wix>
`;
await writeFile(output, document);

async function scan(root, relative) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const directories = [];
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`MSI staging must not contain symbolic links: ${child}`);
    if (entry.isDirectory()) directories.push({ name: entry.name, relative: child, tree: await scan(root, child) });
    else if (entry.isFile() && !excluded.has(child.replaceAll(path.sep, '/'))) files.push({ name: entry.name, relative: child });
    else if (!entry.isFile()) throw new Error(`Unsupported MSI staging entry: ${child}`);
  }
  return { directories, files };
}

function renderDirectoryContents(node, indent) {
  const lines = [];
  for (const file of node.files) lines.push(renderFile(file, indent));
  for (const directory of node.directories) {
    const id = stableId('Directory', directory.relative);
    lines.push(`${indent}<Directory Id="${id}" Name="${xml(directory.name)}">`);
    lines.push(renderDirectoryContents(directory.tree, `${indent}  `));
    lines.push(`${indent}</Directory>`);
  }
  return lines.filter(Boolean).join('\n');
}

function renderFile(file, indent) {
  const componentId = stableId('Component', file.relative);
  const fileId = stableId('File', file.relative);
  componentIds.push(componentId);
  const source = `$(var.StagingDir)\\${file.relative.split(path.sep).join('\\')}`;
  return `${indent}<Component Id="${componentId}" Guid="*"><File Id="${fileId}" Source="${xml(source)}" KeyPath="yes" /></Component>`;
}

function stableId(prefix, value) {
  const base = value.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^[^A-Za-z_]/, '_').slice(-40);
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${prefix}_${base}_${hash}`;
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
