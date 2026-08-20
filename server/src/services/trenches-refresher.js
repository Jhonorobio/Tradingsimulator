import { fetchTrenches } from '../cli/args.js';
import { db } from '../db.js';
import { buildParamsFromConfig, TRENCH_TABS } from './trenches-filters.js';

/**
 * Background refresher for the Trenches views. Reads every saved filter config
 * (per device) plus the default one, force-refreshes each tab's cache so the
 * app always reads a warm cache. The app itself never calls GMGN.
 * Respects the GMGN 429 cooldown set by fetchTrenches.
 */
export function startTrenchesRefresher(intervalSeconds, { onError = () => {} } = {}) {
  const intervalMs = Math.max(3, Number(intervalSeconds) || 3) * 1000;

  const run = async () => {
    const rows = db.prepare('SELECT filters FROM trenches_filters').all();
    const configs = rows.map((r) => {
      try {
        return JSON.parse(r.filters);
      } catch {
        return null;
      }
    });
    // default (no filters saved) view is always refreshed too
    configs.push(null);

    const seen = new Set();
    for (const config of configs) {
      for (const tab of TRENCH_TABS) {
        const params = buildParamsFromConfig(config, tab);
        const key = JSON.stringify(params);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          await fetchTrenches(params, { force: true });
        } catch (err) {
          onError(err);
        }
      }
    }
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  // first run shortly after boot
  setTimeout(run, 3_000).unref?.();
  return timer;
}