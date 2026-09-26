/**
 * Verification: compare what a manifest says against what is on disk.
 *
 * The point of this module is the distinction it draws. A file can be:
 *
 *   ok        the content matches
 *   changed   the file is there but the content differs
 *   missing   the manifest lists it and it is not on disk
 *   extra     it is on disk and the manifest does not list it
 *   touched   the content matches but the size or timestamp moved
 *
 * "touched" is the one people ask about. A file that was re-copied or restored
 * from a backup has identical content and a new timestamp; calling that
 * "changed" would be wrong, and calling it "ok" would hide the fact that
 * something happened to it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { hashFile } from './hash.js';
import { parseManifest, resolveWithin } from './manifest.js';

export const STATUS = {
  OK: 'ok',
  TOUCHED: 'touched',
  CHANGED: 'changed',
  MISSING: 'missing',
  EXTRA: 'extra',
};

/**
 * @param {object} options
 * @param {string} options.root directory the manifest paths are relative to
 * @param {string} options.manifestText
 * @param {string|null} [options.algorithmOverride]
 * @param {boolean} [options.reportExtra]
 * @param {Array<{path: string, size: number}>} [options.present] files found on disk
 * @param {(progress: {done: number, total: number}) => void} [options.onProgress]
 */
export async function verifyManifest({
  root,
  manifestText,
  algorithmOverride = null,
  reportExtra = true,
  present = [],
  onProgress = null,
}) {
  const manifest = parseManifest(manifestText);
  const algorithm = algorithmOverride ?? manifest.algorithm;
  if (!algorithm) {
    throw new Error('the manifest does not name an algorithm; pass --algorithm to say which one to use');
  }

  const results = [];
  let done = 0;

  for (const entry of manifest.entries) {
    let absolute;
    try {
      absolute = resolveWithin(root, entry.path);
    } catch (error) {
      results.push({ path: entry.path, status: STATUS.MISSING, expected: entry.hash, actual: null, note: error.message });
      continue;
    }

    let stat;
    try {
      stat = await fsp.stat(absolute);
    } catch {
      results.push({ path: entry.path, status: STATUS.MISSING, expected: entry.hash, actual: null, size: entry.size });
      done += 1;
      onProgress?.({ done, total: manifest.entries.length });
      continue;
    }

    let actual;
    try {
      actual = await hashFile(absolute, algorithm);
    } catch (error) {
      results.push({ path: entry.path, status: STATUS.CHANGED, expected: entry.hash, actual: null, note: error.message });
      done += 1;
      onProgress?.({ done, total: manifest.entries.length });
      continue;
    }

    let status = actual === entry.hash ? STATUS.OK : STATUS.CHANGED;
    if (status === STATUS.OK) {
      const sizeMoved = entry.size !== null && entry.size !== stat.size;
      const timeMoved =
        entry.mtimeMs !== null && Number.isFinite(entry.mtimeMs) && Math.abs(entry.mtimeMs - stat.mtimeMs) > 1000;
      if (sizeMoved || timeMoved) status = STATUS.TOUCHED;
    }

    results.push({
      path: entry.path,
      status,
      expected: entry.hash,
      actual,
      size: stat.size,
      expectedSize: entry.size,
      note: null,
    });
    done += 1;
    onProgress?.({ done, total: manifest.entries.length });
  }

  let extras = [];
  if (reportExtra && present.length > 0) {
    const known = new Set(manifest.entries.map((entry) => entry.path));
    extras = present.filter((file) => !known.has(file.path)).map((file) => ({ path: file.path, size: file.size }));
  }

  const summary = {
    ok: results.filter((r) => r.status === STATUS.OK).length,
    touched: results.filter((r) => r.status === STATUS.TOUCHED).length,
    changed: results.filter((r) => r.status === STATUS.CHANGED).length,
    missing: results.filter((r) => r.status === STATUS.MISSING).length,
    extra: extras.length,
    total: results.length,
  };

  return { algorithm, format: manifest.format, results, extras, summary, manifest };
}

/** Exit code that says "the tree does not match" without hiding why. */
export function exitCodeFor(summary) {
  if (summary.changed > 0 || summary.missing > 0) return 1;
  if (summary.extra > 0) return 2;
  return 0;
}
