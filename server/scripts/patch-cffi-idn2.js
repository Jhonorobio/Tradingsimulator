#!/usr/bin/env node
// The gnu binding imports idn2_* symbols but does not list libidn2 in DT_NEEDED,
// so dlopen fails with "undefined symbol: idn2_check_version". Patch the binary to
// depend on libidn2, preferring an absolute path when the file exists so the loader
// does not have to resolve it via cache.
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
  const root = path.dirname(path.dirname(main));
  const localBin = path.join(root, 'curl-cffi-node.linux-x64-gnu.node');
  if (fs.existsSync(localBin)) targets.push(localBin);
} catch {}

const libCandidates = [
  '/lib/x86_64-linux-gnu/libidn2.so.0',
  '/usr/lib/x86_64-linux-gnu/libidn2.so.0',
  '/lib64/libidn2.so.0',
];
const libPath = libCandidates.find((p) => fs.existsSync(p));
console.log('[patch-cffi-idn2] libidn2 at: ' + (libPath || 'NOT FOUND (using soname)'));

for (const bin of targets) {
  if (!fs.existsSync(bin)) continue;
  try {
    const needed = execFileSync('patchelf', ['--print-needed', bin]).toString();
    const wanted = libPath || 'libidn2.so.0';
    if (needed.split('\n').some((l) => l.trim() === wanted)) {
      console.log('[patch-cffi-idn2] already OK: ' + bin);
      continue;
    }
    if (/libidn2\.so\.0/.test(needed)) {
      execFileSync('patchelf', ['--replace-needed', 'libidn2.so.0', wanted, bin]);
      console.log('[patch-cffi-idn2] replaced soname with ' + wanted + ': ' + bin);
    } else {
      execFileSync('patchelf', ['--add-needed', wanted, bin]);
      console.log('[patch-cffi-idn2] added ' + wanted + ': ' + bin);
    }
  } catch (err) {
    console.log('[patch-cffi-idn2] FAILED ' + bin + ': ' + err.message);
    process.exitCode = 1;
  }
}
