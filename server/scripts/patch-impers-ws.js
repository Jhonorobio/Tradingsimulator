#!/usr/bin/env node
// Postinstall patch for impers: its AsyncWebSocket constructor is a stub —
// it builds a Headers list but never applies it ("Would need SList here for
// actual implementation") and never wires `impersonate`/`verify` to the curl
// handle, so GMGN rejects the handshake with 403. This wires them up using
// impers' own low-level API (setHeaders / impersonate / setOpt).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let entry;
try {
  entry = require.resolve('impers', { paths: [process.cwd()] });
} catch {
  console.log('[patch-impers-ws] impers not installed, skipping');
  process.exit(0);
}

const wsPath = path.join(path.dirname(entry), 'websocket', 'websocket.js');
if (!fs.existsSync(wsPath)) {
  console.error('[patch-impers-ws] websocket.js not found at ' + wsPath);
  process.exit(1);
}

const src = fs.readFileSync(wsPath, 'utf8');
if (src.includes('PATCHED-IMPERS-WS')) {
  console.log('[patch-impers-ws] already patched, skipping');
  process.exit(0);
}

const oldBlock = `        // Configure WebSocket URL (curl expects ws:// or wss:// scheme)
        this.curl.setOpt(CurlOpt.URL, url);
        // Enable WebSocket upgrade
        this.curl.setOpt(CurlOpt.CONNECT_ONLY, 2); // 2 = WebSocket mode
        // Set headers
        if (options.headers) {
            const headers = new Headers(options.headers);
            const headerList = headers.toCurlHeaders();
            // Note: Would need SList here for actual implementation
        }
        // Set timeout
        if (options.timeout) {
            this.curl.setOpt(CurlOpt.TIMEOUT, options.timeout);
        }`;

const newBlock = `        // Configure WebSocket URL (curl expects ws:// or wss:// scheme)
        this.curl.setOpt(CurlOpt.URL, url);
        // Enable WebSocket upgrade
        this.curl.setOpt(CurlOpt.CONNECT_ONLY, 2); // 2 = WebSocket mode
        /* PATCHED-IMPERS-WS */
        // Browser impersonation (TLS fingerprint) for the WS handshake
        if (options.impersonate) {
            this.curl.impersonate(options.impersonate, options.defaultHeaders !== false);
        }
        // Apply custom headers via curl_slist (upstream stub never set them)
        if (options.headers) {
            const list = Array.isArray(options.headers)
                ? options.headers
                : Object.entries(options.headers).map(([k, v]) => \`\${k}: \${v}\`);
            this.curl.setHeaders(list);
        }
        if (options.verify === false) {
            this.curl.setOpt(CurlOpt.SSL_VERIFYPEER, 0);
            this.curl.setOpt(CurlOpt.SSL_VERIFYHOST, 0);
        }
        // Set timeout
        if (options.timeout) {
            this.curl.setOpt(CurlOpt.TIMEOUT, options.timeout);
        }`;

if (!src.includes(oldBlock)) {
  console.error('[patch-impers-ws] unexpected websocket.js shape — impers changed, update this patch');
  process.exit(1);
}

fs.writeFileSync(wsPath, src.replace(oldBlock, newBlock));
console.log('[patch-impers-ws] patched ' + wsPath);
