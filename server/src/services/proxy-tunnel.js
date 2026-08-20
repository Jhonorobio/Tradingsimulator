import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

/**
 * Manual HTTP CONNECT tunnel. HttpsProxyAgent/undici don't route these proxies
 * correctly (they fall back to the local egress IP), but a raw CONNECT tunnel
 * goes through the proxy's REAL IP — which is what matters to bypass GMGN's
 * per-IP blocking. Playwright confirmed the same result; this is the
 * dependency-free equivalent.
 *
 * Usage: tunnelRequest('https://openapi.gmgn.ai/v1/...', { proxy, method, headers, body })
 */

function parseProxy(proxyUrl) {
  const m = /^(?:https?:\/\/)?([^:/]+)(?::(\d+))?$/.exec(proxyUrl);
  if (!m) throw new Error(`Invalid proxy URL: ${proxyUrl}`);
  return { host: m[1], port: m[2] ? Number(m[2]) : 8080 };
}

/** Opens an HTTP CONNECT tunnel through the proxy and returns a TLS socket to the target. */
function openTunnel(proxy, targetHost, targetPort, timeoutMs) {
  const { host, port } = parseProxy(proxy);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('proxy CONNECT timed out'));
    });
    socket.on('error', (err) => reject(new Error(`proxy connect failed: ${err.message}`)));
    socket.on('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf(Buffer.from('\r\n\r\n'));
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString();
      socket.removeAllListeners('data');
      socket.setTimeout(0);
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        return reject(new Error(`proxy CONNECT rejected: ${head.split('\r\n')[0]}`));
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost });
      tlsSocket.on('error', (err) => reject(new Error(`tls handshake failed: ${err.message}`)));
      tlsSocket.on('secureConnect', () => {
        tlsSocket.setTimeout(0);
        resolve(tlsSocket);
      });
    });
  });
}

/**
 * HTTPS request through an HTTP proxy via a raw CONNECT tunnel.
 * @param {string} url - full https URL
 * @param {{ proxy: string, method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ status: number, headers: Record<string,string>, text: () => Promise<string>, json: () => Promise<any> }>}
 */
export async function tunnelRequest(url, { proxy, method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  if (!proxy) throw new Error('tunnelRequest requires a proxy');
  const u = new URL(url);
  const tlsSocket = await openTunnel(proxy, u.hostname, u.port || 443, timeoutMs);

  const path = u.pathname + u.search;
  const headLines = [`${method} ${path} HTTP/1.1`, `Host: ${u.hostname}`, 'Connection: close'];
  for (const [k, v] of Object.entries(headers)) headLines.push(`${k}: ${v}`);
  if (body != null) headLines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  const req = headLines.join('\r\n') + '\r\n\r\n' + (body ?? '');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error('tunnel request timed out'));
    }, timeoutMs);
    let raw = Buffer.alloc(0);
    tlsSocket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`request failed: ${err.message}`));
    });
    tlsSocket.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
    });
    tlsSocket.on('end', () => {
      clearTimeout(timer);
      try {
        const idx = raw.indexOf(Buffer.from('\r\n\r\n'));
        const head = raw.slice(0, idx).toString();
        let bodyBuf = raw.slice(idx + 4);
        const statusLine = head.split('\r\n')[0];
        const status = Number(/HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)?.[1]) || 0;
        const resHeaders = {};
        for (const line of head.split('\r\n').slice(1)) {
          const c = line.indexOf(':');
          if (c === -1) continue;
          resHeaders[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
        }

        // GMGN replies with Transfer-Encoding: chunked — decode it (and any
        // gzip/deflate/br body) since a raw tunnel does no auto-decompression.
        if (String(resHeaders['transfer-encoding']).toLowerCase().includes('chunked')) {
          bodyBuf = decodeChunked(bodyBuf);
        }
        if (resHeaders['content-encoding']) {
          bodyBuf = decodeContent(bodyBuf, resHeaders['content-encoding']);
        }

        resolve({
          status,
          headers: resHeaders,
          text: async () => bodyBuf.toString(),
          json: async () => JSON.parse(bodyBuf.toString()),
        });
      } catch (err) {
        reject(new Error(`response parse failed: ${err.message}`));
      }
    });
    tlsSocket.write(req);
  });
}

/** Decodes a `Transfer-Encoding: chunked` body. */
function decodeChunked(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const crlf = buf.indexOf(Buffer.from('\r\n'), pos);
    if (crlf === -1) break;
    const sizeHex = buf.slice(pos, crlf).toString().trim();
    if (!sizeHex) break;
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size === 0) break; // 0 = final chunk
    pos = crlf + 2;
    out.push(buf.subarray(pos, pos + size));
    pos += size + 2; // skip chunk data + trailing CRLF
  }
  return Buffer.concat(out);
}

/** Decompresses a body according to its Content-Encoding header. */
function decodeContent(buf, encoding) {
  const enc = String(encoding).toLowerCase().trim();
  if (enc === 'gzip') return zlib.gunzipSync(buf);
  if (enc === 'deflate') return zlib.inflateSync(buf);
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  return buf;
}

/**
 * Resolves the REAL egress IP of a proxy by opening a CONNECT tunnel to an
 * ipify-style service. Returns null when the proxy is unreachable.
 */
export async function proxyEgressIp(proxy, timeoutMs = 15_000) {
  try {
    const res = await tunnelRequest('https://api64.ipify.org?format=json', {
      proxy,
      timeoutMs,
      headers: { Accept: 'application/json' },
    });
    const json = await res.json();
    return typeof json?.ip === 'string' ? json.ip : null;
  } catch {
    return null;
  }
}