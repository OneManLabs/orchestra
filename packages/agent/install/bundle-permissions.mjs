import { chmod, lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const NATIVE_EXECUTABLE_MAGICS = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0x4d, 0x5a]), // PE/COFF
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]), // Mach-O 32-bit
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), // Mach-O 64-bit
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O universal
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbf]),
  Buffer.from([0xbf, 0xba, 0xfe, 0xca]),
];

/**
 * npm package archives do not reliably retain executable mode bits for native
 * helper programs. Normalize a completed portable bundle after dependency
 * installation so executables remain runnable after later installer copies.
 */
export async function normalizePortableBundlePermissions(root, platform = process.platform) {
  if (platform === 'win32') return;
  const information = await lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`Runtime bundle root must be a regular directory: ${root}`);
  const resolvedRoot = await realpath(root);
  await normalizeEntry(resolvedRoot, resolvedRoot);
}

async function normalizeEntry(root, entry) {
  const information = await lstat(entry);
  if (information.isSymbolicLink()) {
    const target = await realpath(entry);
    if (!isWithin(root, target)) throw new Error(`Runtime bundle contains a symlink outside the bundle: ${entry}`);
    return;
  }
  if (information.isDirectory()) {
    const mode = ((information.mode & 0o777) | 0o700) & ~0o022;
    await chmod(entry, mode);
    for (const child of await readdir(entry)) await normalizeEntry(root, path.join(entry, child));
    return;
  }
  if (!information.isFile()) throw new Error(`Runtime bundle contains an unsupported filesystem entry: ${entry}`);

  const executable = (information.mode & 0o111) !== 0
    || path.basename(entry) === 'spawn-helper'
    || await hasExecutableSignature(entry);
  let mode = ((information.mode & 0o777) | 0o600) & ~0o022;
  if (executable) {
    mode |= 0o100;
    if ((mode & 0o040) !== 0) mode |= 0o010;
    if ((mode & 0o004) !== 0) mode |= 0o001;
  }
  await chmod(entry, mode);
  if (path.basename(entry) === 'spawn-helper' && (mode & 0o111) === 0) throw new Error(`Native terminal helper is not executable: ${entry}`);
}

async function hasExecutableSignature(file) {
  const handle = await open(file, 'r');
  try {
    const prefix = Buffer.alloc(8);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const content = prefix.subarray(0, bytesRead);
    if (content.length >= 2 && content[0] === 0x23 && content[1] === 0x21) return true;
    return NATIVE_EXECUTABLE_MAGICS.some((magic) => content.length >= magic.length && content.subarray(0, magic.length).equals(magic));
  } finally {
    await handle.close();
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
