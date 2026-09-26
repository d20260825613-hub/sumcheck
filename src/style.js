/** Terminal styling. Colour is dropped when the output is not a terminal. */

const enabled = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const CODES = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] };

function paint(text, name) {
  if (!enabled) return String(text);
  const code = CODES[name];
  return code ? `\u001b[${code[0]}m${text}\u001b[${code[1]}m` : String(text);
}

export const bold = (text) => paint(text, 'bold');
export const dim = (text) => paint(text, 'dim');
export const red = (text) => paint(text, 'red');
export const green = (text) => paint(text, 'green');
export const yellow = (text) => paint(text, 'yellow');
export const cyan = (text) => paint(text, 'cyan');

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Binary sizes, matching what disk tools report. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const value = n / 1024 ** exp;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${UNITS[exp]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}
