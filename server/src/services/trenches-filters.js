/**
 * Server-side owner of the Trenches filter configuration.
 * The app only saves/loads the raw config (per tab: field -> min/max in UI
 * units); the server converts it into GMGN CLI params, so no GMGN-specific
 * logic lives in the app.
 */

export const TRENCH_TABS = ['new_creation', 'near_completion', 'completed'];

export const DEFAULT_TRENCH_PARAMS = { chain: 'sol', types: ['new_creation'], limit: 50 };

// Field key -> interpretation scale. Mirrors what the app renders.
const FIELD_SCALES = {
  progress: 'percent',
  created: 'minute',
  liquidity: 'thousand',
  marketcap: 'thousand',
  topHolderRate: 'percent',
  creatorBalanceRate: 'percent',
  totalFee: 'none',
  bundlerRate: 'percent',
  rugRatio: 'percent',
  insiderRatio: 'percent',
  entrapmentRatio: 'percent',
  privateVaultHoldRate: 'percent',
  top70SniperHoldRate: 'percent',
  botDegenRate: 'percent',
  freshWalletRate: 'percent',
  creatorCreatedOpenRatio: 'percent',
  volume24h: 'none',
  netBuy24h: 'none',
  swaps24h: 'none',
  buys24h: 'none',
  sells24h: 'none',
  visitingCount: 'none',
  holderCount: 'none',
  botCount: 'none',
  smartDegen: 'none',
  renowned: 'none',
  creatorCreatedCount: 'none',
  creatorCreatedOpenCount: 'none',
  xFollowers: 'none',
  twitterRenameCount: 'none',
  tgCallCount: 'none',
};

function capFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseValue(raw, scale) {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (isNaN(n)) return undefined;
  switch (scale) {
    case 'percent':
      return n / 100;
    case 'thousand':
      return n * 1000;
    case 'minute':
      return `${n}m`;
    default:
      return n;
  }
}

/**
 * Builds GMGN trenches params for a tab from a saved device config of shape
 * Record<TabKey, { [field]: { min, max } }>. Falls back to the default query.
 */
export function buildParamsFromConfig(config, tab) {
  const p = { chain: 'sol', types: [tab], limit: 50 };
  const vals = config?.[tab];
  if (!vals || typeof vals !== 'object') return p;
  for (const [key, scale] of Object.entries(FIELD_SCALES)) {
    const v = vals[key];
    if (!v || typeof v !== 'object') continue;
    const minV = parseValue(v.min, scale);
    const maxV = parseValue(v.max, scale);
    if (minV !== undefined) p[`min${capFirst(key)}`] = minV;
    if (maxV !== undefined) p[`max${capFirst(key)}`] = maxV;
  }
  return p;
}