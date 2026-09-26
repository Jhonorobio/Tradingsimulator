import { create } from 'zustand';

import { getMemescope } from '@/api/market';
import type { MemescopeResponse } from '@/api/market';
import { getWsClient } from '@/api/ws-client';

const TOPIC = 'memescope';

interface MemescopeState {
  resp: MemescopeResponse | null;
  error: string | null;
  /** Subscribes to the server's WS feed (idempotent — app-wide, runs forever). */
  startListening: () => void;
}

const client = getWsClient();
let started = false;

/**
 * Global Photon memescape feed, pushed by the server over WebSocket.
 *
 * The server polls Photon every 1s (always) and pushes `memescope_updated`
 * to subscribers every ~1s — the app never polls HTTP for it (one initial
 * cache read fills the screen before the first push arrives).
 */
export const useMemescope = create<MemescopeState>((set) => ({
  resp: null,
  error: null,
  startListening: () => {
    if (started) return;
    started = true;

    // Instant snapshot from the server cache (before the first WS push).
    getMemescope()
      .then((r) => set({ resp: r, error: r.error ?? null }))
      .catch((e: unknown) => set({ error: e instanceof Error ? e.message : String(e) }));

    // Keeps the server-side poller alive and receives 1s pushes.
    client.subscribe(TOPIC);
    client.on('memescope_updated', (msg) => {
      const data = (msg?.data ?? null) as MemescopeResponse | null;
      if (data) set({ resp: data, error: data.error ?? null });
    });
  },
}));
