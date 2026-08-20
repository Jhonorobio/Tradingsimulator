import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Resolve the CLI from node_modules when present (Railway/CI deploy gmgn-cli as
// a project dependency), falling back to whatever is on PATH. On Windows the
// .cmd shim is required — spawning dist/index.js through cmd.exe silently
// produces empty output (cmd can't run a bare .js file).
function resolveBin() {
  if (process.env.GMGN_BIN) return process.env.GMGN_BIN;
  try {
    const pkg = require.resolve('gmgn-cli/package.json', { paths: [process.cwd()] });
    if (platform() === 'win32') {
      return path.join(path.dirname(pkg), '..', '.bin', 'gmgn-cli.cmd');
    }
    return require.resolve('gmgn-cli', { paths: [process.cwd()] });
  } catch {
    return 'gmgn-cli';
  }
}

const GMGN_BIN = resolveBin();
const TIMEOUT_MS = 90_000;

/**
 * Spawns gmgn-cli with the given args.
 * On Windows the CLI is a .cmd shim, so we route through cmd.exe.
 */
function spawnCli(args) {
  if (platform() === 'win32') {
    return spawn('cmd.exe', ['/c', GMGN_BIN, ...args], {
      windowsHide: true,
      env: process.env,
    });
  }
  return spawn(GMGN_BIN, args, { env: process.env });
}

/**
 * Extracts the raw JSON payload from CLI stdout.
 * gmgn-cli --raw prints one line of JSON, but on errors the output may
 * contain human-readable text too. We locate the first `{` / `[` and parse
 * from there to the matching end.
 */
function extractJson(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[\[{]/);
    if (start === -1) throw new Error(`No JSON found in output: ${trimmed.slice(0, 300)}`);
    const char = trimmed[start];
    const end = trimmed.lastIndexOf(char === '[' ? ']' : '}');
    if (end <= start) throw new Error(`Unterminated JSON in output: ${trimmed.slice(0, 300)}`);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * Runs `gmgn-cli market <sub> ...` and returns parsed JSON.
 * @param {string} sub - subcommand (trenches | search | signal | hot-searches)
 * @param {string[]} args - raw CLI args (dash flags)
 */
export function runMarket(sub, args = [], { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(['market', sub, '--raw', ...args]);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`gmgn-cli market ${sub} timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to launch gmgn-cli: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = (stderr || stdout || 'unknown error').trim().slice(0, 500);
        return reject(new Error(`gmgn-cli market ${sub} exited ${code}: ${msg}`));
      }
      try {
        resolve(extractJson(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function runConfigCheck() {
  return new Promise((resolve) => {
    const child = spawnCli(['config', '--check']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', () => resolve({ ok: false, message: 'gmgn-cli not found' }));
    child.on('close', (code) =>
      resolve({ ok: code === 0, message: (stdout || stderr).trim() })
    );
  });
}