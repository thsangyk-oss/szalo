# Szalo — Better Zalo

Two pieces:

- **`server/`** — a standalone Node bridge that holds the Zalo session, exposes a REST + Socket.IO API guarded by an API key, and ships an admin web UI for QR login and Cloudflare Tunnel control.
- **Desktop app** (Electron + React/Vite) — a thin client. On first launch you paste the server URL and API key into the in-app settings; everything else flows over that connection.

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Szalo desktop (you)     │  HTTP   │  Szalo server (anywhere)     │
│  - React/Vite UI         │ ──────► │  - Holds Zalo QR session     │
│  - Settings: URL + key   │  WSS    │  - REST + Socket.IO          │
│  - No node deps at run   │ ◄────── │  - Admin UI on /admin        │
└──────────────────────────┘         │  - Cloudflare Tunnel built-in│
                                     └──────────────────────────────┘
```

## Why split

- One Zalo account on the server, multiple desktop clients can connect.
- Server can run on a home box / VPS and stay logged in 24/7. The desktop app can quit any time.
- Optional Cloudflare Quick Tunnel (`*.trycloudflare.com`) gives a public URL for the server with no domain or account.

## Server

```bash
cd server
cp .env.example .env       # set API_KEY to a long random string
npm install
npm run dev                # tsx watch on port 13113 by default
```

Open `http://localhost:13113/admin` to:

- Paste the API key (matches `API_KEY` in `.env`)
- See the local URL + the public URL once the tunnel starts
- Generate a Zalo QR and log the server into your Zalo account
- Start / stop the Cloudflare tunnel (requires [`cloudflared`](https://github.com/cloudflare/cloudflared/releases) on `PATH`)

`.env` keys:

| Key | Default | Notes |
| --- | --- | --- |
| `PORT` | `13113` | Any 1–65535. (`113113` isn't a valid TCP port.) |
| `API_KEY` | — required | Long random string. The server refuses to start without one. |
| `CLIENT_ORIGIN` | `*` | Or a comma-separated allow-list. `*` is the easy choice for desktop clients. |
| `DATA_DIR` | `./.zalo-manager` | Where session, cache, and uploads live. |

The session, conversations cache, and uploads are persisted under `DATA_DIR`. Logging in once survives restarts; logging out or wiping the dir requires a fresh QR.

### Auth model

Every `/api/*` route except the public health probe (`/api/health/ping`) requires the API key, sent as one of:

- `x-api-key: <key>` header
- `Authorization: Bearer <key>` header
- `?api_key=<key>` query param (used for `<img>` tags fetching attachments)

Socket.IO connections pass the key as `auth.apiKey` in the handshake.

## Desktop app

```bash
npm install
npm run dev                # vite + electron, opens the window
# or
npm run pack               # builds the app + electron-builder --dir
npm run dist               # builds an installer
```

On first launch the app shows a settings card. Enter the server URL (e.g. `http://192.168.1.50:13113` or the tunnel's `https://xxx.trycloudflare.com`) and the API key. Settings live in `localStorage`; click the gear icon in the icon rail to change them later.

The Electron main process no longer embeds the server — it's just a renderer shell with a tray icon, bubble dock, and notifications.

## Project layout

```
.
├── electron/           # Electron main + preload, build glue
├── server/             # Standalone server (own package.json + .env)
│   ├── index.ts        # Express + Socket.IO + Zalo bridge
│   ├── tunnel.ts       # cloudflared child-process manager
│   └── admin.html      # Admin UI (vanilla, served at /admin)
├── src/                # React frontend
│   ├── App.tsx         # Main shell
│   ├── Bubble.tsx      # Bubble dock + panel
│   ├── SettingsScreen.tsx  # First-run + change settings UI
│   ├── settings.ts     # localStorage-backed connection settings
│   └── socket.ts       # Live socket factory tied to settings
└── package.json        # Root workspace
```

## Scripts (root)

| Script | What it does |
| --- | --- |
| `npm run dev` | Server + Vite + Electron in parallel (hot-reload all three) |
| `npm run build` | Type-check + Vite production build into `build/` |
| `npm run build:server` | Bundle server to `electron/server.cjs` (only used if you want to embed it back in Electron) |
| `npm run lint` | ESLint over the frontend + server |
| `npm run pack` / `dist` | Electron-builder targets |
| `npm run start:server` | Production-mode server (no watcher) |

## License

MIT — built on [`zca-js`](https://github.com/RFS-ADRENO/zca-js) for the Zalo protocol layer.
