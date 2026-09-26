import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  FORMAT_JSON,
  FORMAT_TEXT,
  ManifestError,
  buildManifest,
  formatTextEntry,
  parseManifest,
  parseTextManifest,
  resolveWithin,
} from '../src/manifest.js';
import { collectFiles, hashAll, hashFile, parseExcludes } from '../src/hash.js';
import { STATUS, exitCodeFor, verifyManifest } from '../src/verify.js';

const cleanups = [];
after(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTree(tree) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sumcheck-'));
  cleanups.push(root);
  for (const [relative, content] of Object.entries(tree)) {
    const target = path.join(root, ...relative.split('/'));
    if (content === null) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

const sha = (text, algorithm = 'sha256') => crypto.createHash(algorithm).update(text).digest('hex');

// --- manifest format ------------------------------------------------------

test('a text entry uses forward slashes and two spaces', () => {
  assert.equal(formatTextEntry({ hash: 'abc', path: 'a\\b\\c.txt' }), 'abc  a/b/c.txt');
});

test('a path containing a newline is refused rather than written wrong', () => {
  assert.throws(() => formatTextEntry({ hash: 'a', path: 'bad\nname' }), ManifestError);
});

test('the text parser accepts the shapes sha256sum and friends produce', () => {
  const entries = parseTextManifest(
    ['# a comment', '', `${sha('a')}  a.txt`, `${sha('b')} *b.bin`, `${sha('c').toUpperCase()}  sub/c.txt`].join('\n'),
  );
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['a.txt', 'b.bin', 'sub/c.txt'],
  );
  assert.equal(entries[2].hash, sha('c'), 'hashes are lowercased');
  assert.equal(entries[0].line, 3);
});

test('a malformed text line is reported with its line number', () => {
  assert.throws(() => parseTextManifest('not a checksum line'), (e) => /line 1/.test(e.message));
});

test('a JSON manifest round trips through build and parse', () => {
  const text = buildManifest({
    root: 'C:\\work\\project',
    algorithm: 'sha256',
    entries: [{ path: 'a.txt', hash: sha('a'), size: 1, mtimeMs: 1700000000000 }],
  });
  const parsed = parseManifest(text);
  assert.equal(parsed.format, FORMAT_JSON);
  assert.equal(parsed.algorithm, 'sha256');
  assert.equal(parsed.root, 'C:/work/project', 'the root is written with forward slashes');
  assert.equal(parsed.entries[0].path, 'a.txt');
  assert.equal(parsed.entries[0].size, 1);
  assert.equal(parsed.entries[0].mtimeMs, 1700000000000);
});

test('a text manifest with a sumcheck header reports its algorithm', () => {
  const text = buildManifest({
    root: '/x',
    algorithm: 'sha512',
    format: FORMAT_TEXT,
    entries: [{ path: 'a', hash: sha('a', 'sha512'), size: 1, mtimeMs: 0 }],
  });
  const parsed = parseManifest(text);
  assert.equal(parsed.format, FORMAT_TEXT);
  assert.equal(parsed.algorithm, 'sha512');
});

test('a bare sha256sum file has no algorithm, which the caller must supply', () => {
  const parsed = parseManifest(`${sha('a')}  a.txt\n`);
  assert.equal(parsed.format, FORMAT_TEXT);
  assert.equal(parsed.algorithm, null);
  assert.equal(parsed.entries.length, 1);
});

test('a JSON manifest with the wrong version or algorithm is rejected', () => {
  assert.throws(() => parseManifest('{"version":9,"algorithm":"sha256","files":[]}'), /unsupported manifest version/);
  assert.throws(() => parseManifest('{"version":1,"algorithm":"crc32","files":[]}'), /unsupported algorithm/);
  assert.throws(() => parseManifest('{"version":1,"algorithm":"sha256"}'), /no files array/);
  assert.throws(() => parseManifest('{ not json'), /not valid JSON/);
});

test('a manifest path cannot escape the root', () => {
  const root = path.join(os.tmpdir(), 'sumcheck-root');
  assert.equal(resolveWithin(root, 'inside.txt'), path.join(root, 'inside.txt'));
  assert.throws(() => resolveWithin(root, '../outside.txt'), /escapes the root/);
  assert.throws(() => resolveWithin(root, 'a/../../outside.txt'), /escapes the root/);
});

// --- hashing --------------------------------------------------------------

test('hashFile matches node crypto for every supported algorithm', async () => {
  const root = await makeTree({ 'a.bin': 'hello world' });
  for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
    assert.equal(await hashFile(path.join(root, 'a.bin'), algorithm), sha('hello world', algorithm));
  }
});

test('hashFile rejects an unsupported algorithm instead of guessing', async () => {
  const root = await makeTree({ 'a.bin': 'x' });
  await assert.rejects(() => hashFile(path.join(root, 'a.bin'), 'crc32'), /unsupported algorithm/);
});

test('collectFiles walks the tree and skips the excluded directories', async () => {
  const root = await makeTree({
    'top.txt': 'a',
    'sub/inner.txt': 'b',
    'node_modules/pkg/index.js': 'c',
    '.git/config': 'd',
  });
  const { files } = await collectFiles(root);
  assert.deepEqual(
    files.map((f) => f.path),
    ['sub/inner.txt', 'top.txt'],
  );
});

test('collectFiles reports paths with forward slashes on every platform', async () => {
  const root = await makeTree({ 'a/b/c.txt': 'x' });
  const { files } = await collectFiles(root);
  assert.deepEqual(files.map((f) => f.path), ['a/b/c.txt']);
});

test('hashAll keeps the input order and reports progress once per file', async () => {
  const root = await makeTree({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  const { files } = await collectFiles(root);
  const seen = [];
  const entries = await hashAll(files, { algorithm: 'sha256', concurrency: 2, onProgress: (p) => seen.push(p.done) });
  assert.deepEqual(
    entries.map((e) => e.path),
    ['a.txt', 'b.txt', 'c.txt'],
  );
  assert.deepEqual(seen, [1, 2, 3]);
});

test('parseExcludes handles repeated and comma separated values', () => {
  assert.deepEqual(parseExcludes(['a', 'b,c', ' d ']), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseExcludes([]), []);
  assert.deepEqual(parseExcludes(undefined), []);
});

// --- verification ---------------------------------------------------------

async function manifestFor(root, algorithm = 'sha256') {
  const { files } = await collectFiles(root);
  const entries = await hashAll(files, { algorithm });
  return buildManifest({ root, entries, algorithm });
}

test('an unchanged tree verifies clean', async () => {
  const root = await makeTree({ 'a.txt': 'a', 'sub/b.txt': 'b' });
  const report = await verifyManifest({
    root,
    manifestText: await manifestFor(root),
    present: (await collectFiles(root)).files,
  });
  assert.equal(report.summary.ok, 2);
  assert.equal(report.summary.changed, 0);
  assert.equal(report.summary.missing, 0);
  assert.equal(report.summary.extra, 0);
  assert.equal(exitCodeFor(report.summary), 0);
});

test('a changed file is reported as changed, with both hashes', async () => {
  const root = await makeTree({ 'a.txt': 'original' });
  const text = await manifestFor(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'tampered');

  const report = await verifyManifest({ root, manifestText: text, present: (await collectFiles(root)).files });
  assert.equal(report.summary.changed, 1);
  assert.equal(report.results[0].status, STATUS.CHANGED);
  assert.equal(report.results[0].expected, sha('original'));
  assert.equal(report.results[0].actual, sha('tampered'));
  assert.equal(exitCodeFor(report.summary), 1);
});

test('a missing file is reported as missing', async () => {
  const root = await makeTree({ 'a.txt': 'a', 'b.txt': 'b' });
  const text = await manifestFor(root);
  await fs.rm(path.join(root, 'b.txt'));

  const report = await verifyManifest({ root, manifestText: text, present: (await collectFiles(root)).files });
  assert.equal(report.summary.missing, 1);
  assert.equal(report.summary.ok, 1);
  assert.equal(exitCodeFor(report.summary), 1);
});

test('same content with a new timestamp is touched, not changed', async () => {
  const root = await makeTree({ 'a.txt': 'stable content' });
  const text = await manifestFor(root);
  // Rewrite identical bytes, which moves the timestamp.
  await fs.writeFile(path.join(root, 'a.txt'), 'stable content');
  const later = new Date(Date.now() + 60000);
  await fs.utimes(path.join(root, 'a.txt'), later, later);

  const report = await verifyManifest({ root, manifestText: text, present: (await collectFiles(root)).files });
  assert.equal(report.summary.touched, 1, JSON.stringify(report.results[0]));
  assert.equal(report.summary.changed, 0);
  assert.equal(exitCodeFor(report.summary), 0, 'a touch must not be a failure');
});

test('a file the manifest does not list is reported as extra', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const text = await manifestFor(root);
  await fs.writeFile(path.join(root, 'added.txt'), 'new');

  const report = await verifyManifest({ root, manifestText: text, present: (await collectFiles(root)).files });
  assert.equal(report.summary.extra, 1);
  assert.equal(report.extras[0].path, 'added.txt');
  assert.equal(exitCodeFor(report.summary), 2, 'extra content is a different exit code from a changed file');
});

test('extra reporting can be switched off', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const text = await manifestFor(root);
  await fs.writeFile(path.join(root, 'added.txt'), 'new');
  const report = await verifyManifest({
    root,
    manifestText: text,
    reportExtra: false,
    present: (await collectFiles(root)).files,
  });
  assert.equal(report.summary.extra, 0);
  assert.equal(exitCodeFor(report.summary), 0);
});

test('verification works with a bare sha256sum manifest when told the algorithm', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const bare = `${sha('a')}  a.txt\n`;
  const report = await verifyManifest({ root, manifestText: bare, algorithmOverride: 'sha256' });
  assert.equal(report.summary.ok, 1);
});

test('a manifest naming no algorithm and no override fails with a clear message', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  await assert.rejects(
    () => verifyManifest({ root, manifestText: `${sha('a')}  a.txt\n` }),
    /does not name an algorithm/,
  );
});

test('a manifest path pointing outside the root is refused, not followed', async () => {
  const root = await makeTree({ 'a.txt': 'a' });
  const escape = JSON.stringify({
    version: 1,
    algorithm: 'sha256',
    files: [{ path: '../../etc/passwd', hash: sha('x'), size: 1, mtime: new Date(0).toISOString() }],
  });
  const report = await verifyManifest({ root, manifestText: escape });
  assert.equal(report.summary.missing, 1);
  assert.match(report.results[0].note, /escapes the root/);
});
