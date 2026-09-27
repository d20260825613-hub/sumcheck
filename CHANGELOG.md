# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Bad arguments now exit 2 and a failed operation exits 1; the old code 3 is
  gone, so a script can tell "you typed it wrong" from "the run failed".
- A mistyped option is answered with a "did you mean" suggestion, and an option
  that is missing its value says so instead of reading `undefined`.
- Errors are printed as a message and a hint, never as a stack trace, unless
  `--debug` or `SUMCHECK_DEBUG=1` asks for one. `--debug` is new.

### Fixed

- `installCliHandlers` was called only from the direct-run block in
  `src/cli.js`, so it never fired for the installed `sumcheck` command: the bin
  entry imports the module rather than running it. `bin/sumcheck.js` now installs
  the handlers itself, so `sumcheck verify big-dir | head` exits quietly instead
  of printing an EPIPE stack trace and Ctrl-C stops a long hash without a
  traceback. The configuration moved into an exported `installHandlers()` so both
  entry points use the same one, and a new test spawns a subprocess that imports
  `bin/sumcheck.js` the way a command on PATH does — removing the call makes it
  fail with `sigint=0 pipe=0`.

## [0.1.0] - 2026-09-26

### Added

- `sumcheck generate` walks a directory, hashes every file and writes a manifest,
  in either a JSON format or the text format `sha256sum` writes.
- `sumcheck verify` reports five distinct outcomes rather than two: ok, touched,
  changed, missing and extra. "Touched" means the content matches but the size or
  timestamp moved, which is what a restore or a re-sync looks like, and it does
  not fail the run.
- `sumcheck merge` combines manifests, refusing to pick a winner when the same
  path has two different hashes.
- Exit codes distinguish a modified tree (1) from a tree with unexpected extra
  content (2), so a pipeline can react differently to each.
- Manifests interoperate with GNU coreutils in both directions.
- 32 tests, most of them about the distinctions between the five outcomes, path
  escapes, malformed input and conflicting merges.

[Unreleased]: https://github.com/d20260825613-hub/sumcheck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/d20260825613-hub/sumcheck/releases/tag/v0.1.0