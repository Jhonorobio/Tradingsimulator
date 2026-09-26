import { create } from 'zustand';

import { getMemescope } from '@/api/market';
import type { MemescopeResponse } from '@/api/market';

const POLL_MS = 1000;

interface MemescopeState {
  resp: MemescopeResponse | null;
  error: string | null;
  /** Starts the global 1s poller (idempotent — runs for the whole app session). */
  startPolling: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Global Photon memescape feed. Polling starts once at app boot (from the
 * root layout) and keeps running on every screen — the tab only reads state.
 */
export const useMemescope = create<MemescopeState>((set) => ({
  resp: null,
  error: null,
  startPolling: () => {
    if (timer) return;
    const load = () => {
      getMemescope()
        .then((r) => set({ resp: r, error: r.error ?? null }))
        .catch((e: unknown) => set({ error: e instanceof Error ? e.message : String(e) }));
    };
    load();
    timer = setInterval(load, POLL_MS);
  },
}));
