# Szalo — Better Zalo

Two pieces:

- **`server/`** — a standalone Node bridge that holds the Zalo session, generates its own API key, and ships an admin web UI (password-protected) for QR login, key management, and Cloudflare Tunnel control.
- **Desktop app** (Electron + React/Vite) — a thin client. On first launch you paste the server URL and the API key (copied from the admin UI) into the in-app settings; everything else flows over that connection.

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Szalo desktop (you)     │  HTTP   │  Szalo server (anywhere)     │
│  - React/Vite UI         │ ──────► │  - Holds Zalo QR session     │
│  - Settings: URL + key   │  WSS    │  - Generates API key         │
│  - No node deps at run   │ ◄────── │  - /admin (password 123456)  │
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
npm install
npm run dev                # tsx watch on port 13113 by default
```

On first boot the server creates `zalodata.json` (under `DATA_DIR`, default `.zalo-manager/`) with:

- A freshly generated **API key** (32 random bytes, hex)
- The default **admin password** `123456` (scrypt-hashed)

Open `http://localhost:13113/admin` and log in with `123456`. The admin panel has 5 tabs:

- **📊 Dashboard** — server URL, public URL (if tunnel running), Zalo QR login, conversation counts.
- **🔑 API Keys** — one row per client. Create / rename / disable / revoke keys independently. Each desktop machine gets its own named key so you can audit and revoke selectively.
- **👁 Connection Watch** — live list of who's connected (key name + IP + when), plus a real-time activity feed of every `connect / open chat / send message / Zalo login` action. History persists to `activity.json` (capped at 5,000 events).
- **🌐 Cloudflare Tunnel** — two modes:
    - **Quick** — one-click `*.trycloudflare.com` URL (no account needed).
    - **Named** — bind to your own domain. Click *Authorize* (runs `cloudflared tunnel login`, opens a Cloudflare page to pick the zone), then enter tunnel name + domain + subdomain. Server creates the tunnel, routes DNS, and runs it.
- **🔒 Tài khoản admin** — change password (3 fields: current + new + confirm).

`.env` keys (all optional — server runs without an `.env` at all):

| Key | Default | Notes |
| --- | --- | --- |
| `PORT` | `13113` | Any 1–65535. (`113113` isn't a valid TCP port.) |
| `CLIENT_ORIGIN` | `*` | Or a comma-separated allow-list. `*` is the easy choice for desktop clients. |
| `DATA_DIR` | `./.zalo-manager` | Where session, cache, uploads, and `zalodata.json` live. |
| `DB_FILE` | `<DATA_DIR>/zalodata.json` | Override the JSON store path. |

The session, conversations cache, uploads, `zalodata.json`, and `activity.json` are persisted under `DATA_DIR`. Logging in once survives restarts; deleting `zalodata.json` regenerates the API keys and resets the admin password to `123456`.

### Auth model — two distinct credentials

| Endpoint group | Required credential | How |
| --- | --- | --- |
| `/api/health/ping`, `/admin`, `/api/admin/login` | none (public) | — |
| `/api/admin/*` (manage keys / password / tunnel / activity) | **admin session token** | header `x-admin-token: <token>` (issued by `POST /api/admin/login`) |
| All other `/api/*` + Socket.IO | **API key** | `x-api-key: <key>` header / `Authorization: Bearer <key>` / `?api_key=<key>` |

The two are kept separate so a leaked desktop key can't manage the server. Disabled keys are rejected with HTTP 403, and disabling or revoking a key immediately drops any active socket using it.

Socket.IO connections pass the API key as `auth.apiKey` in the handshake.

## Desktop app

```bash
npm install
npm run dev                # vite + electron, opens the window
# or
npm run pack               # builds the app + electron-builder --dir
npm run dist               # builds an installer
```

On first launch the app shows a settings card. Enter the server URL (e.g. `http://192.168.1.50:13113` or the tunnel's `https://xxx.trycloudflare.com`) and the API key copied from the admin UI. Settings live in `localStorage`; click the gear icon in the icon rail to change them later.

The Electron main process no longer embeds the server — it's just a renderer shell with a tray icon, bubble dock, and notifications.

## Project layout

```
.
├── electron/           # Electron main + preload, build glue
├── server/             # Standalone server (own package.json)
│   ├── index.ts        # Express + Socket.IO + Zalo bridge
│   ├── db.ts           # JSON store: API key + admin password hash
│   ├── admin.ts        # Admin session tokens
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
