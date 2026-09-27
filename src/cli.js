#!/usr/bin/env node
/**
 * sumcheck - checksum a directory, then verify it later.
 *
 *   sumcheck generate [dir]     write a manifest of every file
 *   sumcheck verify [dir]       check the tree against a manifest
 *   sumcheck merge <manifests>  combine manifests into one
 *
 * The text manifest format is the one `sha256sum` writes, so a manifest made
 * here can be checked with the system tool and the other way round.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { UsageError, formatError, installCliHandlers, unknownOptionError } from './cli-kit.js';
import { collectFiles, hashAll, parseExcludes } from './hash.js';
import {
  ALGORITHMS,
  DEFAULT_ALGORITHM,
  FORMAT_JSON,
  FORMAT_TEXT,
  buildManifest,
  parseManifest,
} from './manifest.js';
import { STATUS, exitCodeFor, verifyManifest } from './verify.js';
import { bold, dim, formatBytes, green, red, yellow } from './style.js';

const VERSION = '0.1.0';
const DEFAULT_MANIFEST = 'sumcheck.json';

const USAGE = `sumcheck - checksum a directory, then verify it later

Usage
  sumcheck generate [dir] [options]     write a manifest
  sumcheck verify [dir] [options]       check a tree against a manifest
  sumcheck merge <manifest...> [options]

Options
  -m, --manifest <file>    manifest to write or read (default ${DEFAULT_MANIFEST})
  -a, --algorithm <name>   ${ALGORITHMS.join(' | ')} (default ${DEFAULT_ALGORITHM})
  -x, --exclude <name>     directory to skip; repeatable, or comma separated
      --text               write the sha256sum-compatible text format
      --json               machine-readable report (verify)
      --no-extra           do not report files that are not in the manifest
      --debug              print a stack trace when something fails
  -f, --force              overwrite an existing manifest
  -q, --quiet              only print the summary
  -h, --help               this text
  -v, --version            version

Exit codes
  0  everything matches
  1  a file changed or is missing, or the operation could not be completed
  2  bad arguments, or the tree has files the manifest does not list

Examples
  sumcheck generate ./backup
  sumcheck verify ./backup
  sumcheck generate . --text -m SHA256SUMS
  sha256sum -c SHA256SUMS
  sumcheck verify . -m SHA256SUMS --algorithm sha256
`;

/**
 * Every long option this command line accepts, for the "did you mean"
 * suggestion. Kept next to the parser so the two cannot drift apart unnoticed.
 */
export const OPTION_NAMES = [
  'manifest',
  'algorithm',
  'exclude',
  'text',
  'json',
  'no-extra',
  'force',
  'quiet',
  'debug',
  'help',
  'version',
];

/**
 * Report a problem and return the exit code.
 *
 * 2 is "you asked for something impossible" and 1 is "the operation failed".
 * Keeping the two apart is the only way a script can tell a typo from a tree
 * that no longer matches, and mixing them is how a caller ends up retrying
 * something that can never work.
 */
function fail(message, code = 1) {
  process.stderr.write(`sumcheck: ${message}\n`);
  return code;
}

/** Shorthand for the argument-shaped failures. */
function failUsageMessage(message) {
  return fail(message, 2);
}

/** Print a usage error the same way everywhere: message, hint, then nothing. */
function failUsage(error) {
  process.stderr.write(formatError(error, { tool: 'sumcheck', usage: () => USAGE, debug: isDebug() }));
  return error.code ?? 2;
}

/** `--debug` anywhere in argv turns stack traces on. Read lazily, not cached. */
function isDebug() {
  return process.argv.includes('--debug') || process.env.SUMCHECK_DEBUG === '1';
}

function parseArgs(argv, spec = {}) {
  const values = { manifest: DEFAULT_MANIFEST, algorithm: DEFAULT_ALGORITHM, exclude: [], ...spec };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const inline = eq > 1 && token.startsWith('--') ? token.slice(eq + 1) : null;
    // An option whose value is the last token must say so, rather than reading
    // `undefined` and failing later somewhere far less obvious.
    const take = (name) => {
      const value = inline !== null ? inline : argv[i + 1];
      if (value === undefined) {
        return { error: new UsageError(`${name} needs a value`, { hint: `for example ${name} <value>` }) };
      }
      if (inline === null) i += 1;
      return { value };
    };
    switch (token.split('=')[0]) {
      case '-m':
      case '--manifest': {
        const taken = take('--manifest');
        if (taken.error) return taken;
        values.manifest = taken.value;
        break;
      }
      case '-a':
      case '--algorithm': {
        const taken = take('--algorithm');
        if (taken.error) return taken;
        values.algorithm = String(taken.value).toLowerCase();
        break;
      }
      case '-x':
      case '--exclude': {
        const taken = take('--exclude');
        if (taken.error) return taken;
        values.exclude.push(taken.value);
        break;
      }
      case '--text':
        values.format = FORMAT_TEXT;
        break;
      case '--json':
        values.json = true;
        break;
      case '--no-extra':
        values.reportExtra = false;
        break;
      case '--debug':
        values.debug = true;
        break;
      case '-f':
      case '--force':
        values.force = true;
        break;
      case '-q':
      case '--quiet':
        values.quiet = true;
        break;
      default:
        if (token === '--') {
          positional.push(...argv.slice(i + 1));
          return { values, positional };
        }
        // A mistyped flag is the most common way to get here, so answer it with
        // the option that was probably meant instead of a bare "unknown option".
        if (token.startsWith('-') && token !== '-') return { error: unknownOptionError(token, OPTION_NAMES) };
        positional.push(token);
    }
  }
  return { values, positional };
}

function progressLine(enabled, label) {
  if (!enabled || !process.stderr.isTTY) return null;
  let last = 0;
  return (progress) => {
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    process.stderr.write(`\r${label} ${progress.done}/${progress.total}   `);
  };
}

async function commandGenerate(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return failUsage(parsed.error);
  const { values, positional } = parsed;
  const root = positional[0] ?? '.';

  if (!ALGORITHMS.includes(values.algorithm)) {
    return failUsage(
      new UsageError(`unknown algorithm: ${values.algorithm}`, {
        hint: `the algorithms are ${ALGORITHMS.join(', ')}`,
      }),
    );
  }

  try {
    await fsp.access(values.manifest);
    if (!values.force) return fail(`${values.manifest} already exists; pass --force to overwrite it`);
  } catch {
    /* does not exist, which is what we want */
  }

  let collected;
  const manifestPath = path.resolve(values.manifest);
  try {
    collected = await collectFiles(root, {
      exclude: [...new Set(parseExcludes(values.exclude))],
      // The manifest is written into the tree it describes often enough that
      // leaving it out is the only sane default: otherwise the first verify
      // reports the manifest itself as unexpected extra content.
      filter: (file) => path.resolve(file.absolute) !== manifestPath,
    });
  } catch (error) {
    return fail(error.message);
  }

  if (collected.files.length === 0) {
    return fail(`no files found under ${root}`);
  }

  const started = Date.now();
  const entries = await hashAll(collected.files, {
    algorithm: values.algorithm,
    onProgress: progressLine(!values.quiet, 'hashing'),
  });
  if (!values.quiet && process.stderr.isTTY) process.stderr.write('\r\u001b[K');

  const text = buildManifest({
    root: collected.root,
    entries,
    algorithm: values.algorithm,
    format: values.format ?? FORMAT_JSON,
  });
  await fsp.mkdir(path.dirname(path.resolve(values.manifest)), { recursive: true });
  await fsp.writeFile(values.manifest, text);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(
    `${bold('wrote')} ${values.manifest}\n` +
      `  ${entries.length} files, ${formatBytes(collected.totalBytes)}, ${values.algorithm}, ${seconds}s\n`,
  );
  return 0;
}

async function commandVerify(argv) {
  const parsed = parseArgs(argv, { reportExtra: true });
  if (parsed.error) return failUsage(parsed.error);
  const { values, positional } = parsed;
  const root = positional[0] ?? '.';

  let manifestText;
  try {
    manifestText = await fsp.readFile(values.manifest, 'utf8');
  } catch {
    return fail(`cannot read ${values.manifest}`);
  }

  if (values.algorithm && !ALGORITHMS.includes(values.algorithm)) {
    return failUsage(
      new UsageError(`unknown algorithm: ${values.algorithm}`, {
        hint: `the algorithms are ${ALGORITHMS.join(', ')}`,
      }),
    );
  }

  // The manifest may not name an algorithm (a bare sha256sum file does not
  // always carry a header), in which case the default is used.
  let declared = null;
  try {
    declared = parseManifest(manifestText).algorithm;
  } catch (error) {
    return fail(error.message);
  }
  const algorithm = declared ?? values.algorithm;

  let present = [];
  const manifestPath = path.resolve(values.manifest);
  try {
    const collected = await collectFiles(root, {
      exclude: [...new Set(parseExcludes(values.exclude))],
      // Never treat the manifest as part of what it describes, on either side.
      filter: (file) => path.resolve(file.absolute) !== manifestPath,
    });
    present = collected.files.map((file) => ({ path: file.path, size: file.size }));
  } catch (error) {
    return fail(error.message);
  }

  let report;
  try {
    report = await verifyManifest({
      root,
      manifestText,
      algorithmOverride: algorithm,
      reportExtra: values.reportExtra,
      present,
      onProgress: progressLine(!values.quiet, 'checking'),
    });
  } catch (error) {
    return fail(error.message);
  }
  if (!values.quiet && process.stderr.isTTY) process.stderr.write('\r\u001b[K');

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeFor(report.summary);
  }

  if (!values.quiet) {
    for (const result of report.results) {
      if (result.status === STATUS.OK) {
        if (values.quiet) continue;
        continue;
      }
      const label =
        result.status === STATUS.CHANGED
          ? red('changed')
          : result.status === STATUS.MISSING
            ? red('missing')
            : yellow('touched');
      process.stdout.write(`${label.padEnd(0)} ${result.path}\n`);
      if (result.status === STATUS.CHANGED) {
        process.stdout.write(`        expected ${result.expected}\n        actual   ${result.actual ?? '(unreadable)'}\n`);
      }
    }
    for (const extra of report.extras) {
      process.stdout.write(`${yellow('extra  ')} ${extra.path}\n`);
    }
  }

  const { summary } = report;
  const verdict =
    summary.changed === 0 && summary.missing === 0 && summary.extra === 0
      ? green('all files match')
      : summary.changed > 0 || summary.missing > 0
        ? red('the tree does not match the manifest')
        : yellow('every listed file matches, but there is extra content');

  process.stdout.write(
    `\n${verdict}\n` +
      `  ${summary.ok} ok, ${summary.touched} touched, ${summary.changed} changed, ${summary.missing} missing` +
      `${summary.extra > 0 ? `, ${summary.extra} extra` : ''}\n` +
      dim(`  ${report.algorithm}, ${summary.total} file(s) listed\n`),
  );
  return exitCodeFor(summary);
}

async function commandMerge(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) return failUsage(parsed.error);
  const { values, positional } = parsed;
  if (positional.length < 2) return failUsageMessage('merge needs at least two manifests');

  const merged = new Map();
  let algorithm = null;
  for (const file of positional) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return fail(`cannot read ${file}`);
    }
    let manifest;
    try {
      manifest = parseManifest(text);
    } catch (error) {
      return fail(`${file}: ${error.message}`);
    }
    algorithm = algorithm ?? manifest.algorithm;
    for (const entry of manifest.entries) {
      const existing = merged.get(entry.path);
      if (existing && existing.hash !== entry.hash) {
        return fail(`conflict: ${entry.path} appears with two different hashes`);
      }
      merged.set(entry.path, entry);
    }
  }

  const entries = [...merged.values()].map((entry) => ({
    path: entry.path,
    hash: entry.hash,
    size: entry.size ?? 0,
    mtimeMs: entry.mtimeMs ?? Date.now(),
  }));
  const text = buildManifest({
    root: '.',
    entries,
    algorithm: algorithm ?? values.algorithm,
    format: values.format ?? FORMAT_JSON,
  });

  if (values.manifest !== DEFAULT_MANIFEST) {
    try {
      await fsp.access(values.manifest);
      if (!values.force) return fail(`${values.manifest} already exists; pass --force to overwrite it`);
    } catch {
      /* fine */
    }
  }
  await fsp.writeFile(values.manifest, text);
  process.stdout.write(`${bold('wrote')} ${values.manifest}\n  ${entries.length} files merged from ${positional.length} manifest(s)\n`);
  return 0;
}

/**
 * Run the CLI and resolve to an exit code.
 *
 * Split out from `dispatch` so tests can drive it in-process without spawning a
 * child, and so every escaping error is reported in one place.
 *
 * A UsageError that reaches here is printed as a message rather than a stack
 * trace, and its own `code` becomes the exit status. That keeps "you typed it
 * wrong" (2) separate from "the operation failed" (1), which a script can act
 * on.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {Promise<number>} exit code
 */
export async function run(argv) {
  try {
    return await dispatch(argv);
  } catch (error) {
    process.stderr.write(formatError(error, { tool: 'sumcheck', usage: () => USAGE, debug: isDebug() }));
    return error instanceof UsageError ? (error.code ?? 2) : 1;
  }
}

async function dispatch(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  switch (command) {
    case 'generate':
    case 'gen':
      return commandGenerate(rest);
    case 'verify':
    case 'check':
      return commandVerify(rest);
    case 'merge':
      return commandMerge(rest);
    default:
      return failUsage(
        new UsageError(`unknown command: ${command}`, {
          hint: 'the commands are generate, verify and merge',
        }),
      );
  }
}

/**
 * Install the process-level handlers.
 *
 * Exported because `bin/sumcheck.js` is the entry point that actually runs when
 * the tool is on PATH, and it imports this module rather than running it, so the
 * direct-run block below never fires there. Both call sites share this one
 * configuration instead of repeating it. Calling it twice is harmless:
 * `installCliHandlers` is idempotent.
 *
 * Without it, `sumcheck verify x | head` prints a node EPIPE stack trace, and
 * Ctrl-C during a long hash reports an exception instead of stopping quietly.
 */
export function installHandlers() {
  return installCliHandlers({ tool: 'sumcheck', usage: () => USAGE, debug: isDebug });
}

// Only run when invoked directly, so importing this module in a test is safe.
// `pathToFileURL` is what makes the check survive a path containing `#` or `%`,
// which hand-building a `file://` string gets wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Installed before anything else runs.
  installHandlers();

  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(formatError(error, { tool: 'sumcheck', usage: () => USAGE, debug: isDebug() }));
      process.exitCode = error instanceof UsageError ? (error.code ?? 2) : 1;
    },
  );
}
