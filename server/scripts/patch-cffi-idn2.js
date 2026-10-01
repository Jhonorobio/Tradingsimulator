#!/usr/bin/env node
// Add DT_NEEDED libidn2.so.0 to the curl-cffi native binding.
// The binary imports idn2_* symbols but does not list libidn2 in DT_NEEDED,
// so dlopen fails with "undefined symbol: idn2_check_version" on clean images.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'linux') process.exit(0);

const require = createRequire(import.meta.url);
const targets = [];

try {
  targets.push(require.resolve('@curl-cffi-node/linux-x64-gnu'));
} catch {}

try {
  const main = require.resolve('curl-cffi-node');
  const root = path.dirname(path.dirname(main)); // dist/..
  const localBin = path.join(root, 'curl-cffi-node.linux-x64-gnu.node');
  if (fs.existsSync(localBin)) targets.push(localBin);
} catch {}

for (const bin of targets) {
  if (!fs.existsSync(bin)) continue;
  try {
    const needed = execFileSync('patchelf', ['--print-needed', bin]).toString();
    if (needed.includes('libidn2.so.0')) {
      console.log('[patch-cffi-idn2] already patched: ' + bin);
      continue;
    }
    execFileSync('patchelf', ['--add-needed', 'libidn2.so.0', bin]);
    console.log('[patch-cffi-idn2] patched ' + bin);
  } catch (err) {
    console.log('[patch-cffi-idn2] FAILED ' + bin + ': ' + err.message);
    process.exitCode = 1;
  }
}
