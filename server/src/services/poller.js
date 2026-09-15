import { notificationConfig, notifiedTokens, notificationHistory, winners } from '../stores.js';
import { getAllTokens, storeSize, onTokensInserted } from './trenches-store.js';
import { sendPush, checkReceipts } from './push.js';
import { broadcast } from './ws-server.js';
import { getSnapshots, getFirstSnapshot, getTrackStarted } from './token-snapshots.js';

const CATEGORIES = ['new_creation', 'completed', 'new_creation_robinhood', 'completed_robinhood', 'new_creation_bsc', 'completed_bsc'];

// How many insert cycles between receipt checks (e.g., 60 ≈ 5 min depending on frequency)
const RECEIPT_CHECK_INTERVAL = 60;

const PERCENTAGE_FIELDS = ['bot_degen_rate', 'fresh_wallet_rate', 'rug_ratio', 'bundler_trader_amount_rate', 'entrapment_ratio'];

function matchesFilters(token, filters) {
  if (!filters || typeof filters !== 'object') return true;
  for (const [field, range] of Object.entries(filters)) {
    if (!range || typeof range !== 'object') continue;
    const raw = token[field];
    if (raw == null) continue;
    const val = Number(raw);
    if (isNaN(val)) continue; // no data = skip filter (don't block)
    const isPct = PERCENTAGE_FIELDS.includes(field);
    const min = isPct && range.min != null ? range.min / 100 : range.min;
    const max = isPct && range.max != null ? range.max / 100 : range.max;
    if (min != null && val < min) return false;
    if (max != null && val > max) return false;
  }
  return true;
}

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

const WINNERS_MAX = 100;

function calcGainFromSnapshots(snapshots, fallbackMcap) {
  if (!snapshots || snapshots.length === 0) return 0;
  const first = snapshots[0];
  const firstMcap = first?.usd_market_cap ?? first?.market_cap ?? fallbackMcap;
  if (!firstMcap || firstMcap <= 0) return 0;
  const maxMcap = snapshots.reduce((max, s) => {
    const v = s.usd_market_cap ?? s.market_cap;
    return v != null && v > max ? v : max;
  }, firstMcap);
  return ((maxMcap - firstMcap) / firstMcap) * 100;
}

function calcTimeToPeakMinutes(snapshots) {
  if (!snapshots || snapshots.length < 2) return 999;
  const firstTime = new Date(snapshots[0].t).getTime();
  let maxMcap = 0;
  let peakTime = firstTime;
  for (const s of snapshots) {
    const v = s.usd_market_cap ?? s.market_cap;
    if (v != null && v > maxMcap) {
      maxMcap = v;
      peakTime = new Date(s.t).getTime();
    }
  }
  return (peakTime - firstTime) / 60000;
}

function checkAndSaveWinner(item) {
  const snapshots = item.snapshots;
  if (!snapshots || snapshots.length < 2) return;

  const gain = calcGainFromSnapshots(snapshots, item.mcap);
  const timeToPeak = calcTimeToPeakMinutes(snapshots);

  if (gain < 100 || timeToPeak < 2) return;

  // Check if already in winners
  const existing = winners.getAll();
  if (existing.some((w) => w.address === item.address && w.category === item.category)) return;

  // Add to winners
  winners.add({
    address: item.address,
    chain: item.chain,
    symbol: item.symbol,
    name: item.name,
    category: item.category,
    mcap: item.mcap,
    logo: item.logo,
    gain_pct: gain,
    time_to_peak_minutes: timeToPeak,
    snapshots,
    added_at: new Date().toISOString(),
  });

  // Cap at 100, remove oldest
  const all = winners.getAll();
  if (all.length > WINNERS_MAX) {
    const sorted = all.sort((a, b) => (a.added_at || '').localeCompare(b.added_at || ''));
    const toRemove = sorted.slice(0, all.length - WINNERS_MAX);
    for (const old of toRemove) {
      winners.delete((e) => e.id === old.id);
    }
  }
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
      const historyKey = `history:${entry.device_id}:${cat}`;
      const alreadyInHistory = new Set(notifiedTokens.get(historyKey) || []);
      const catFilters = entry.filters?.[cat];

      const tokens = getTokensFromStore(cat);

      for (const t of tokens) {
        if (!t.address) continue;

        // Always add token to history (once per token, regardless of notification filter)
        if (!alreadyInHistory.has(t.address)) {
          alreadyInHistory.add(t.address);

          const hList = notifiedTokens.get(historyKey) || [];
          hList.push(t.address);
          if (hList.length > 2000) hList.shift();
          notifiedTokens.set(historyKey, hList);

          const historyEntry = {
            device_id: entry.device_id,
            address: t.address,
            chain: t.chain || 'sol',
            symbol: t.symbol || null,
            name: t.name || null,
            category: cat,
            mcap: t.usd_market_cap ?? t.market_cap ?? null,
            liq: t.liquidity ?? null,
            vol24h: t.volume_24h ?? null,
            logo: t.logo || null,
            smart_degen_count: t.smart_degen_count ?? null,
            renowned_count: t.renowned_count ?? null,
            fresh_wallet_rate: t.fresh_wallet_rate ?? null,
            bot_degen_count: t.bot_degen_count ?? null,
            bot_degen_rate: t.bot_degen_rate ?? null,
            rug_ratio: t.rug_ratio ?? null,
            bundler_rate: t.bundler_rate ?? t.bundler_trader_amount_rate ?? null,
            entrapment_ratio: t.entrapment_ratio ?? null,
            snapshots: getSnapshots(t.address, cat),
            entered_at: getTrackStarted(t.address, cat),
            notified_at: new Date().toISOString(),
            filter_matched_at: null,
          };
          const saved = notificationHistory.add(historyEntry);
          broadcast(`notifications:${entry.device_id}`, { event: 'notification_new', data: saved });

          // Cap history at 300 entries per chain
          const allEntries = notificationHistory.getAll();
          const chainEntries = allEntries.filter((e) => e.chain === (t.chain || 'sol'));
          if (chainEntries.length > 300) {
            const toRemove = chainEntries.slice(0, chainEntries.length - 300);
            for (const old of toRemove) {
              notificationHistory.delete((e) => e.id === old.id);
            }
          }

          // Check if this token is a winner (100%+ gain, 2+ min to peak)
          checkAndSaveWinner(historyEntry);
        }

        // Only send push notification if token matches the filter
        if (!alreadyNotified.has(t.address) && matchesFilters(t, catFilters)) {
          alreadyNotified.add(t.address);

          // Update history entry with filter match time
          const allEntries = notificationHistory.getAll();
          const histEntry = allEntries.find((e) => e.address === t.address && e.category === cat && e.device_id === entry.device_id);
          if (histEntry && !histEntry.filter_matched_at) {
            histEntry.filter_matched_at = new Date().toISOString();
            notificationHistory.set(histEntry.id, histEntry);
          }

          const nList = notifiedTokens.get(notifiedKey) || [];
          nList.push(t.address);
          if (nList.length > 500) nList.shift();
          notifiedTokens.set(notifiedKey, nList);

          const title = `${t.symbol || t.name || 'Token'} — ${cat.replace('_', ' ')}`;
          const body = [
            `MCap ${fmtUsd(t.usd_market_cap ?? t.market_cap)}`,
            `Vol24h ${fmtUsd(t.volume_24h)}`,
            `SM ${fmtNum(t.smart_degen_count)}`,
            `KOL ${fmtNum(t.renowned_count)}`,
            `Fresh ${t.fresh_wallet_rate != null ? (t.fresh_wallet_rate * 100).toFixed(0) + '%' : 'n/a'}`,
            `Bot ${fmtNum(t.bot_degen_count)} (${t.bot_degen_rate != null ? (t.bot_degen_rate * 100).toFixed(1) + '%' : 'n/a'})`,
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

  // Migrate existing history entries to winners
  migrateHistoryToWinners();
}

function migrateHistoryToWinners() {
  try {
    const entries = notificationHistory.getAll();
    let added = 0;
    for (const entry of entries) {
      const existing = winners.getAll();
      if (existing.some((w) => w.address === entry.address && w.category === entry.category)) continue;
      checkAndSaveWinner(entry);
      const after = winners.getAll();
      if (after.length > existing.length) added++;
    }
    if (added > 0) console.log(`[poller] Migrated ${added} winners from history`);
  } catch (err) {
    console.error('[poller] migrateHistoryToWinners error:', err.message);
  }
}
