import { notificationConfig, notifiedTokens, notificationHistory } from '../stores.js';
import { getAllTokens, storeSize, onTokensInserted } from './trenches-store.js';
import { sendPush, checkReceipts } from './push.js';
import { broadcast } from './ws-server.js';

const CATEGORIES = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood'];

// How many insert cycles between receipt checks (e.g., 60 ≈ 5 min depending on frequency)
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
 * Checks enabled notification configs for the given tabs against the trenches store.
 * Sends push notifications for tokens not yet notified.
 * Returns { checked, notified, tickets }
 */
export async function pollOnce({ tabs = null, onError = () => {} } = {}) {
  const all = notificationConfig.getAll();
  const devices = Object.values(all).filter((e) => e?.push_token);
  if (!devices.length) return { checked: 0, notified: 0, tickets: [] };

  if (storeSize() === 0) return { checked: devices.length, notified: 0, tickets: [] };

  let notified = 0;
  const tickets = [];
  const catsToCheck = tabs || CATEGORIES;

  for (const entry of devices) {
    const { push_token: token, categories } = entry;
    if (!token || !categories) continue;

    for (const cat of catsToCheck) {
      if (!CATEGORIES.includes(cat)) continue;
      if (!categories[cat]) continue;

      const notifiedKey = `${entry.device_id}:${cat}`;
      const alreadyNotified = new Set(notifiedTokens.get(notifiedKey) || []);

      const tokens = getTokensFromStore(cat);

      for (const t of tokens) {
        if (!t.address || alreadyNotified.has(t.address)) continue;
        alreadyNotified.add(t.address);

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
          // Save to notification history
          const historyEntry = {
            device_id: entry.device_id,
            address: t.address,
            chain: t.chain || 'sol',
            symbol: t.symbol || null,
            name: t.name || null,
            category: cat,
            mcap: t.usd_market_cap ?? t.market_cap ?? null,
            liq: t.liquidity ?? null,
            logo: t.logo || null,
            smart_degen_count: t.smart_degen_count ?? null,
            renowned_count: t.renowned_count ?? null,
            fresh_wallet_rate: t.fresh_wallet_rate ?? null,
            bot_degen_count: t.bot_degen_count ?? null,
            bot_degen_rate: t.bot_degen_rate ?? null,
            notified_at: new Date().toISOString(),
          };
          notificationHistory.add(historyEntry);
          broadcast(`notifications:${entry.device_id}`, { event: 'notification_new', data: historyEntry });
          // Cap history at 500 entries per device
          const allEntries = notificationHistory.filter((e) => e.device_id === entry.device_id);
          if (allEntries.length > 500) {
            const toRemove = allEntries.slice(0, allEntries.length - 500);
            for (const old of toRemove) {
              notificationHistory.delete((e) => e.id === old.id);
            }
          }
        }
      }
    }
  }

  return { checked: devices.length, notified, tickets };
}

function getTokensFromStore(category) {
  const all = getAllTokens();
  return all.filter((t) => t._category === category);
}

/**
 * Starts the notification watcher. Instead of polling on a timer,
 * listens for upsertTrenches events and triggers push checks immediately.
 * Also runs periodic receipt checks to clean dead tokens.
 */
export function startNotificationWatcher({ onError = () => {} } = {}) {
  let cycleCount = 0;
  let pendingTickets = [];

  onTokensInserted(async (updatedTabs) => {
    try {
      const { tickets } = await pollOnce({ tabs: updatedTabs, onError });
      if (tickets?.length) pendingTickets.push(...tickets);

      // Periodic receipt check
      cycleCount++;
      if (cycleCount >= RECEIPT_CHECK_INTERVAL && pendingTickets.length > 0) {
        cycleCount = 0;
        const ticketIds = pendingTickets.map((t) => t.ticketId);
        const ticketToDevice = new Map(pendingTickets.map((t) => [t.ticketId, t.deviceId]));
        pendingTickets = [];

        try {
          const invalidDevices = await checkReceipts(ticketIds, ticketToDevice);
          for (const deviceId of invalidDevices) {
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
  });

  console.log('[poller] Notification watcher started (event-driven)');
}
