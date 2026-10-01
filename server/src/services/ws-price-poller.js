import { fetchShotgunInfo } from './shotgun-token.js';
import { getTokenInfo as getDexTokenInfo } from './dexscreener.js';
import { broadcast, getSubscriptions } from './ws-server.js';

/**
 * Background price poller for WebSocket-subscribed tokens.
 * When clients subscribe to `token:{chain}:{address}`, this module polls
 * shotgun.fun for that token's price every 2s and broadcasts updates
 * (Dexscreener as fallback when the shotgun session is unavailable).
 * Stops polling when no more subscribers exist for a token.
 */

const POLL_INTERVAL_MS = 2000;

export function startPricePoller() {
  setInterval(pollSubscribedTokens, POLL_INTERVAL_MS);
}

async function pollSubscribedTokens() {
  const subs = getSubscriptions();
  // Find all token:* subscriptions
  const tokenTopics = [];
  for (const topic of subs) {
    if (topic.startsWith('token:')) tokenTopics.push(topic);
  }

  // Poll each subscribed token
  for (const topic of tokenTopics) {
    const key = topic.slice('token:'.length); // "chain:address"
    const [chain, address] = key.split(':');
    if (!chain || !address) continue;
    await fetchAndBroadcast(chain, address, topic);
  }
}

async function fetchAndBroadcast(chain, address, topic) {
  try {
    // shotgun.fun is Solana-only; other chains go straight to Dexscreener.
    let info = chain === 'solana' || chain === 'sol' ? await fetchShotgunInfo(address) : null;
    if (info?.price == null) info = await getDexTokenInfo(address);
    if (!info) return;
    broadcast(topic, {
      event: 'token_price',
      chain,
      address,
      data: {
        price: info.price ?? null,
        marketCap: info.marketCap ?? null,
        liquidity: info.liquidity ?? null,
        volume24h: info.volume24h ?? null,
        holders: info.holders ?? null,
        priceChange: info.priceChange ?? null,
      },
    });
  } catch {
    // ignore — client will retry
  }
}

/**
 * Broadcast SOL price to all sol_price subscribers.
 * Called externally (e.g., from the dashboard poll or a background loop).
 */
export function broadcastSolPrice(price) {
  broadcast('sol_price', { event: 'sol_price', data: { price } });
}
