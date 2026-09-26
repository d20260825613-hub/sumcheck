# sumcheck

Checksum a directory now, verify it later.

```console
$ sumcheck generate ./backup
wrote backup/sumcheck.json
  1284 files, 4.2 GB, sha256, 18.4s

$ sumcheck verify ./backup
changed photos/2019/sunset.jpg
        expected 3f9a1c…
        actual   b71e04…
extra   notes-draft.txt

the tree does not match the manifest
  1282 ok, 0 touched, 1 changed, 0 missing, 1 extra
  sha256, 1284 file(s) listed
```

## Why not just `sha256sum`

`sha256sum` computes hashes and `sha256sum -c` checks them, and this tool reads
the same text format so the two interoperate. What `sha256sum` does not do is
tell you *which kind* of mismatch you have, and that is the whole point here.

| Status | Meaning |
| --- | --- |
| `ok` | the content matches |
| `touched` | content matches, size or timestamp moved |
| `changed` | the file is there and the content differs |
| `missing` | the manifest lists it and it is not on disk |
| `extra` | it is on disk and the manifest does not list it |

`touched` is the one people ask about. A file restored from a backup, or
re-copied by a sync tool, has identical content and a new timestamp. Calling that
"changed" is a false alarm; calling it "ok" hides that something touched your
tree. It gets its own line and it does not fail the run.

`extra` gets its own **exit code**, so a pipeline can distinguish "a file I care
about was modified" from "there is new stuff here".

## Install

```bash
npx sumcheck generate ./data

npm install -g sumcheck
sumcheck verify ./data
```

Node 18.17 or newer. No dependencies.

## Commands

### `sumcheck generate [dir]`

Walks the directory, hashes every file, writes a manifest.

| Option | Meaning |
| --- | --- |
| `-m, --manifest <file>` | Where to write (default `sumcheck.json`) |
| `-a, --algorithm <name>` | `md5`, `sha1`, `sha256` (default), `sha512` |
| `-x, --exclude <name>` | Additional directory to skip; repeatable or comma separated |
| `--text` | Write the `sha256sum`-compatible text format instead of JSON |
| `-f, --force` | Overwrite an existing manifest |
| `-q, --quiet` | No progress line |

`.git`, `node_modules`, `.svn`, `.hg`, `__pycache__` and `.venv` are always
skipped. `--exclude` **adds** to that list rather than replacing it.

The manifest itself is never included in what it describes, so the first
`verify` after a `generate` is clean even when you write the manifest into the
directory you are hashing.

### `sumcheck verify [dir]`

Reads the manifest, hashes the tree, reports the differences.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | everything matches |
| 1 | a file changed or is missing |
| 2 | the tree has files the manifest does not list |
| 3 | bad arguments or an unreadable manifest |

`--json` prints the full report instead of the human one.

### `sumcheck merge <manifest...>`

Combines manifests into one. If the same path appears twice with different
hashes, it refuses rather than picking one.

## The formats

**Text** — what GNU coreutils writes, one line per file:

```
3f9a1c...  photos/2019/sunset.jpg
```

Paths use forward slashes on every platform, which is what makes a manifest
portable. That is also the format's limit: a file name containing a newline
cannot be represented, so such a file is skipped with an error rather than
written incorrectly.

A manifest made here can be checked by the system tool:

```bash
sumcheck generate . --text -m SHA256SUMS
sha256sum -c SHA256SUMS
```

And a manifest made by the system tool can be checked here, as long as you say
which algorithm to use, because a bare `sha256sum` file does not record it:

```bash
sumcheck verify . -m SHA256SUMS --algorithm sha256
```

**JSON** — the default, and what carries the extra fields that make `touched`
possible:

```json
{
  "tool": "sumcheck",
  "version": 1,
  "algorithm": "sha256",
  "createdAt": "2026-09-26T12:00:00.000Z",
  "root": "C:/work/backup",
  "files": [{ "path": "a.txt", "hash": "3f9a…", "size": 1024, "mtime": "2026-09-20T09:00:00.000Z" }]
}
```

## Where this is useful

- **Before and after a move.** Copy a tree to a new disk, verify it, delete the
  original. That is the case this was written for.
- **Backup integrity.** A backup that was never verified is a hope.
- **Release artifacts.** Publish a manifest next to your files.
- **A CI check** that a generated directory has not changed unexpectedly.

## Limitations

It hashes every byte of every file, so a large tree takes as long as reading it
takes. There is no incremental mode and no index; `--exclude` is the tool for
keeping a run short.

The `touched` check compares timestamps with a one-second tolerance, because
copying between filesystems does not preserve sub-second precision.

A manifest does not detect a file that was changed and changed back. Hashes are
of the content, and the content is what it was.

## Testing

```bash
npm test
```

32 tests, most of them about the distinctions: changed vs missing vs extra vs
touched, a manifest path that tries to escape the root, a malformed line, a
conflicting merge.

## License

MIT. See [LICENSE](LICENSE).
