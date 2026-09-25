/**
 * Server-side owner of the Trenches filter configuration.
 * The app only saves/loads the raw config (per tab: field -> min/max in UI
 * units); the server converts it into GMGN CLI params, so no GMGN-specific
 * logic lives in the app.
 */

export const TRENCH_TABS = ['new_creation', 'completed'];

export const DEFAULT_TRENCH_PARAMS = { chain: 'sol', types: ['new_creation'], limit: 50 };

// Map tab name → GMGN chain
const TAB_CHAIN = {
  new_creation: 'sol',
  completed: 'sol',
};

// Map tab name → GMGN trench type (the API category parameter)
const TAB_TYPE = {
  new_creation: 'new_creation',
  completed: 'completed',
};

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
  const chain = TAB_CHAIN[tab] || 'sol';
  const type = TAB_TYPE[tab] || 'new_creation';
  const p = { chain, types: [type], limit: 50 };

  // SOL also needs explicit launchpad_platform for trenches to return all tokens
  if (chain === 'sol') {
    p.launchpadPlatform = [
      'Pump.fun', 'pump_mayhem', 'pump_mayhem_agent', 'pump_agent',
      'letsbonk', 'bonkers', 'bags', 'memoo', 'liquid', 'bankr',
      'zora', 'surge', 'anoncoin', 'moonshot_app', 'wendotdev', 'heaven',
      'sugar', 'token_mill', 'believe', 'trendsfun', 'trends_fun',
      'jup_studio', 'Moonshot', 'boop', 'ray_launchpad',
      'meteora_virtual_curve', 'xstocks', 'stonkfun',
      'pool_ray', 'pool_meteora', 'pool_pump_amm', 'pool_orca',
    ];
  }

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