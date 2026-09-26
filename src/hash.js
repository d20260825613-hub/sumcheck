/**
 * Hashing and walking. Standard library only.
 *
 * Files are hashed as a stream, so a 20 GB file costs a few megabytes of memory
 * rather than twenty gigabytes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ALGORITHMS, isAlgorithm, toPosix } from './manifest.js';

/** Directories that are never worth hashing and are expensive to walk. */
export const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.svn', '.hg', '__pycache__', '.venv'];

/** Hash one file, streaming it. Always rejects rather than throwing. */
export async function hashFile(filePath, algorithm = 'sha256') {
  if (!isAlgorithm(algorithm)) throw new Error(`unsupported algorithm: ${algorithm}`);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Hash many files with a bounded number of concurrent reads.
 *
 * @param {Array<{absolute: string, path: string, size: number, mtimeMs: number}>} files
 * @param {object} [options]
 * @param {string} [options.algorithm]
 * @param {number} [options.concurrency]
 * @param {(progress: {done: number, total: number, bytes: number}) => void} [options.onProgress]
 * @returns {Promise<Array<{path: string, hash: string, size: number, mtimeMs: number}>>}
 */
export async function hashAll(files, options = {}) {
  const { algorithm = 'sha256', concurrency = 4, onProgress = null } = options;
  const results = new Array(files.length);
  let cursor = 0;
  let done = 0;
  let bytes = 0;

  const runner = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= files.length) return;
      const file = files[index];
      const hash = await hashFile(file.absolute, algorithm);
      results[index] = { path: file.path, hash, size: file.size, mtimeMs: file.mtimeMs };
      done += 1;
      bytes += file.size;
      onProgress?.({ done, total: files.length, bytes });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, runner));
  return results;
}

/**
 * Walk a directory and describe every regular file.
 *
 * Caller-supplied excludes are added to the defaults rather than replacing
 * them: `--exclude foo` should mean "also skip foo", not "stop skipping
 * node_modules". Pass `exclude: []` to walk everything.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {string[]} [options.exclude] additional directory names to skip
 * @param {boolean} [options.ignoreDefaults] walk even the default excludes
 * @param {(file: object) => boolean} [options.filter]
 * @param {(progress: {files: number, bytes: number}) => void} [options.onProgress]
 */
export async function collectFiles(root, options = {}) {
  const { exclude = [], ignoreDefaults = false, filter = null, onProgress = null } = options;
  const absoluteRoot = path.resolve(root);
  const excluded = new Set(ignoreDefaults ? exclude : [...DEFAULT_EXCLUDES, ...exclude]);
  const files = [];
  let bytes = 0;
  const queue = [{ dir: absoluteRoot, relative: '' }];
  while (queue.length > 0) {
    const { dir, relative } = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw Object.assign(new Error(`cannot read ${relative || '.'}: ${error.message}`), { code: error.code });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        queue.push({ dir: childAbsolute, relative: childRelative });
      } else if (entry.isFile()) {
        const stat = await fsp.lstat(childAbsolute);
        const file = {
          path: toPosix(childRelative),
          absolute: childAbsolute,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        if (filter && !filter(file)) continue;
        files.push(file);
        bytes += stat.size;
        onProgress?.({ files: files.length, bytes });
      }
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: absoluteRoot, files, totalBytes: bytes };
}

/** Parse a `--exclude` value: repeatable and comma separated both work. */
export function parseExcludes(values) {
  const out = [];
  for (const value of values ?? []) {
    for (const part of String(value).split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

export { ALGORITHMS };
