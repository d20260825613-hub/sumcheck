import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { run } from '../src/cli.js';

const cleanups = [];
after(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTree(tree) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sumcheck-cli-'));
  cleanups.push(root);
  for (const [relative, content] of Object.entries(tree)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

/** Capture stdout and stderr while running the CLI in-process. */
async function runCli(argv) {
  const out = [];
  const err = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    const code = await run(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('--help and --version work and document the exit codes', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /sumcheck - checksum a directory/);
  assert.match(help.stdout, /Exit codes/);
  assert.match(help.stdout, /sha256sum -c SHA256SUMS/);

  const version = await runCli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('generate then verify round trips through the text format', async () => {
  const root = await makeTree({ 'a.txt': 'alpha', 'sub/b.txt': 'beta' });
  const manifest = path.join(root, 'SHA256SUMS');

  const generated = await runCli(['generate', root, '-m', manifest, '--text']);
  assert.equal(generated.code, 0, generated.stderr);
  assert.match(generated.stdout, /2 files/);

  const content = await fs.readFile(manifest, 'utf8');
  assert.match(content, /^# sumcheck sha256 manifest/);
  assert.match(content, /  a\.txt$/m, 'the text format must be sha256sum shaped');

  const verified = await runCli(['verify', root, '-m', manifest, '-q']);
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /all files match/);
});

test('generate refuses to overwrite an existing manifest without --force', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const manifest = path.join(root, 'm.json');
  await fs.writeFile(manifest, 'existing');

  const blocked = await runCli(['generate', root, '-m', manifest]);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stderr, /already exists/);
  assert.equal(await fs.readFile(manifest, 'utf8'), 'existing');

  const forced = await runCli(['generate', root, '-m', manifest, '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(await fs.readFile(manifest, 'utf8'), /"tool": "sumcheck"/);
});

test('verify exits 1 for a changed file and 2 for extra content', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const manifest = path.join(root, 'm.json');
  await runCli(['generate', root, '-m', manifest]);

  await fs.writeFile(path.join(root, 'a.txt'), 'tampered');
  const changed = await runCli(['verify', root, '-m', manifest]);
  assert.equal(changed.code, 1, changed.stdout);
  assert.match(changed.stdout, /changed/);
  assert.match(changed.stdout, /does not match/);

  await runCli(['generate', root, '-m', manifest, '--force']);
  await fs.writeFile(path.join(root, 'extra.txt'), 'new');
  const extra = await runCli(['verify', root, '-m', manifest]);
  assert.equal(extra.code, 2);
  assert.match(extra.stdout, /extra/);
  assert.match(extra.stdout, /extra content/);
});

test('verify --json reports machine-readable results', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const manifest = path.join(root, 'm.json');
  await runCli(['generate', root, '-m', manifest]);
  const result = await runCli(['verify', root, '-m', manifest, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.ok, 1);
  assert.equal(report.algorithm, 'sha256');
  assert.equal(report.results[0].path, 'a.txt');
});

test('a bare sha256sum manifest verifies when the algorithm is given', async () => {
  const root = await makeTree({ 'a.txt': 'alpha' });
  const manifest = path.join(root, 'SHA256SUMS');
  await runCli(['generate', root, '-m', manifest, '--text']);
  // Strip the sumcheck header, leaving what GNU coreutils would write.
  const lines = (await fs.readFile(manifest, 'utf8')).split('\n').filter((l) => l && !l.startsWith('#'));
  await fs.writeFile(manifest, `${lines.join('\n')}\n`);

  const result = await runCli(['verify', root, '-m', manifest, '--algorithm', 'sha256', '-q']);
  assert.equal(result.code, 0, result.stderr);
});

test('bad arguments are refused with a clear message', async () => {
  assert.equal((await runCli(['frobnicate'])).code, 3);
  assert.match((await runCli(['generate', '.', '-a', 'crc32'])).stderr, /unknown algorithm/);
  assert.match((await runCli(['verify', '.', '-m', 'does-not-exist.json'])).stderr, /cannot read/);
  assert.match((await runCli(['generate', '.', '--nonsense'])).stderr, /unknown option/);
  assert.match((await runCli(['merge', 'only-one.json'])).stderr, /at least two manifests/);
});

test('merge combines manifests and refuses conflicting hashes', async () => {
  const left = await makeTree({ 'a.txt': 'alpha' });
  const right = await makeTree({ 'b.txt': 'beta' });
  const m1 = path.join(left, 'm1.json');
  const m2 = path.join(right, 'm2.json');
  const out = path.join(left, 'merged.json');
  await runCli(['generate', left, '-m', m1]);
  await runCli(['generate', right, '-m', m2]);

  const merged = await runCli(['merge', m1, m2, '-m', out]);
  assert.equal(merged.code, 0, merged.stderr);
  const parsed = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.deepEqual(
    parsed.files.map((f) => f.path).sort(),
    ['a.txt', 'b.txt'],
  );

  // The same path with a different hash must not be silently resolved.
  const clash = await makeTree({ 'a.txt': 'different content' });
  const m3 = path.join(clash, 'm3.json');
  await runCli(['generate', clash, '-m', m3]);
  const conflict = await runCli(['merge', m1, m3, '-m', path.join(left, 'nope.json')]);
  assert.equal(conflict.code, 3);
  assert.match(conflict.stderr, /conflict/);
});

test('an excluded directory is neither hashed nor reported as extra', async () => {
  const root = await makeTree({ 'a.txt': 'a', 'node_modules/pkg/index.js': 'noise' });
  const manifest = path.join(root, 'm.json');
  await runCli(['generate', root, '-m', manifest]);
  const report = JSON.parse((await runCli(['verify', root, '-m', manifest, '--json'])).stdout);
  assert.equal(report.summary.extra, 0, 'node_modules must be excluded from both sides');
  assert.equal(report.summary.ok, 1);
});
