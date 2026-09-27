#!/usr/bin/env node
/**
 * Entry point for the installed `sumcheck` command.
 *
 * The handlers are installed here as well as in `src/cli.js`: importing `run`
 * makes the module's direct-run check false, so a command on PATH would
 * otherwise get no EPIPE or signal handling. `installCliHandlers` keeps a
 * WeakMap of what it installed, so both entry points asking is a no-op.
 */
import { installHandlers, run } from '../src/cli.js';

installHandlers();

process.exitCode = await run(process.argv.slice(2));
