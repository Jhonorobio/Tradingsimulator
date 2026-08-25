import { runMarket } from './gmgn.js';
import { fetchTrenchesHttp } from './trenches-http.js';
import { cacheKey, withCache } from '../services/cache.js';
import { upsertTrenches } from '../services/trenches-store.js';
import { getOffset } from '../services/gmgn-clock.js';

export const CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
export const TRENCH_TYPES = ['new_creation', 'near_completion', 'completed'];
const PRESETS = new Set(['safe', 'smart-money', 'strict']);
const SORT_FIELDS = new Set([
  'smart_degen_count', 'renowned_count', 'volume_24h', 'volume_1h', 'swaps_24h', 'swaps_1h',
  'rug_ratio', 'holder_count', 'usd_market_cap', 'created_timestamp',
]);

const RANGE_FLAGS = {
  minVolume24h: 'min-volume-24h', maxVolume24h: 'max-volume-24h',
  minNetBuy24h: 'min-net-buy-24h', maxNetBuy24h: 'max-net-buy-24h',
  minSwaps24h: 'min-swaps-24h', maxSwaps24h: 'max-swaps-24h',
  minBuys24h: 'min-buys-24h', maxBuys24h: 'max-buys-24h',
  minSells24h: 'min-sells-24h', maxSells24h: 'max-sells-24h',
  minVisitingCount: 'min-visiting-count', maxVisitingCount: 'max-visiting-count',
  minProgress: 'min-progress', maxProgress: 'max-progress',
  minMarketcap: 'min-marketcap', maxMarketcap: 'max-marketcap',
  minLiquidity: 'min-liquidity', maxLiquidity: 'max-liquidity',
  minCreated: 'min-created', maxCreated: 'max-created',
  minHolderCount: 'min-holder-count', maxHolderCount: 'max-holder-count',
  minTopHolderRate: 'min-top-holder-rate', maxTopHolderRate: 'max-top-holder-rate',
  minRugRatio: 'min-rug-ratio', maxRugRatio: 'max-rug-ratio',
  minBundlerRate: 'min-bundler-rate', maxBundlerRate: 'max-bundler-rate',
  minInsiderRatio: 'min-insider-ratio', maxInsiderRatio: 'max-insider-ratio',
  minEntrapmentRatio: 'min-entrapment-ratio', maxEntrapmentRatio: 'max-entrapment-ratio',
  minPrivateVaultHoldRate: 'min-private-vault-hold-rate', maxPrivateVaultHoldRate: 'max-private-vault-hold-rate',
  minTop70SniperHoldRate: 'min-top70-sniper-hold-rate', maxTop70SniperHoldRate: 'max-top70-sniper-hold-rate',
  minBotCount: 'min-bot-count', maxBotCount: 'max-bot-count',
  minBotDegenRate: 'min-bot-degen-rate', maxBotDegenRate: 'max-bot-degen-rate',
  minFreshWalletRate: 'min-fresh-wallet-rate', maxFreshWalletRate: 'max-fresh-wallet-rate',
  minTotalFee: 'min-total-fee', maxTotalFee: 'max-total-fee',
  minSmartDegen: 'min-smart-degen-count', maxSmartDegen: 'max-smart-degen-count',
  minRenowned: 'min-renowned-count', maxRenowned: 'max-renowned-count',
  minCreatorBalanceRate: 'min-creator-balance-rate', maxCreatorBalanceRate: 'max-creator-balance-rate',
  minCreatorCreatedCount: 'min-creator-created-count', maxCreatorCreatedCount: 'max-creator-created-count',
  minCreatorCreatedOpenCount: 'min-creator-created-open-count', maxCreatorCreatedOpenCount: 'max-creator-created-open-count',
  minCreatorCreatedOpenRatio: 'min-creator-created-open-ratio', maxCreatorCreatedOpenRatio: 'max-creator-created-open-ratio',
  minXFollowers: 'min-x-follower', maxXFollowers: 'max-x-follower',
  minTwitterRenameCount: 'min-twitter-rename-count', maxTwitterRenameCount: 'max-twitter-rename-count',
  minTgCallCount: 'min-tg-call-count', maxTgCallCount: 'max-tg-call-count',
};

function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  return typeof v === 'string' ? v.trim() : v;
}

/**
 * Builds whitelisted CLI args for `market trenches`.
 * @param {object} p - params: chain, types[], filterPreset, sortBy, direction, limit, launchpadPlatform[], range flags...
 */
export function buildTrenchesArgs(p) {
  const args = [];
  const chain = clean(p.chain) || 'sol';
  if (!CHAINS.has(chain)) throw Object.assign(new Error(`Unsupported chain: ${chain}`), { status: 400 });
  args.push('--chain', chain);

  const rawTypes = [].concat(clean(p.types) ?? []).filter(Boolean);
  const types = rawTypes.length ? rawTypes : TRENCH_TYPES;
  for (const t of types) {
    if (!new Set(TRENCH_TYPES).has(t)) throw Object.assign(new Error(`Unsupported type: ${t}`), { status: 400 });
    args.push('--type', t);
  }

  if (p.launchpadPlatform) {
    for (const plat of [].concat(clean(p.launchpadPlatform)).filter(Boolean)) args.push('--launchpad-platform', plat);
  }
  if (p.filterPreset) {
    if (!PRESETS.has(p.filterPreset)) throw Object.assign(new Error(`Unsupported filterPreset: ${p.filterPreset}`), { status: 400 });
    args.push('--filter-preset', p.filterPreset);
  }
  if (p.sortBy) {
    if (!SORT_FIELDS.has(p.sortBy)) throw Object.assign(new Error(`Unsupported sortBy: ${p.sortBy}`), { status: 400 });
    args.push('--sort-by', p.sortBy);
  }
  if (p.direction) args.push('--direction', p.direction === 'asc' ? 'asc' : 'desc');

  const limit = Math.min(Number(p.limit) || 80, 80);
  args.push('--limit', String(limit));

  for (const [key, flag] of Object.entries(RANGE_FLAGS)) {
    if (p[key] != null && p[key] !== '') args.push(`--${flag}`, String(p[key]));
  }
  return args;
}

export async function fetchTrenches(params, opts = {}) {
  const args = buildTrenchesArgs(params);
  // force=true bypasses the TTL so a background refresher can warm the cache
  // (still dedupes concurrent calls and still writes back to disk).
  const ttl = opts.force ? 0 : (opts.ttl ?? (Number(process.env.TRENCHES_CACHE_TTL) || 60));

  // Dedicated per-connection cooldown. Trenches can be pinned to one proxy+
  // key per category (TRENCHES_PROXIES/TRENCHES_KEYS); a rate limit on one
  // connection must never block the others. When no proxy is configured the
  // shared IP cooldown below still applies.
  const connKey = `${opts.proxy ?? ''}|${opts.apiKey ?? ''}`;
  if (opts.proxy || opts.apiKey) {
    const until = pairCooldowns.get(connKey);
    if (Date.now() < until) {
      const err = new Error(`GMGN rate limited; retry after ${new Date(until).toISOString()}`);
      err.status = 429;
      throw err;
    }
  }

  // Legacy single-IP cooldown (gmgn-cli path, no proxy). The ban is per-IP, so
  // once we get a 429 we refuse to call gmgn-cli again until the reported
  // reset time. Otherwise each retry during the ban extends it by +5s (up to
  // 5 min) — the exact loop that kept the IP banned.
  if (!opts.proxy && !opts.apiKey && Date.now() < ipCooldownUntil) {
    const err = new Error(
      `GMGN rate limited; retry after ${new Date(ipCooldownUntil).toISOString()}`
    );
    err.status = 429;
    throw err;
  }

  return withCache(cacheKey('trenches', args.join(' ')), ttl, async () => {
    try {
      // Dedicated trenches key (GMGN_API_KEY) → fetch directly over HTTPS
      // (openapi.gmgn.ai), bypassing gmgn-cli and any proxy. Falls back to the
      // pinned proxy+key when one is passed, then to gmgn-cli when no key is
      // configured at all.
      const apiKey = opts.apiKey || process.env.GMGN_API_KEY || '';
      const useHttp = Boolean(apiKey);
      const json = useHttp
        ? await fetchTrenchesHttp(args, { proxy: opts.proxy || '', apiKey })
        : await runMarket('trenches', args);
      const data = json?.data ?? json ?? {};
      const result = {
        new_creation: data.new_creation ?? [],
        // CLI v1.5.2 returns `near_completion` directly (older versions used `pump`).
        near_completion: data.near_completion ?? data.pump ?? [],
        completed: data.completed ?? [],
      };
      upsertTrenches(result, opts.source || 'refresher');
      return result;
    } catch (err) {
      const resetMs = parseRateLimitReset(err?.message);
      const offsetMs = getOffset() * 1000;
      if (opts.proxy || opts.apiKey) {
        if (resetMs) {
          pairCooldowns.set(connKey, Math.max(pairCooldowns.get(connKey) || 0, resetMs + offsetMs + 10_000));
        } else if (String(err?.message).includes('429')) {
          // Soft rate limits (HTTP path) don't carry a reset time; wait a short
          // window so the IP isn't hammered, but don't wedge a category for 5
          // minutes over a transient limit. Real bans report a reset time above.
          pairCooldowns.set(connKey, Math.max(pairCooldowns.get(connKey) || 0, Date.now() + 60_000));
        }
      } else if (resetMs) {
        // The system clock runs ahead of GMGN (GMGN_TIME_OFFSET), so the
        // reported reset time must be shifted forward or the cooldown expires
        // too early and the retry lands during the ban, extending it.
        ipCooldownUntil = Math.max(ipCooldownUntil, resetMs + offsetMs + 10_000);
      } else if (String(err?.message).includes('429') || String(err?.message).includes('RATE_LIMIT')) {
        // No reset timestamp in the message; assume the default ~5 min ban.
        ipCooldownUntil = Math.max(ipCooldownUntil, Date.now() + 300_000);
      }
      throw err;
    }
  });
}

const pairCooldowns = new Map();
let ipCooldownUntil = 0;

/**
 * Parses `Rate limit resets at 2026-08-19 14:15:25 GMT-05:00` out of the
 * gmgn-cli error message and returns the reset time in ms since epoch.
 */
function parseRateLimitReset(msg) {
  const m = /resets at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT([+-]\d{2}:\d{2})/.exec(msg || '');
  if (!m) return null;
  const tz = m[3].replace(':', '');
  const ts = Date.parse(`${m[1]}T${m[2]}${tz}`);
  return Number.isFinite(ts) ? ts : null;
}