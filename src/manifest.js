/**
 * Checksum manifests.
 *
 * Two formats on purpose:
 *
 *   text  - the same shape `sha256sum` writes, so a manifest produced here can
 *           be checked by the system tool and vice versa. One line per file:
 *           `<hex>  <path>`
 *   json  - adds size, mtime and the algorithm, so verification can tell
 *           "changed" from "missing" from "same content, different timestamp"
 *
 * Paths in text format are written with forward slashes and read back the same
 * way, which is what makes a manifest portable between Windows and Linux. This
 * is also the format's weak point: a path containing a literal newline cannot be
 * represented, so such files are skipped with a warning rather than written
 * incorrectly.
 */

import path from 'node:path';

export const ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'];
export const DEFAULT_ALGORITHM = 'sha256';

export const FORMAT_TEXT = 'text';
export const FORMAT_JSON = 'json';

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Normalise to forward slashes; the report format never depends on the OS. */
export function toPosix(p) {
  return String(p).split('\\').join('/');
}

export function isAlgorithm(name) {
  return ALGORITHMS.includes(String(name).toLowerCase());
}

/**
 * One line of the text format.
 * @param {{hash: string, path: string}} entry
 */
export function formatTextEntry(entry) {
  if (/[\r\n]/.test(entry.path)) {
    throw new ManifestError(`path contains a newline and cannot be written: ${JSON.stringify(entry.path)}`);
  }
  // Two spaces is what sha256sum uses; the second is the "text mode" marker in
  // some implementations, so a single space is what a portable reader expects.
  return `${entry.hash}  ${toPosix(entry.path)}`;
}

/**
 * Parse a text manifest. Tolerates CRLF, blank lines, comments and the `*`
 * binary marker that GNU coreutils writes.
 *
 * @param {string} text
 * @returns {Array<{hash: string, path: string, line: number}>}
 */
export function parseTextManifest(text) {
  const entries = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw || raw.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]+)\s+[* ]?(.*)$/.exec(raw);
    if (!match) {
      throw new ManifestError(`line ${i + 1} is not a checksum line: ${JSON.stringify(raw.slice(0, 60))}`);
    }
    const [, hash, file] = match;
    if (!file) throw new ManifestError(`line ${i + 1} has a checksum but no path`);
    entries.push({ hash: hash.toLowerCase(), path: file, line: i + 1 });
  }
  return entries;
}

/**
 * @param {object} options
 * @param {string} options.root directory the paths are relative to
 * @param {Array<{path: string, hash: string, size: number, mtimeMs: number}>} options.entries
 * @param {string} options.algorithm
 * @param {string} [options.format]
 * @param {string} [options.createdAt]
 */
export function buildManifest({ root, entries, algorithm, format = FORMAT_JSON, createdAt = new Date().toISOString() }) {
  if (!isAlgorithm(algorithm)) throw new ManifestError(`unsupported algorithm: ${algorithm}`);
  if (format === FORMAT_TEXT) {
    const header = `# sumcheck ${algorithm} manifest\n# ${entries.length} file(s)\n`;
    return `${header}${entries.map((entry) => formatTextEntry(entry)).join('\n')}\n`;
  }
  return `${JSON.stringify(
    {
      tool: 'sumcheck',
      version: 1,
      algorithm,
      createdAt,
      root: toPosix(root),
      files: entries
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((entry) => ({
          path: toPosix(entry.path),
          hash: entry.hash,
          size: entry.size,
          mtime: new Date(entry.mtimeMs).toISOString(),
        })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Read either format. The format is detected from the content, not the file
 * name, so a manifest works whatever it is called.
 *
 * @param {string} text
 * @returns {{format: string, algorithm: string|null, root: string|null, entries: Array<{path: string, hash: string, size: number|null, mtimeMs: number|null}>, createdAt: string|null}}
 */
export function parseManifest(text) {
  const trimmed = String(text).trimStart();
  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new ManifestError(`the manifest is not valid JSON: ${error.message}`);
    }
    if (parsed.version !== 1) throw new ManifestError(`unsupported manifest version: ${parsed.version}`);
    if (!isAlgorithm(parsed.algorithm)) throw new ManifestError(`unsupported algorithm: ${parsed.algorithm}`);
    if (!Array.isArray(parsed.files)) throw new ManifestError('the manifest has no files array');
    return {
      format: FORMAT_JSON,
      algorithm: parsed.algorithm,
      root: parsed.root ?? null,
      createdAt: parsed.createdAt ?? null,
      entries: parsed.files.map((file, index) => {
        if (typeof file.path !== 'string' || typeof file.hash !== 'string') {
          throw new ManifestError(`files[${index}] needs a path and a hash`);
        }
        return {
          path: toPosix(file.path),
          hash: file.hash.toLowerCase(),
          size: Number.isSafeInteger(file.size) ? file.size : null,
          mtimeMs: file.mtime ? Date.parse(file.mtime) : null,
        };
      }),
    };
  }

  const entries = parseTextManifest(text);
  const header = /^#\s*sumcheck\s+(\w+)\s+manifest/m.exec(text);
  return {
    format: FORMAT_TEXT,
    algorithm: header ? header[1].toLowerCase() : null,
    root: null,
    createdAt: null,
    entries: entries.map((entry) => ({ path: entry.path, hash: entry.hash, size: null, mtimeMs: null })),
  };
}

/** Resolve a manifest path against a root directory, rejecting escapes. */
export function resolveWithin(root, relative) {
  const absolute = path.resolve(root, relative);
  const base = path.resolve(root);
  const rel = path.relative(base, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ManifestError(`manifest path escapes the root: ${relative}`);
  }
  return absolute;
}
