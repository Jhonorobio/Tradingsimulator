# Meme Trading Simulator

Simulador de trading de memecoins sobre Solana construido con **Expo (React Native)** + **Node/Express**.

- **Dashboard** — balance simulado, posiciones abiertas/cerradas, historial y estadísticas.
- **GMGN Trenches** — tokens nuevos de launchpads vía `gmgn-cli` con filtros (presets safe / smart-money / strict, rangos, sort).
- **Precio & Market Cap** — calculados con la API de **Jupiter** (price API v2 + token API).
- **Info de token** (nombre, símbolo, logo, liquidez, holders) — desde **Dexscreener**.
- **Notificaciones push** — aviso cuando llegan tokens nuevos a Trenches que cumplen tus filtros (Expo Push Notifications).

## Estructura

```
├── server/          # Backend Node + Express + SQLite (node:sqlite)
│   ├── src/
│   │   ├── index.js
│   │   ├── db.js
│   │   ├── cli/gmgn.js        # wrapper de gmgn-cli
│   │   ├── services/          # jupiter, dexscreener, push, trading
│   │   └── routes/            # market, token, trading, notifications
│   └── package.json
├── app/             # App Expo (expo-router, TypeScript)
│   └── app/         # rutas: (tabs)/index=dashboard, trenches, settings, token/[address]
└── SKILL (1).md     # documentación de gmgn-cli market
```

## Requisitos

- Node.js >= 22.5 (usa `node:sqlite`)
- `gmgn-cli` (se instala como dependencia del server; el `postinstall` lo parchea para `GMGN_TIME_OFFSET`)

> **Parche de reloj (AUTH_TIMESTAMP_EXPIRED)**: si tu reloj del sistema va adelantado
> respecto al servidor de GMGN (valida firmas dentro de ±5s), el CLI falla con
> `AUTH_TIMESTAMP_EXPIRED`. El `postinstall` (`scripts/patch-gmgn-signer.js`) parchea
> automáticamente `dist/client/signer.js` de `gmgn-cli` para restar
> `process.env.GMGN_TIME_OFFSET` a `Date.now()/1000`. Arranca el server con `GMGN_TIME_OFFSET` en el `.env`.

## Backend

```bash
cd server
npm install
npm run dev          # http://localhost:4000
```

Endpoints principales:

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/market/trenches` | Tokens de Trenches con filtros (ver params) |
| GET | `/api/market/trending` | Tokens trending |
| GET | `/api/market/kline` | Velas OHLCV |
| GET | `/api/market/search` | Buscar token/address (vía Jupiter — gmgn-cli v1.5.2 no trae `market search`) |
| GET | `/api/token/:chain/:address` | Info combinada Jupiter + Dexscreener |
| GET | `/api/wallet/:deviceId` | Wallet (balance, gas config) |
| POST | `/api/trade/buy` | Compra simulada (precio Jupiter; fallback a Dexscreener para tokens de pump.fun) |
| POST | `/api/trade/sell` | Venta simulada |
| GET | `/api/portfolio/:deviceId` | Posiciones + P&L en vivo + stats |
| POST | `/api/notifications/subscribe` | Alta de subscripción push |
| GET | `/api/notifications/subscriptions/:deviceId` | Lista de suscripciones |

### Parámetros de `/api/market/trenches`

- `chain` — `sol` (por ahora) / `bsc` / `base` / `eth`
- `types` — `new_creation`, `near_completion`, `completed` (repetible)
- `filterPreset` — `safe`, `smart-money`, `strict`
- `sortBy` — `smart_degen_count`, `volume_24h`, `usd_market_cap`, `rug_ratio`, `created_timestamp`, ...
- `direction` — `asc` | `desc`
- `limit` — máx 80 por categoría
- Rangos server-side: `minVolume24h`, `maxVolume24h`, `minMarketcap`, `maxMarketcap`, `minSmartDegen`, `maxRugRatio`, `maxBundlerRate`, `maxInsiderRatio`, `maxCreated`, ...

## App Expo

```bash
cd app
npm install
npx expo start
```

> En el teléfono/emulador el server se detecta automáticamente desde la IP del Metro bundler.
> Si no, edítalo en **Settings → Server URL** (ej. `http://192.168.1.50:4000`), o definí
> `EXPO_PUBLIC_API_URL` en `app/.env` para fijar una URL (p. ej. tu server de Railway).

## Deploy del server en Railway

El repo es un monorepo (`app/` + `server/`). En Railway:

1. **New Project → Deploy from GitHub** y elegí el repo.
2. En el servicio creado, **Settings → Root Directory = `server`** (ahí está el `package.json`).
   El archivo `railway.json` del root ya configura build (Nixpacks), start command (`npm start`),
   healthcheck (`/api/health`) y el mount path (`/data`).
3. **Variables** (Settings → Variables):
   - `GMGN_API_KEY` y `GMGN_PRIVATE_KEY` (las mismas de `~/.config/gmgn/.env` local)
   - `GMGN_PROXY_URL=http://103.237.102.191:11111`
   - `GMGN_PROXY_KEY=gmgn_...` (la 2ª key de GMGN usada por el proxy de detalle/posiciones)
   - `GMGN_TIME_OFFSET=0` (el reloj de Railway está sincronizado con NTP; el parche del
     postinstall aplica el offset, pero aquí no hará falta)
   - `TRENCHES_CACHE_TTL=3`
   - `DATA_DIR=/data`
   - `PORT` lo asigna Railway solo.
4. **Volumen**: creá un **Volume** en el servicio y montalo en **`/data`** (el `requiredMountPath`
   ya lo exige). SQLite se guarda ahí y persiste entre deploys. Sin volumen, el estado se
   pierde en cada redeploy.
5. Deploy. La app apunta al server con `EXPO_PUBLIC_API_URL=https://<tu-servicio>.up.railway.app`
   o desde **Settings → Server URL**.

> El proxy GMGN (`103.237.102.191`) es tu forward proxy actual. Si Railway no puede alcanzarlo,
> GMGN cae a Dexscreener (detalle, mcap, posiciones) y Trenches dependería de ese proxy para
> autenticar. Ajustá `GMGN_PROXY_URL` según haga falta.

> **Fix SDK 57 + Expo Go (crash al cargar)**: `react-native-worklets` 0.10.1 (traído por `@expo/ui`) provoca un SIGSEGV en Expo Go al arrancar (issue expo/expo#48390). El proyecto incluye `app/metro.config.js` que hace stub de `react-native-worklets` (la app no lo usa directamente). Si lo actualizas/borras, vuelve a añadir el stub o baja `react-native-worklets` a 0.10.0.

Flujo de trading: `Trenches → token → comprar/vender` con presupuesto simulado y gas por operación.

## Config de notificaciones

En **Settings → Notificaciones**: activa, configura filtros y pulsa *Guardar*.
El backend sondea Trenches cada `NOTIFY_INTERVAL_MIN` minutos y envía push para tokens nuevos.
