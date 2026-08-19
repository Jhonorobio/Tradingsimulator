import { runMarket } from './gmgn.js';
import { cacheKey, withCache } from '../services/cache.js';

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

export async function fetchTrenches(params) {
  const args = buildTrenchesArgs(params);
  return withCache(cacheKey('trenches', args.join(' ')), 60, async () => {
    const json = await runMarket('trenches', args);
    const data = json?.data ?? json ?? {};
    return {
      new_creation: data.new_creation ?? [],
      // CLI v1.5.2 returns `near_completion` directly (older versions used `pump`).
      near_completion: data.near_completion ?? data.pump ?? [],
      completed: data.completed ?? [],
    };
  });
}