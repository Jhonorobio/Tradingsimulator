import { notificationConfig, notifiedTokens } from '../stores.js';
import { getAllTokens, storeSize } from './trenches-store.js';
import { sendPush, checkReceipts } from './push.js';

const CATEGORIES = ['new_creation', 'near_completion', 'completed'];

// How many poll cycles between receipt checks (e.g., 60 × 5s = 5 min)
const RECEIPT_CHECK_INTERVAL = 60;

function fmtUsd(n) {
  if (n == null || isNaN(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtNum(n) {
  if (n == null) return 'n/a';
  return n.toLocaleString();
}

/**
 * Checks all enabled notification configs against the in-memory trenches store.
 * For each device with an enabled category, looks up tokens in the trenches
 * store and sends push notifications for tokens not yet notified.
 * No GMGN calls — reads only from the cache populated by the trenches refresher.
 * Returns { checked, notified, tickets } where tickets = [{ticketId, deviceId}]
 */
export async function pollOnce({ onError = () => {} } = {}) {
  const all = notificationConfig.getAll();
  const devices = Object.values(all).filter((e) => e?.push_token);
  if (!devices.length) return { checked: 0, notified: 0, tickets: [] };

  // If trenches store is empty, nothing to notify about
  if (storeSize() === 0) return { checked: devices.length, notified: 0, tickets: [] };

  let notified = 0;
  const tickets = [];

  for (const entry of devices) {
    const { push_token: token, categories } = entry;
    if (!token || !categories) continue;

    for (const cat of CATEGORIES) {
      if (!categories[cat]) continue;

      const notifiedKey = `${entry.device_id}:${cat}`;
      const alreadyNotified = new Set(notifiedTokens.get(notifiedKey) || []);

      // Get all known token addresses from the trenches store
      const tokens = getTokensFromStore(cat);

      for (const t of tokens) {
        if (!t.address || alreadyNotified.has(t.address)) continue;
        alreadyNotified.add(t.address);

        // Persist notified address
        const list = notifiedTokens.get(notifiedKey) || [];
        list.push(t.address);
        if (list.length > 500) list.shift();
        notifiedTokens.set(notifiedKey, list);

        const title = `${t.symbol || t.name || 'Token'} — ${cat.replace('_', ' ')}`;
        const body = [
          `MCap ${fmtUsd(t.usd_market_cap ?? t.market_cap)}`,
          `Liq ${fmtUsd(t.liquidity)}`,
          `Vol24h ${fmtUsd(t.volume_24h)}`,
          `SM ${fmtNum(t.smart_degen_count)}`,
          `Rug ${t.rug_ratio != null ? t.rug_ratio.toFixed(2) : 'n/a'}`,
        ].join(' · ');

        const { ticketId, result } = await sendPush(token, {
          title,
          body,
          data: { address: t.address, chain: t.chain || 'sol', symbol: t.symbol, type: cat },
        });
        if (result?.data?.status === 'error') {
          onError(new Error(`Push failed: ${result.data.message}`));
        } else {
          notified += 1;
          if (ticketId) {
            tickets.push({ ticketId, deviceId: entry.device_id });
          }
        }
      }
    }
  }

  return { checked: devices.length, notified, tickets };
}

/**
 * Gets tokens from the in-memory trenches store for a given category.
 * The store is keyed by token address (flat), but each token carries
 * the category it was seen in via upsertTrenches.
 * Returns tokens that belong to the given category.
 */
function getTokensFromStore(category) {
  const all = getAllTokens();
  return all.filter((t) => t._category === category);
}

export function startPoller(intervalSeconds, { onError = () => {} } = {}) {
  const intervalMs = Math.max(1, Number(intervalSeconds) || 5) * 1000;
  let cycleCount = 0;
  let pendingTickets = [];

  const run = async () => {
    try {
      const { tickets } = await pollOnce({ onError });
      if (tickets?.length) pendingTickets.push(...tickets);

      // Every RECEIPT_CHECK_INTERVAL cycles, check accumulated receipts
      cycleCount++;
      if (cycleCount >= RECEIPT_CHECK_INTERVAL && pendingTickets.length > 0) {
        cycleCount = 0;
        const ticketIds = pendingTickets.map((t) => t.ticketId);
        const ticketToDevice = new Map(pendingTickets.map((t) => [t.ticketId, t.deviceId]));
        pendingTickets = [];

        try {
          const invalidDevices = await checkReceipts(ticketIds, ticketToDevice);
          for (const deviceId of invalidDevices) {
            // Remove dead device's notification config and notified tokens
            notificationConfig.delete(deviceId);
            for (const cat of CATEGORIES) {
              notifiedTokens.delete(`${deviceId}:${cat}`);
            }
            console.log(`[poller] Removed dead push token for device ${deviceId}`);
          }
        } catch (err) {
          onError(err);
        }
      }
    } catch (err) {
      onError(err);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 5_000).unref?.();
  return timer;
}
