import { db } from '../db.js';
import { fetchTrenches } from '../cli/args.js';
import { sendPush } from './push.js';

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

function deriveParams(sub) {
  const p = { chain: sub.chain };
  try {
    p.types = JSON.parse(sub.types);
  } catch {
    p.types = ['new_creation'];
  }
  if (sub.filter_preset) p.filterPreset = sub.filter_preset;
  if (sub.min_smart_degen != null) p.minSmartDegen = sub.min_smart_degen;
  if (sub.min_volume_24h != null) p.minVolume24h = sub.min_volume_24h;
  if (sub.max_rug_ratio != null) p.maxRugRatio = sub.max_rug_ratio;
  return p;
}

/**
 * Polls GMGN Trenches once for every enabled subscription and pushes
 * notifications for tokens that haven't been notified for that subscription yet.
 */
export async function pollOnce({ onError = () => {} } = {}) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE enabled = 1').all();
  if (!subs.length) return { checked: 0, notified: 0 };

  let notified = 0;
  for (const sub of subs) {
    try {
      const result = await fetchTrenches(deriveParams(sub));
      const tokens = [
        ...(result.new_creation ?? []).map((t) => ({ ...t, _type: 'new_creation' })),
        ...(result.near_completion ?? []).map((t) => ({ ...t, _type: 'near_completion' })),
        ...(result.completed ?? []).map((t) => ({ ...t, _type: 'completed' })),
      ];

      const markNotified = db.prepare(
        'INSERT OR IGNORE INTO notified_tokens (subscription_id, token_address) VALUES (?, ?)'
      );
      const isNotified = db.prepare(
        'SELECT 1 FROM notified_tokens WHERE subscription_id = ? AND token_address = ?'
      );

      const alreadyNotified = new Set(
        db.prepare('SELECT token_address FROM notified_tokens WHERE subscription_id = ?').all(sub.id)
          .map((r) => r.token_address)
      );

      for (const t of tokens) {
        if (!t.address || alreadyNotified.has(t.address)) continue;
        alreadyNotified.add(t.address);
        markNotified.run(sub.id, t.address);

        const title = `${t.symbol || t.name || 'Token'} — ${t._type.replace('_', ' ')}`;
        const body = [
          `MCap ${fmtUsd(t.usd_market_cap ?? t.market_cap)}`,
          `Liq ${fmtUsd(t.liquidity)}`,
          `Vol24h ${fmtUsd(t.volume_24h ?? t.volume)}`,
          `SM ${fmtNum(t.smart_degen_count)}`,
          `Rug ${t.rug_ratio != null ? t.rug_ratio.toFixed(2) : 'n/a'}`,
        ].join(' · ');
        const res = await sendPush(sub.push_token, {
          title,
          body,
          data: { address: t.address, chain: sub.chain, symbol: t.symbol, type: t._type },
        });
        if (res?.data?.status === 'error') {
          onError(new Error(`Push failed: ${res.data.message}`));
        } else {
          notified += 1;
        }
      }
    } catch (err) {
      onError(err);
    }
  }
  return { checked: subs.length, notified };
}

export function startPoller(intervalMinutes, { onError = () => {} } = {}) {
  const intervalMs = Math.max(1, Number(intervalMinutes) || 5) * 60_000;
  const run = async () => {
    try {
      await pollOnce({ onError });
    } catch (err) {
      onError(err);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  // first run shortly after boot
  setTimeout(run, 10_000).unref?.();
  return timer;
}