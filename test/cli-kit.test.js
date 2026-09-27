/**
 * The CLI's side of the shared cli-kit integration.
 *
 * The kit itself is tested where it lives; this file checks that src/cli.js
 * actually uses it: a typo gets a suggestion, a missing value is reported
 * instead of read as `undefined`, a usage error exits 2 while a failed
 * operation exits 1, and no usage error ever prints a stack frame.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { OPTION_NAMES, run } from '../src/cli.js';

const cleanups = [];
after(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTree(tree) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sumcheck-kit-'));
  cleanups.push(root);
  for (const [relative, content] of Object.entries(tree)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

/** Capture stdout and stderr while running the CLI in-process. */
async function runCli(argv, env = {}) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const STACK_FRAME = /at .*\(.*:\d+:\d+\)/;

test('a mistyped option exits 2 and names the closest real option', async () => {
  const result = await runCli(['generate', '.', '--manifst', 'm.json']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /unknown option --manifst/);
  assert.match(result.stderr, /did you mean --manifest\?/);
  assert.ok(OPTION_NAMES.includes('manifest'), 'the suggestion must name a real option');
});

test('an option that needs a value says so instead of reading undefined', async () => {
  for (const argv of [
    ['generate', '.', '-m'],
    ['generate', '.', '--algorithm'],
    ['verify', '.', '--exclude'],
  ]) {
    const result = await runCli(argv);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /needs a value/);
    assert.match(result.stderr, /for example --\w[\w-]* <value>/);
  }
});

test('an unknown command exits 2', async () => {
  const result = await runCli(['frobnicate']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /unknown command: frobnicate/);
  assert.match(result.stderr, /generate, verify and merge/);
});

test('a failed operation exits 1, which is not the usage code', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const missing = await runCli(['verify', root, '-m', path.join(root, 'does-not-exist.json')]);
  assert.equal(missing.code, 1, missing.stderr);
  assert.match(missing.stderr, /cannot read/);

  // A manifest that exists but cannot be parsed is an operation failure too:
  // the command was well formed, the input was not.
  const broken = path.join(root, 'broken.json');
  await fs.writeFile(broken, '{ not json');
  const unreadable = await runCli(['verify', root, '-m', broken]);
  assert.equal(unreadable.code, 1, unreadable.stderr);
  assert.match(unreadable.stderr, /not valid JSON/);
});

test('no usage error output contains a stack frame', async () => {
  const results = [
    await runCli(['generate', '.', '--nonsense']),
    await runCli(['generate', '.', '--manifst', 'm.json']),
    await runCli(['generate', '.', '-m']),
    await runCli(['frobnicate']),
    await runCli(['merge', 'only-one.json']),
  ];
  for (const result of results) {
    assert.equal(result.code, 2, result.stderr);
    assert.equal(STACK_FRAME.test(result.stderr), false, `a stack frame leaked: ${result.stderr}`);
  }
});

test('--debug makes the stack trace appear', async () => {
  // `isDebug` reads the real process argv, the way a spawned CLI would see it,
  // so an in-process run has to put the flag there itself.
  process.argv.push('--debug');
  try {
    const result = await runCli(['generate', '.', '--nonsense']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown option --nonsense/);
    assert.match(result.stderr, STACK_FRAME);
  } finally {
    process.argv.pop();
  }
});

test('SUMCHECK_DEBUG=1 turns the stack trace on as well', async () => {
  const result = await runCli(['generate', '.', '--nonsense'], { SUMCHECK_DEBUG: '1' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, STACK_FRAME);
});

test('the bin entry installs the handlers, which the module alone cannot do', async () => {
  // The bug this pins down: importing `run` makes src/cli.js's direct-run check
  // false, so handlers installed only there never fire for the installed
  // `sumcheck` command. A subprocess is the only way to see it: the probe
  // imports `bin/sumcheck.js` exactly the way a command on PATH does, then
  // reports what the entry point left behind on `process`. Undo the
  // `installHandlers()` call in the bin and this fails with sigint=0 pipe=0.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sumcheck-kit-'));
  try {
    const bin = new URL('../bin/sumcheck.js', import.meta.url).href;
    const probe = path.join(dir, 'probe.mjs');
    await fs.writeFile(
      probe,
      `await import(${JSON.stringify(bin)});\n` +
        "process.stdout.write(`sigint=${process.listenerCount('SIGINT')} pipe=${process.stdout.listenerCount('error')}\\n`);\n",
    );

    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sumcheck - checksum a directory, then verify it later/, 'the bin did not run the CLI');
    assert.match(result.stdout, /sigint=1 pipe=1/, 'the bin entry installed no handlers');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
