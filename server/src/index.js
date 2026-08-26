import 'dotenv/config';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import marketRoutes from './routes/market.js';
import tradingRoutes from './routes/trading.js';
import notificationRoutes from './routes/notifications.js';
import { startNotificationWatcher } from './services/poller.js';
import { startTrenchesRefresher } from './services/trenches-refresher.js';
import { ensureCalibrated } from './services/gmgn-clock.js';
import { initWebSocket } from './services/ws-server.js';
import { startPricePoller } from './services/ws-price-poller.js';

const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/market', marketRoutes);
app.use('/api', tradingRoutes);
app.use('/api/notifications', notificationRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// unified error handler
app.use((err, _req, res, _next) => {
  const status = err?.status || 500;
  if (process.env.NODE_ENV !== 'production') console.error('[server]', err);
  res.status(status).json({ error: err?.message || 'Internal error' });
});

// HTTP + WebSocket server
const server = createServer(app);
initWebSocket(server);
startPricePoller();

server.listen(PORT, () => {
  console.log(`Trading Simulator server on http://localhost:${PORT}`);
  console.log(`WebSocket server on ws://localhost:${PORT}/ws`);
  console.log(`Data dir: ${process.env.DATA_DIR || 'data/'}`);
});

// push notification watcher (event-driven, triggered by upsertTrenches)
startNotificationWatcher({
  onError: (err) => console.error('[poller]', err?.message),
});

// Auto-calibrate GMGN clock from Date header, then start refresher
ensureCalibrated().then(() => {
  startTrenchesRefresher(process.env.TRENCHES_REFRESH_SEC, {
    onError: (err) => console.error('[trenches-refresher]', err?.message),
  }).then((info) => {
    console.log(
      `Trenches refresher started: ${info.workers} worker(s), egress IPs=${JSON.stringify(info.egressIps)}, active tabs=${JSON.stringify(info.pinnedTabs)}, skipped tabs=${JSON.stringify(info.skippedTabs)}, mode=${info.mode}`
    );
  });
});
