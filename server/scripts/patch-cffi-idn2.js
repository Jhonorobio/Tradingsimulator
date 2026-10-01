#!/usr/bin/env node
// The gnu binding imports idn2_* symbols but does not list libidn2 in DT_NEEDED,
// so dlopen fails with "undefined symbol: idn2_check_version". Patch the binary to
// depend on libidn2 (absolute path when possible) and make sure its dependency
// chain (libunistring) is installed.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'linux') process.exit(0);

const sh = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
};

// Install every package whose name mentions libunistring (provides libunistring.so.*)
sh('apt-get update -qq');
const uniPkgs = sh("apt-cache search --names-only libunistring | awk '{print $1}'").trim();
console.log('[patch-cffi-idn2] libunistring packages: ' + (uniPkgs || 'NONE FOUND'));
if (uniPkgs) {
  sh('apt-get install -y -qq ' + uniPkgs.split(/\s+/).join(' '));
}

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
    } else if (/libidn2\.so\.0/.test(needed)) {
      execFileSync('patchelf', ['--replace-needed', 'libidn2.so.0', wanted, bin]);
      console.log('[patch-cffi-idn2] replaced soname with ' + wanted + ': ' + bin);
    } else {
      execFileSync('patchelf', ['--add-needed', wanted, bin]);
      console.log('[patch-cffi-idn2] added ' + wanted + ': ' + bin);
    }
    const missing = sh(`ldd ${JSON.stringify(bin)} 2>/dev/null | grep -i "not found" || echo RESOLVED`).trim();
    console.log('[patch-cffi-idn2] ldd ' + bin + ': ' + missing);
  } catch (err) {
    console.log('[patch-cffi-idn2] FAILED ' + bin + ': ' + err.message);
    process.exitCode = 1;
  }
}
