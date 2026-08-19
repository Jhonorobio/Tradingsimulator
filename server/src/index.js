import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import marketRoutes from './routes/market.js';
import tradingRoutes from './routes/trading.js';
import notificationRoutes from './routes/notifications.js';
import { startPoller } from './services/poller.js';

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

app.listen(PORT, () => {
  console.log(`Trading Simulator server on http://localhost:${PORT}`);
  console.log(`SQLite db: ${path.join(process.cwd(), 'data', 'trading.db')}`);
});

// push notification watcher
startPoller(process.env.NOTIFY_INTERVAL_MIN || 5, {
  onError: (err) => console.error('[poller]', err?.message),
});
console.log('Push poller started (interval in minutes: ' + (process.env.NOTIFY_INTERVAL_MIN || 5) + ')');