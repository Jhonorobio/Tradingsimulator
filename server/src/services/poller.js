import { pushSubscriptions, notifiedTokens } from '../stores.js';
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
  p.types = sub.types || ['new_creation'];
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
  const subs = pushSubscriptions.filter((s) => s.enabled === 1 || s.enabled === true);
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

      const alreadyNotified = new Set(notifiedTokens.get(String(sub.id)) || []);

      for (const t of tokens) {
        if (!t.address || alreadyNotified.has(t.address)) continue;
        alreadyNotified.add(t.address);

        const list = notifiedTokens.get(String(sub.id)) || [];
        list.push(t.address);
        notifiedTokens.set(String(sub.id), list);

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
  setTimeout(run, 10_000).unref?.();
  return timer;
}
