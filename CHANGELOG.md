# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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