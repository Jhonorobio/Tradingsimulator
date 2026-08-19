#!/usr/bin/env node
// Postinstall patch for gmgn-cli (see README "Parche de reloj").
// gmgn-cli 1.5.7 signs with Date.now()/1000 but validates the timestamp within
// ±5s of the GMGN server clock. When the system clock runs ahead, requests fail
// with AUTH_TIMESTAMP_EXPIRED. This patch makes buildAuthQuery subtract
// process.env.GMGN_TIME_OFFSET (seconds) so deployments can compensate.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let target;
try {
  target = require.resolve('gmgn-cli/package.json', { paths: [process.cwd()] });
} catch {
  console.log('[patch-gmgn-signer] gmgn-cli not installed, skipping');
  process.exit(0);
}

const signerPath = path.join(path.dirname(target), 'dist', 'client', 'signer.js');
if (!fs.existsSync(signerPath)) {
  console.log('[patch-gmgn-signer] signer.js not found at ' + signerPath);
  process.exit(0);
}

let src = fs.readFileSync(signerPath, 'utf8');
if (src.includes('GMGN_TIME_OFFSET')) {
  console.log('[patch-gmgn-signer] already patched, skipping');
  process.exit(0);
}

const from = 'timestamp: Math.floor(Date.now() / 1000)';
const to = 'timestamp: Math.floor(Date.now() / 1000) - (parseInt(process.env.GMGN_TIME_OFFSET || "0", 10) || 0)';
if (!src.includes(from)) {
  console.log('[patch-gmgn-signer] unexpected signer.js shape, skipping');
  process.exit(0);
}

fs.writeFileSync(signerPath, src.replace(from, to));
console.log('[patch-gmgn-signer] patched ' + signerPath);