import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { Readable } from "node:stream";
import multer from "multer";
import { Server } from "socket.io";
import { TunnelManager, validateNamedTunnelInput } from "./tunnel";
import { Database } from "./db";
import { AdminSessions } from "./admin";
import { ActivityLog, type ActivityEvent } from "./activity";
import { CloudflaredManager } from "./cloudflared";
import { CategoryStore } from "./categories";
import {
  AvatarSize,
  BinBankCard,
  LoginQRCallbackEventType,
  MuteAction,
  MuteDuration,
  Reactions,
  ThreadType,
  Zalo,
  type API,
  type Credentials,
  type DeliveredMessage,
  type GroupInfo,
  type GroupMemberProfile,
  type Message,
  type MessageContent,
  type SeenMessage,
  type SendSeenEventMessageParams,
  type User,
} from "zca-js";

dotenv.config();

const PORT = Number(process.env.PORT ?? 13113);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT} — must be an integer between 1 and 65535.`);
  process.exit(1);
}

const CLIENT_ORIGIN_RAW = process.env.CLIENT_ORIGIN ?? "*";
// "*" → allow any origin, no credentials. Otherwise comma-separated allow-list with credentials.
const CORS_OPTIONS = CLIENT_ORIGIN_RAW.trim() === "*"
  ? { origin: true, credentials: false }
  : { origin: CLIENT_ORIGIN_RAW.split(",").map((value) => value.trim()).filter(Boolean), credentials: true };
const SOCKET_CORS = CLIENT_ORIGIN_RAW.trim() === "*"
  ? { origin: true, credentials: false }
  : { origin: CORS_OPTIONS.origin as string[], credentials: true };

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Keep a deep per-thread history so the cache builds up over time. zca-js has
// no user (1-1) history API, so realtime-captured messages are all we get for
// DMs — retaining more of them is the main lever for a useful CRM history.
const MAX_THREAD_MESSAGES = 2000;
const MAX_PROXY_BYTES = 100 * 1024 * 1024;
const LISTENER_WATCHDOG_INTERVAL_MS = 60 * 1000;
const LISTENER_STALE_MS = 15 * 60 * 1000;
const LISTENER_MAX_AGE_MS = 60 * 60 * 1000;
const LISTENER_RESTART_DELAY_MS = 10 * 1000;
const LISTENER_INTERNAL_RETRY_GRACE_MS = 2 * 60 * 1000;
const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, ".zalo-manager");

function resolveDbFile(): string {
  if (process.env.DB_FILE) return path.resolve(process.env.DB_FILE);

  const currentFile = path.join(DATA_DIR, "zalodata.json");
  const legacyFile = path.join(DATA_DIR, "db.json");
  if (!existsSync(currentFile) && existsSync(legacyFile)) {
    try {
      renameSync(legacyFile, currentFile);
      console.log(`Migrated ${path.basename(legacyFile)} to ${path.basename(currentFile)}.`);
    } catch (error) {
      console.warn(`Could not migrate ${legacyFile} to ${currentFile}: ${errorMessage(error)}. Using legacy file for this run.`);
      return legacyFile;
    }
  }

  return currentFile;
}

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : resolveDbFile();
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");
const SESSION_FILE = path.join(DATA_DIR, "session.json");

// Server config (API keys + admin password) lives in zalodata.json — generated on
// first boot. Admin password defaults to "123456"; the user is expected to
// change it via the admin UI.
const db = new Database(DB_FILE);
const adminSessions = new AdminSessions();
const activity = new ActivityLog(ACTIVITY_FILE);
const cloudflared = new CloudflaredManager(DATA_DIR);
const categoryStore = new CategoryStore(CATEGORIES_FILE);

// Live connections — each entry is one connected client.
type LiveConnection = {
  socketId: string;
  keyId: string;
  keyName: string;
  ip: string;
  connectedAt: number;
};
const liveConnections = new Map<string, LiveConnection>();

function ipFor(req: express.Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "";
  return req.ip ?? req.socket.remoteAddress ?? "";
}
const FRIENDS_CACHE_FILE = path.join(DATA_DIR, "friends.json");
const CONVERSATIONS_CACHE_FILE = path.join(DATA_DIR, "conversations.json");
const MESSAGES_CACHE_FILE = path.join(DATA_DIR, "messages.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const QR_FILE = path.join(DATA_DIR, "qr.png");
const SERVER_STARTED_AT = new Date().toISOString();
const ALLOWED_ATTACHMENT_HOSTS = ["zdn.vn", "dlmd.me", "zalo.me", "zaloapp.com", "zadn.vn"];

function emitEmbeddedServerEvent(eventName: "szalo-server-ready" | "szalo-server-error", payload: unknown) {
  (process as unknown as { emit: (name: string, payload: unknown) => boolean }).emit(eventName, payload);
}

type ThreadKind = "user" | "group";
type DeliveryStatus = "sent" | "delivered" | "seen";

type SavedSession = {
  imei: string;
  cookie: unknown;
  userAgent: string;
  language?: string;
};

type Conversation = {
  id: string;
  type: ThreadKind;
  name: string;
  avatar?: string;
  lastMessage?: string;
  lastTimestamp?: number;
  unread: number;
  manualUnread?: boolean;
  muted?: boolean;
  pinned?: boolean;
  raw?: unknown;
};

type PublicConversation = Omit<Conversation, "raw">;

type ChatMessage = {
  id: string;
  threadId: string;
  type: ThreadKind;
  senderId?: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
  deliveryStatus?: DeliveryStatus;
  attachments: Array<{ title?: string; href?: string; thumb?: string; type?: string; size?: string }>;
  reactions?: Record<string, string[]>;  // icon → [userId, ...]
  raw?: unknown;
};

type SendAttempt = {
  ts: number;
  threadId: string;
  type: ThreadKind;
  textLength: number;
  fileCount: number;
  status: "started" | "sent" | "failed";
  error?: string;
  result?: unknown;
};

type ClientEvent = {
  ts: number;
  event: string;
  detail?: unknown;
};

type ListenerEvent = {
  ts: number;
  event: string;
  detail?: unknown;
};

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: SOCKET_CORS,
});
const upload = multer({
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 10,
  },
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      callback(null, UPLOAD_DIR);
    },
    filename: (_req, file, callback) => {
      const rawExt = path.extname(file.originalname);
      const ext = rawExt.replace(/[^.\w-]/g, "").slice(0, 24) || ".bin";
      callback(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
});

let zaloApi: API | null = null;
let loginPromise: Promise<API> | null = null;
let selfId = "";
let account: unknown = null;
let qrImage = "";
let loginState: "offline" | "waiting_qr" | "scanned" | "online" | "error" = "offline";
let lastError = "";
const conversations = new Map<string, Conversation>();
const messages = new Map<string, ChatMessage[]>();
const sendAttempts: SendAttempt[] = [];
const clientEvents: ClientEvent[] = [];
const listenerEvents: ListenerEvent[] = [];
const userHydrationInFlight = new Map<string, Promise<{ profile?: User; conversation?: Conversation }>>();
// Cache of userId → displayName, populated from friends, group members, and
// getUserInfo calls. Used to resolve sender names in group messages where
// dName is often empty.
const userNameCache = new Map<string, string>();
let persistTimer: NodeJS.Timeout | null = null;
let listenerStartedAt = 0;
let lastListenerActivityAt = 0;
let lastListenerConnectedAt = 0;
let lastListenerDisconnectedAt = 0;
let listenerRestartCount = 0;
let listenerRestarting = false;
let listenerWatchdogTimer: NodeJS.Timeout | null = null;
let listenerRestartTimer: NodeJS.Timeout | null = null;

function createZalo() {
  return new Zalo({
    selfListen: true,
    imageMetadataGetter: async (filePath: string) => {
      try {
        const sharpModule = await import("sharp");
        const sharp = sharpModule.default;
        const meta = await sharp(filePath).metadata();
        const stat = await import("node:fs/promises").then((m) => m.stat(filePath));
        return {
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          size: stat.size,
        };
      } catch {
        return null;
      }
    },
  });
}

app.use(cors(CORS_OPTIONS));
app.use(express.json({ limit: "2mb" }));

// Always-public routes (no auth required) — health probe, admin UI shell,
// and the admin login endpoint itself.
const PUBLIC_PATHS = new Set([
  "/",
  "/api/health/ping",
  "/admin",
  "/admin/",
  "/api/admin/login",
]);

function readApiKey(req: express.Request): string {
  const header = req.header("x-api-key");
  if (typeof header === "string" && header) return header.trim();
  const auth = req.header("authorization");
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const queryKey = req.query.api_key;
  if (typeof queryKey === "string" && queryKey) return queryKey.trim();
  return "";
}

function readAdminToken(req: express.Request): string {
  const header = req.header("x-admin-token");
  if (typeof header === "string" && header) return header.trim();
  const auth = req.header("authorization");
  if (typeof auth === "string" && auth.toLowerCase().startsWith("admin ")) {
    return auth.slice(6).trim();
  }
  return "";
}

// Augment Express request with the matched API key entry so handlers can log
// activity tagged with the human-friendly key name.
declare module "express-serve-static-core" {
  interface Request {
    apiKeyEntry?: { id: string; name: string };
  }
}

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();

  // Admin endpoints: gated by an admin session bearer (issued after password
  // login). Distinct from the API key so admins can't manage the server with
  // just the desktop client's key.
  if (req.path.startsWith("/api/admin/")) {
    const token = readAdminToken(req);
    if (!adminSessions.isValid(token)) {
      res.status(401).json({ error: "Admin login required" });
      return;
    }
    return next();
  }

  // Regular API: gated by a key from zalodata.json. Multi-key — admin can disable
  // a single key without affecting other clients.
  const provided = readApiKey(req);
  const entry = provided ? db.findApiKey(provided) : undefined;
  if (!entry) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  if (entry.disabled) {
    res.status(403).json({ error: "API key đã bị vô hiệu hóa" });
    return;
  }
  req.apiKeyEntry = { id: entry.id, name: entry.name };
  db.markApiKeyUsed(entry.id, ipFor(req));
  next();
});

// Socket.IO auth — same multi-key lookup, attached to socket.data so handlers
// can attribute every realtime event to the right client.
io.use((socket, next) => {
  const auth = socket.handshake.auth ?? {};
  const candidate = String(
    auth.apiKey ?? auth.token ?? socket.handshake.query?.api_key ?? socket.handshake.headers["x-api-key"] ?? "",
  ).trim();
  const entry = candidate ? db.findApiKey(candidate) : undefined;
  if (!entry) return next(new Error("Invalid or missing API key"));
  if (entry.disabled) return next(new Error("API key đã bị vô hiệu hóa"));
  (socket.data as { keyId?: string; keyName?: string }).keyId = entry.id;
  (socket.data as { keyId?: string; keyName?: string }).keyName = entry.name;
  next();
});

app.use("/downloads", express.static(UPLOAD_DIR));

// Admin UI — single static HTML file shipped alongside the server. Public so
// the user can paste their API key into it; the actions it triggers all hit
// authenticated /api endpoints.
//
// We try a few likely locations because this file is served:
//   - in dev via `tsx` from server/admin.html (next to this source file)
//   - in the Electron-bundled build via esbuild from electron/admin.html
//     (next to server.cjs — copied by build-server.cjs)
function locateAdminHtml(): string {
  // Likely locations:
  //   - dev (tsx running server/index.ts):    server/admin.html
  //   - bundled CJS (electron/server.cjs):    electron/admin.html (copied by build-server.cjs)
  //   - electron-builder packaged resources:  resources/admin.html
  const candidates = [
    path.join(ROOT, "server", "admin.html"),
    path.join(ROOT, "electron", "admin.html"),
    path.join(ROOT, "admin.html"),
  ];
  if (typeof __dirname !== "undefined") {
    candidates.unshift(path.join(__dirname, "admin.html"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
const ADMIN_HTML = locateAdminHtml();
app.get(["/admin", "/admin/"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(ADMIN_HTML, (error) => {
    if (error) res.status(500).json({ error: errorMessage(error) });
  });
});
// Convenience redirect for users hitting the bare server URL in a browser.
app.get("/", (_req, res) => res.redirect(302, "/admin"));

const tunnel = new TunnelManager(() => cloudflared.resolve());
tunnel.on("status", (status) => {
  io.emit("tunnel_status", status);
});
cloudflared.on("status", (status) => {
  io.to("admins").emit("cloudflared_status", status);
});

app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/socket.io") && !req.path.startsWith("/downloads")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isThreadKind(value: unknown): value is ThreadKind {
  return value === "user" || value === "group";
}

function isAllowedAttachmentHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return ALLOWED_ATTACHMENT_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function sanitizeDownloadName(value: unknown) {
  if (typeof value !== "string") return "attachment";
  const withoutControls = Array.from(value, (char) => char.charCodeAt(0) < 32 ? "_" : char).join("");
  const cleaned = withoutControls
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || "attachment";
}

async function removeUploadedFiles(files: Express.Multer.File[]) {
  await Promise.all(files.map((file) => unlink(file.path).catch(() => undefined)));
}

function recordSendAttempt(attempt: SendAttempt) {
  sendAttempts.unshift(attempt);
  sendAttempts.splice(20);
  return attempt;
}

function recordClientEvent(event: string, detail?: unknown) {
  clientEvents.unshift({ ts: Date.now(), event, detail });
  clientEvents.splice(50);
}

function recordListenerEvent(event: string, detail?: unknown) {
  listenerEvents.unshift({ ts: Date.now(), event, detail });
  listenerEvents.splice(50);
}

function touchListener(event: string, detail?: unknown) {
  lastListenerActivityAt = Date.now();
  recordListenerEvent(event, detail);
}

function listenerWsReadyState() {
  const listener = zaloApi?.listener as unknown as { ws?: { readyState?: number } | null } | undefined;
  return typeof listener?.ws?.readyState === "number" ? listener.ws.readyState : null;
}

function requestOldMessages(reason: string) {
  if (!zaloApi) return;
  try {
    zaloApi.listener.requestOldMessages(ThreadType.User);
    zaloApi.listener.requestOldMessages(ThreadType.Group);
    touchListener("old_messages_requested", { reason });
  } catch (error) {
    touchListener("old_messages_request_error", { reason, error: errorMessage(error) });
  }
}

function scheduleOldMessageRequest(reason: string) {
  setTimeout(() => requestOldMessages(reason), 2500);
}

async function restartZaloListener(reason: string, detail?: unknown) {
  if (!zaloApi || listenerRestarting) return;
  if (listenerWsReadyState() === 1 && !["stale_listener", "periodic_refresh"].includes(reason)) {
    touchListener("watchdog_restart_skipped", { reason, detail, wsReadyState: 1 });
    return;
  }
  listenerRestarting = true;
  listenerRestartCount += 1;
  touchListener("watchdog_restart", {
    reason,
    detail,
    restartCount: listenerRestartCount,
    wsReadyState: listenerWsReadyState(),
    listenerAgeMs: listenerStartedAt ? Date.now() - listenerStartedAt : null,
    idleMs: lastListenerActivityAt ? Date.now() - lastListenerActivityAt : null,
  });

  try {
    try {
      zaloApi.listener.stop();
    } catch (error) {
      touchListener("watchdog_stop_error", { reason, error: errorMessage(error) });
    }

    await delay(1000);
    if (!zaloApi) return;

    zaloApi.listener.start({ retryOnClose: true });
    listenerStartedAt = Date.now();
    lastListenerActivityAt = listenerStartedAt;
    lastListenerDisconnectedAt = 0;
    lastError = "";
    loginState = "online";
    emitState();
    scheduleOldMessageRequest(`restart:${reason}`);
  } catch (error) {
    lastError = `Listener restart failed: ${errorMessage(error)}`;
    touchListener("watchdog_restart_error", { reason, error: errorMessage(error) });
    emitState();
  } finally {
    listenerRestarting = false;
  }
}

function scheduleListenerRestart(reason: string, detail?: unknown, delayMs = LISTENER_RESTART_DELAY_MS) {
  if (listenerRestartTimer) return;
  listenerRestartTimer = setTimeout(() => {
    listenerRestartTimer = null;
    void restartZaloListener(reason, detail);
  }, delayMs);
}

function stopListenerWatchdog() {
  if (listenerWatchdogTimer) {
    clearInterval(listenerWatchdogTimer);
    listenerWatchdogTimer = null;
  }
  if (listenerRestartTimer) {
    clearTimeout(listenerRestartTimer);
    listenerRestartTimer = null;
  }
}

function startListenerWatchdog() {
  stopListenerWatchdog();
  listenerWatchdogTimer = setInterval(() => {
    if (!zaloApi || loginState !== "online" || listenerRestarting) return;

    const now = Date.now();
    const wsReadyState = listenerWsReadyState();
    const listenerAgeMs = listenerStartedAt ? now - listenerStartedAt : 0;
    const idleMs = lastListenerActivityAt ? now - lastListenerActivityAt : 0;

    if (wsReadyState !== 1) {
      const disconnectedAgeMs = lastListenerDisconnectedAt ? now - lastListenerDisconnectedAt : Number.POSITIVE_INFINITY;
      if (disconnectedAgeMs < LISTENER_INTERNAL_RETRY_GRACE_MS) return;
      void restartZaloListener("socket_not_open", { wsReadyState, listenerAgeMs, idleMs });
      return;
    }

    if (idleMs > LISTENER_STALE_MS) {
      void restartZaloListener("stale_listener", { wsReadyState, listenerAgeMs, idleMs });
      return;
    }

    if (listenerAgeMs > LISTENER_MAX_AGE_MS) {
      void restartZaloListener("periodic_refresh", { wsReadyState, listenerAgeMs, idleMs });
    }
  }, LISTENER_WATCHDOG_INTERVAL_MS);
}

function emitState() {
  io.emit("status", {
    state: loginState,
    account,
    selfId,
    qrImage,
    error: lastError,
    counts: conversationCounts(),
    serverStartedAt: SERVER_STARTED_AT,
  });
}

function sortedConversations() {
  return Array.from(conversations.values()).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0);
  });
}

function publicConversation(conversation: Conversation): PublicConversation {
  return {
    id: conversation.id,
    type: conversation.type,
    name: conversation.name,
    avatar: conversation.avatar,
    lastMessage: conversation.lastMessage,
    lastTimestamp: conversation.lastTimestamp,
    unread: conversation.unread,
    manualUnread: conversation.manualUnread,
    muted: conversation.muted,
    pinned: conversation.pinned,
  };
}

function publicConversations(list = sortedConversations()) {
  return list.map(publicConversation);
}

function emitConversations() {
  io.emit("conversations", publicConversations());
}

function emitConversation(conversation: Conversation | undefined) {
  if (conversation) io.emit("conversation", publicConversation(conversation));
}

function conversationCounts() {
  let users = 0;
  let groups = 0;
  for (const conversation of conversations.values()) {
    if (conversation.type === "group") groups += 1;
    else users += 1;
  }
  return { total: users + groups, users, groups };
}

function cleanedText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isPlaceholderConversationName(id: string, name: unknown) {
  const value = cleanedText(name);
  return !value || value === id || value === `${id}_0` || value === "Ban";
}

function chooseConversationName(id: string, currentName: unknown, incomingName: unknown, preferIncomingName = false) {
  const current = cleanedText(currentName);
  const incoming = cleanedText(incomingName);
  if (preferIncomingName && incoming && !isPlaceholderConversationName(id, incoming)) return incoming;
  if (isPlaceholderConversationName(id, current) && incoming) return incoming;
  return current || incoming || id;
}

function mergeConversation(
  patch: { id: string; type: ThreadKind; name?: string; avatar?: string; lastMessage?: string; lastTimestamp?: number; unread?: number; manualUnread?: boolean; muted?: boolean; pinned?: boolean; raw?: unknown },
  options: { preferIncomingName?: boolean } = {},
) {
  const existing = conversations.get(patch.id);
  const updated: Conversation = {
    id: patch.id,
    type: patch.type,
    name: chooseConversationName(patch.id, existing?.name, patch.name, options.preferIncomingName),
    avatar: cleanedText(patch.avatar) || existing?.avatar,
    lastMessage: patch.lastMessage ?? existing?.lastMessage,
    lastTimestamp: patch.lastTimestamp ?? existing?.lastTimestamp,
    unread: patch.unread ?? existing?.unread ?? 0,
    manualUnread: patch.manualUnread ?? existing?.manualUnread,
    muted: patch.muted ?? existing?.muted,
    pinned: patch.pinned ?? existing?.pinned,
    raw: patch.raw ?? existing?.raw,
  };
  conversations.set(patch.id, updated);
  return updated;
}

function conversationIdentityChanged(before: Conversation | undefined, after: Conversation | undefined) {
  return before?.name !== after?.name || before?.avatar !== after?.avatar || before?.type !== after?.type;
}

function profileFromUserInfo(info: { changed_profiles?: Record<string, User> }, userId: string) {
  const profiles = info.changed_profiles ?? {};
  return profiles[userId]
    ?? profiles[`${userId}_0`]
    ?? Object.entries(profiles).find(([key, profile]) => key === userId || key === `${userId}_0` || String(profile.userId) === userId)?.[1];
}

async function hydrateUserConversation(userId: string, emit = true) {
  if (!zaloApi) return { conversation: conversations.get(userId) };
  const existingPromise = userHydrationInFlight.get(userId);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    const before = conversations.get(userId);
    const info = await zaloApi.getUserInfo(userId, AvatarSize.Large);
    const profile = profileFromUserInfo(info, userId);
    if (!profile) return { conversation: before };

    const resolvedName = profile.displayName || profile.zaloName || userId;
    if (resolvedName && resolvedName !== userId) {
      userNameCache.set(userId, resolvedName);
    }

    const conversation = mergeConversation({
      id: userId,
      type: "user",
      name: resolvedName,
      avatar: profile.avatar,
      raw: profile,
    }, { preferIncomingName: true });

    if (conversationIdentityChanged(before, conversation)) {
      schedulePersist();
      if (emit) emitConversation(conversation);
    }
    return { profile, conversation };
  })().finally(() => {
    userHydrationInFlight.delete(userId);
  });

  userHydrationInFlight.set(userId, promise);
  return promise;
}

function messageStats() {
  const allMessages = Array.from(messages.values()).flat();
  const selfMessages = allMessages.filter((message) => message.isSelf);
  return {
    total: allMessages.length,
    self: selfMessages.length,
    received: allMessages.length - selfMessages.length,
    lastSelfTimestamp: selfMessages.reduce<number | undefined>((latest, message) => {
      if (latest === undefined || message.timestamp > latest) return message.timestamp;
      return latest;
    }, undefined),
  };
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistLocalState();
  }, 500);
}

async function persistLocalState() {
  persistTimer = null;
  await mkdir(DATA_DIR, { recursive: true });
  await Promise.all([
    writeFile(CONVERSATIONS_CACHE_FILE, JSON.stringify(sortedConversations()), "utf8"),
    writeFile(MESSAGES_CACHE_FILE, JSON.stringify(Object.fromEntries(messages)), "utf8"),
  ]);
}

async function loadLocalState() {
  try {
    const rawConversations = await readFile(CONVERSATIONS_CACHE_FILE, "utf8");
    const cachedConversations = JSON.parse(rawConversations) as Conversation[];
    for (const conversation of cachedConversations) {
      conversations.set(conversation.id, conversation);
    }
  } catch {
    // No local conversation cache yet.
  }

  try {
    const rawMessages = await readFile(MESSAGES_CACHE_FILE, "utf8");
    const cachedMessages = JSON.parse(rawMessages) as Record<string, ChatMessage[]>;
    for (const [threadId, list] of Object.entries(cachedMessages)) {
      messages.set(threadId, list.slice(-MAX_THREAD_MESSAGES));
    }
  } catch {
    // No local message cache yet.
  }
}

function asThreadType(type: ThreadKind) {
  return type === "group" ? ThreadType.Group : ThreadType.User;
}

function threadKind(type: ThreadType): ThreadKind {
  return type === ThreadType.Group ? "group" : "user";
}

function pickText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const value = content as Record<string, unknown>;
  const params = parseParams(value.params);
  return String(value.title ?? value.fileName ?? params?.fileName ?? value.description ?? value.href ?? value.fileUrl ?? params?.fileUrl ?? value.msg ?? "");
}

function pickAttachments(content: unknown): ChatMessage["attachments"] {
  if (!content || typeof content !== "object") return [];
  const value = content as Record<string, unknown>;
  const params = parseParams(value.params);
  const href = firstString(value.href, value.fileUrl, value.normalUrl, value.hdUrl, params?.fileUrl, params?.normalUrl, params?.hdUrl, params?.hd);
  const thumb = firstString(value.thumb, value.thumbUrl, params?.thumb, params?.thumbUrl);
  if (!href && !thumb) return [];
  return [
    {
      title: firstString(value.title, value.fileName, params?.fileName, value.description),
      href,
      thumb,
      type: firstString(value.type, params?.fileType, params?.type),
      size: firstString(value.totalSize, value.fileSize, params?.totalSize, params?.fileSize),
    },
  ];
}

function firstString(...values: unknown[]): string | undefined {
  const value = values.find((item) => (typeof item === "string" && item.length > 0) || typeof item === "number");
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : undefined;
}

function parseParams(params: unknown) {
  if (params && typeof params === "object") return params as Record<string, unknown>;
  if (typeof params !== "string" || !params.trim()) return null;
  try {
    const parsed = JSON.parse(params) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function seenParamsFromRaw(raw: unknown): SendSeenEventMessageParams | null {
  const message = recordValue(raw);
  const data = recordValue(message?.data);
  if (!data) return null;
  const required = ["msgId", "cliMsgId", "uidFrom", "idTo", "msgType", "st", "at", "cmd", "ts"];
  if (!required.every((key) => key in data)) return null;
  return {
    msgId: String(data.msgId),
    cliMsgId: String(data.cliMsgId),
    uidFrom: String(data.uidFrom),
    idTo: String(data.idTo),
    msgType: String(data.msgType),
    st: Number(data.st),
    at: Number(data.at),
    cmd: Number(data.cmd),
    ts: String(data.ts),
  };
}

function addMessageIds(ids: Set<string>, value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    ids.add(String(value));
    return;
  }
  const record = recordValue(value);
  if (!record) return;
  for (const key of ["id", "msgId", "realMsgId", "cliMsgId"]) {
    const item = record[key];
    if (typeof item === "string" || typeof item === "number") ids.add(String(item));
  }
  addMessageIds(ids, record.message);
  if (Array.isArray(record.attachment)) {
    for (const item of record.attachment) addMessageIds(ids, item);
  }
  addMessageIds(ids, record.data);
}

function messageIdsFor(message: ChatMessage) {
  const ids = new Set<string>([message.id]);
  addMessageIds(ids, message.raw);
  return ids;
}

function receiptIds(item: DeliveredMessage | SeenMessage) {
  const ids = new Set<string>();
  addMessageIds(ids, item.data);
  return ids;
}

function deliveryRank(status: DeliveryStatus | undefined) {
  if (status === "seen") return 3;
  if (status === "delivered") return 2;
  if (status === "sent") return 1;
  return 0;
}

function markDeliveryStatus(items: Array<DeliveredMessage | SeenMessage>, status: DeliveryStatus) {
  const updates: Array<{ threadId: string; type: ThreadKind; ids: string[]; status: DeliveryStatus }> = [];
  for (const item of items) {
    const threadId = String(item.threadId);
    const ids = receiptIds(item);
    const list = messages.get(threadId);
    if (!list || ids.size === 0) continue;

    let changed = false;
    for (const message of list) {
      const messageIds = messageIdsFor(message);
      const matches = Array.from(ids).some((id) => messageIds.has(id));
      if (!matches || deliveryRank(message.deliveryStatus) >= deliveryRank(status)) continue;
      message.deliveryStatus = status;
      changed = true;
    }

    if (changed) {
      const update = { threadId, type: threadKind(item.type), ids: Array.from(ids), status };
      updates.push(update);
      io.emit("message_status", update);
    }
  }
  if (updates.length > 0) schedulePersist();
  return updates;
}

async function refreshConversationControls() {
  if (!zaloApi) return { muted: 0, pinned: 0 };
  const [muteResult, pinResult, unreadResult] = await Promise.allSettled([
    zaloApi.getMute(),
    zaloApi.getPinConversations(),
    zaloApi.getUnreadMark(),
  ]);

  const muted = new Set<string>();
  if (muteResult.status === "fulfilled") {
    for (const entry of [...(muteResult.value.chatEntries ?? []), ...(muteResult.value.groupChatEntries ?? [])]) {
      muted.add(String(entry.id));
    }
  }

  const pinned = new Set<string>();
  if (pinResult.status === "fulfilled") {
    for (const id of pinResult.value.conversations ?? []) pinned.add(String(id));
  }

  const unreadMarked = new Set<string>();
  if (unreadResult.status === "fulfilled") {
    for (const item of [...(unreadResult.value.data?.convsUser ?? []), ...(unreadResult.value.data?.convsGroup ?? [])]) {
      unreadMarked.add(String(item.id));
    }
  }

  for (const conversation of conversations.values()) {
    conversation.muted = muted.has(conversation.id);
    conversation.pinned = pinned.has(conversation.id);
    if (unreadMarked.has(conversation.id) && conversation.unread === 0) {
      conversation.unread = 1;
      conversation.manualUnread = true;
    } else if (!unreadMarked.has(conversation.id) && conversation.manualUnread) {
      conversation.unread = 0;
      conversation.manualUnread = false;
    }
  }
  schedulePersist();
  return { muted: muted.size, pinned: pinned.size, unreadMarked: unreadMarked.size };
}

function normalizeIncoming(message: Message): ChatMessage {
  const data = message.data ?? {};
  const type = threadKind(message.type);
  const rawSenderId = String(data.uidFrom ?? "");
  const isSelf = Boolean(message.isSelf) || rawSenderId === "0" || (Boolean(selfId) && rawSenderId === selfId);
  const senderId = isSelf && rawSenderId === "0" ? selfId : rawSenderId;

  // Resolve sender name: prefer dName from the message, fall back to cache,
  // then to the conversation name (for 1-1), then to the raw ID.
  let senderName = String(data.dName ?? "").trim();
  if (!senderName && senderId) {
    senderName = userNameCache.get(senderId) || conversations.get(senderId)?.name || "";
  }
  // If still empty and it's a group message, try async hydration (fire-and-forget)
  if (!senderName && senderId && type === "group" && zaloApi && !userHydrationInFlight.has(senderId)) {
    void hydrateUserName(senderId);
  }

  return {
    id: String(data.msgId ?? data.cliMsgId ?? `${message.threadId}-${Date.now()}`),
    threadId: String(message.threadId),
    type,
    senderId,
    senderName: senderName || senderId,
    text: pickText(data.content),
    timestamp: Number(data.ts ?? Date.now()),
    isSelf,
    deliveryStatus: isSelf ? "sent" : undefined,
    attachments: pickAttachments(data.content),
    raw: message,
  };
}

function publicMessageRaw(raw: unknown) {
  const data = (raw as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== "object") return undefined;

  const lightData: Record<string, unknown> = {};
  for (const key of ["content", "msgType", "propertyExt", "cliMsgId"]) {
    if (data[key] !== undefined) lightData[key] = data[key];
  }
  return Object.keys(lightData).length > 0 ? { data: lightData } : undefined;
}

function publicMessage(message: ChatMessage): ChatMessage {
  const { raw: _raw, ...rest } = message;
  const raw = publicMessageRaw(_raw);
  return raw ? { ...rest, raw } : rest;
}

function publicMessages(list: ChatMessage[]) {
  return list.map(publicMessage);
}

function queryNumber(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedQueryNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = queryNumber(value);
  if (parsed === null) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

/**
 * Fire-and-forget: resolve a user's display name and cache it. Also backfills
 * any messages in the cache that have this userId as senderId with a bare ID
 * as their senderName.
 */
async function hydrateUserName(userId: string) {
  if (!zaloApi || !userId || userNameCache.has(userId)) return;
  try {
    const info = await zaloApi.getUserInfo(userId, AvatarSize.Large);
    const profile = profileFromUserInfo(info, userId);
    if (!profile) return;
    const name = profile.displayName || profile.zaloName || "";
    if (!name) return;
    userNameCache.set(userId, name);
    // Backfill cached messages that show the raw ID instead of a name
    for (const [, list] of messages) {
      for (const msg of list) {
        if (msg.senderId === userId && (msg.senderName === userId || !msg.senderName)) {
          msg.senderName = name;
        }
      }
    }
    schedulePersist();
  } catch {
    // Ignore — we'll try again next time
  }
}

function applyUndo(undo: { threadId: string; msgId?: string | number; cliMsgId?: string | number }) {
  const threadId = String(undo.threadId);
  const list = messages.get(threadId);
  if (!list) return;
  const targetId = String(undo.msgId ?? undo.cliMsgId ?? "");
  if (!targetId) return;
  const before = list.length;
  const filtered = list.filter((msg) => msg.id !== targetId);
  if (filtered.length < before) {
    messages.set(threadId, filtered);
    schedulePersist();
  }
}

function upsertMessage(message: ChatMessage) {
  const list = messages.get(message.threadId) ?? [];
  const isNew = !list.some((item) => item.id === message.id);
  if (isNew) {
    list.push(message);
    list.sort((a, b) => a.timestamp - b.timestamp);
    messages.set(message.threadId, list.slice(-MAX_THREAD_MESSAGES));
  }

  const existing = conversations.get(message.threadId);
  const existingLastTimestamp = existing?.lastTimestamp ?? 0;
  const isLatest = !existingLastTimestamp || message.timestamp >= existingLastTimestamp;
  const hasNewIncomingMessage = !message.isSelf && isNew && isLatest;
  const conversation = mergeConversation({
    id: message.threadId,
    type: message.type,
    name: message.isSelf ? undefined : message.senderName,
    lastMessage: isLatest ? message.text || (message.attachments.length ? "Attachment" : "") : existing?.lastMessage,
    lastTimestamp: isLatest ? message.timestamp : existing?.lastTimestamp,
    unread: hasNewIncomingMessage ? (existing?.manualUnread ? 1 : (existing?.unread ?? 0) + 1) : existing?.unread ?? 0,
    manualUnread: hasNewIncomingMessage ? false : existing?.manualUnread,
  });
  if (message.type === "user" && isNew) {
    const conversation = conversations.get(message.threadId);
    if (conversation && (!conversation.avatar || isPlaceholderConversationName(message.threadId, conversation.name))) {
      void hydrateUserConversation(message.threadId).catch((error) => recordListenerEvent("user_hydrate_error", { threadId: message.threadId, error: errorMessage(error) }));
    }
  }
  schedulePersist();
  return { isNew, isLatest, countedUnread: hasNewIncomingMessage, conversation };
}

async function saveSession(session: SavedSession) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

async function loadSession() {
  const raw = await readFile(SESSION_FILE, "utf8");
  return JSON.parse(raw) as SavedSession;
}

async function clearSession() {
  await rm(SESSION_FILE, { force: true });
}

async function saveFriendsCache(friends: User[]) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FRIENDS_CACHE_FILE, JSON.stringify(friends), "utf8");
}

function friendPageLimit(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "all") return 100;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(Math.floor(parsed), 100));
}

function uniqueFriends(friends: User[]) {
  const seen = new Set<string>();
  const unique: User[] = [];
  for (const friend of friends) {
    const id = String(friend.userId ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(friend);
  }
  return unique;
}

async function loadFriendsCache() {
  try {
    const raw = await readFile(FRIENDS_CACHE_FILE, "utf8");
    return JSON.parse(raw) as User[];
  } catch {
    return [];
  }
}

async function afterLogin(api: API) {
  zaloApi = api;
  loginState = "online";
  qrImage = "";
  lastError = "";
  selfId = api.getOwnId?.() ?? "";
  try {
    account = await api.fetchAccountInfo();
  } catch {
    account = null;
  }

  api.listener.on("connected", () => {
    lastListenerConnectedAt = Date.now();
    lastListenerDisconnectedAt = 0;
    touchListener("connected", {
      restartCount: listenerRestartCount,
      wsReadyState: listenerWsReadyState(),
    });
    loginState = "online";
    lastError = "";
    emitState();
    scheduleOldMessageRequest("connected");
  });
  api.listener.on("disconnected", (code, reason) => {
    lastListenerDisconnectedAt = Date.now();
    touchListener("disconnected", { code, reason });
    lastError = reason;
    emitState();
  });
  api.listener.on("closed", (code, reason) => {
    lastListenerDisconnectedAt = Date.now();
    touchListener("closed", { code, reason });
    if (![1000, 3000, 3003].includes(Number(code))) {
      scheduleListenerRestart("closed", { code, reason });
    }
  });
  api.listener.on("error", (error) => {
    touchListener("error", { error: errorMessage(error) });
    lastError = errorMessage(error);
    emitState();
    scheduleListenerRestart("error", { error: errorMessage(error) }, 30000);
  });
  api.listener.on("message", (message) => {
    const normalized = normalizeIncoming(message);
    touchListener("message", {
      threadId: normalized.threadId,
      type: normalized.type,
      isSelf: normalized.isSelf,
      senderId: normalized.senderId,
      textLength: normalized.text.length,
      fileCount: normalized.attachments.length,
    });
    const result = upsertMessage(normalized);
    io.emit("message", publicMessage(normalized));
    emitConversation(result.conversation);
  });
  api.listener.on("typing", (typing) => {
    touchListener("typing", { threadId: typing.threadId, isSelf: typing.isSelf });
    io.emit("typing", typing);
  });
  api.listener.on("seen_messages", (items) => {
    const updates = markDeliveryStatus(items, "seen");
    touchListener("seen_messages", { count: items.length, updates: updates.length });
    io.emit("seen_messages", items);
  });
  api.listener.on("delivered_messages", (items) => {
    const updates = markDeliveryStatus(items, "delivered");
    touchListener("delivered_messages", { count: items.length, updates: updates.length });
    io.emit("delivered_messages", items);
  });
  api.listener.on("group_event", (event) => {
    touchListener("group_event", { threadId: event.threadId, isSelf: event.isSelf, type: event.type });
    io.emit("group_event", event);
  });
  api.listener.on("friend_event", (event) => {
    touchListener("friend_event", { isSelf: event.isSelf, type: event.type });
    io.emit("friend_event", event);
  });
  api.listener.on("reaction", (reaction) => {
    touchListener("reaction", { threadId: reaction.threadId, isSelf: reaction.isSelf });
    // Store reaction on the message in cache
    const threadId = String(reaction.threadId ?? "");
    const data = reaction.data;
    const msgId = String(data?.msgId ?? data?.cliMsgId ?? "");
    const icon = String(data?.content?.rIcon ?? "❤️");
    const userId = String(data?.actionId ?? data?.uidFrom ?? "");
    if (threadId && msgId) {
      const list = messages.get(threadId);
      if (list) {
        const msg = list.find((m) => m.id === msgId);
        if (msg) {
          if (!msg.reactions) msg.reactions = {};
          if (!msg.reactions[icon]) msg.reactions[icon] = [];
          if (!msg.reactions[icon].includes(userId)) {
            msg.reactions[icon].push(userId);
            schedulePersist();
          }
        }
      }
    }
    io.emit("reaction", { threadId, msgId, icon, userId, raw: reaction });
  });
  api.listener.on("undo", (undo) => {
    touchListener("undo", { threadId: undo.threadId, isSelf: undo.isSelf });
    applyUndo({ threadId: String(undo.threadId), msgId: (undo as { msgId?: string | number }).msgId, cliMsgId: (undo as { cliMsgId?: string | number }).cliMsgId });
    io.emit("undo", undo);
  });
  api.listener.on("old_messages", (items, type) => {
    const latestByThread = new Map<string, ChatMessage>();
    let newCount = 0;
    let countedUnread = 0;
    for (const item of items) {
      const normalized = normalizeIncoming(item);
      const result = upsertMessage(normalized);
      if (!result.isNew || !result.isLatest) continue;
      newCount += 1;
      if (result.countedUnread) countedUnread += 1;
      const current = latestByThread.get(normalized.threadId);
      if (!current || normalized.timestamp > current.timestamp) {
        latestByThread.set(normalized.threadId, normalized);
      }
    }
    touchListener("old_messages", {
      type: threadKind(type),
      count: items.length,
      newCount,
      countedUnread,
      emittedThreads: latestByThread.size,
    });
    for (const message of latestByThread.values()) {
      io.emit("message", publicMessage(message));
    }
    if (newCount > 0) {
      for (const message of latestByThread.values()) emitConversation(conversations.get(message.threadId));
    }
  });
  listenerStartedAt = Date.now();
  lastListenerActivityAt = listenerStartedAt;
  lastListenerDisconnectedAt = 0;
  api.listener.start({ retryOnClose: true });
  startListenerWatchdog();
  void refreshConversationControls()
    .then(emitConversations)
    .catch((error) => recordListenerEvent("controls_error", { error: errorMessage(error) }));
  emitState();
}

async function restoreSession() {
  const credentials = await loadSession().catch(() => null);
  if (!credentials) {
    loginState = "offline";
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const api = await createZalo().login(credentials as Credentials);
      await afterLogin(api);
      return;
    } catch (error) {
      loginState = "offline";
      lastError = `Session restore failed (${attempt}/3): ${errorMessage(error)}`;
      console.warn(lastError);
      if (attempt < 3) await delay(1500);
    }
  }
}

app.get("/api/health/ping", (_req, res) => {
  // Public endpoint — used by the desktop app to probe URL/connectivity before
  // sending the API key. Does not expose any session info.
  res.json({ ok: true, service: "szalo-server", serverStartedAt: SERVER_STARTED_AT });
});

// === Admin auth ===
app.post("/api/admin/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password || !db.verifyAdminPassword(password)) {
    res.status(401).json({ error: "Mật khẩu không đúng" });
    return;
  }
  const token = adminSessions.issue();
  res.json({ token, mustChangePassword: db.verifyAdminPassword("123456") });
});

app.post("/api/admin/logout", (req, res) => {
  adminSessions.revoke(readAdminToken(req));
  res.json({ ok: true });
});

app.get("/api/admin/me", (_req, res) => {
  res.json({
    apiKeys: db.listApiKeys(),
    mustChangePassword: db.verifyAdminPassword("123456"),
    cloudflare: db.getCloudflareConfig(),
    meta: db.meta(),
  });
});

app.post("/api/admin/password", (req, res) => {
  const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const next = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  const confirm = typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";
  if (!db.verifyAdminPassword(current)) {
    res.status(401).json({ error: "Mật khẩu hiện tại sai" });
    return;
  }
  if (next.length < 4) {
    res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 4 ký tự" });
    return;
  }
  if (next !== confirm) {
    res.status(400).json({ error: "Hai ô nhập lại không khớp" });
    return;
  }
  db.setAdminPassword(next);
  res.json({ ok: true });
});

// === API key management (multi-key) ===
app.get("/api/admin/api-keys", (_req, res) => {
  res.json(db.listApiKeys());
});

app.post("/api/admin/api-keys", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  if (!name.trim()) {
    res.status(400).json({ error: "Tên key không được để trống" });
    return;
  }
  const entry = db.createApiKey(name);
  res.json(entry);
});

app.patch("/api/admin/api-keys/:id", (req, res) => {
  const id = req.params.id;
  if (!db.findApiKeyById(id)) {
    res.status(404).json({ error: "Không tìm thấy API key" });
    return;
  }
  if (typeof req.body?.name === "string" && req.body.name.trim()) {
    db.renameApiKey(id, req.body.name);
  }
  if (typeof req.body?.disabled === "boolean") {
    const wasEnabled = !req.body.disabled;
    db.setApiKeyDisabled(id, req.body.disabled);
    if (!wasEnabled) {
      // Boot any sockets currently using this key.
      for (const socket of io.sockets.sockets.values()) {
        if ((socket.data as { keyId?: string }).keyId === id) {
          socket.disconnect(true);
        }
      }
    }
  }
  res.json(db.findApiKeyById(id));
});

app.delete("/api/admin/api-keys/:id", (req, res) => {
  const id = req.params.id;
  if (!db.revokeApiKey(id)) {
    res.status(404).json({ error: "Không tìm thấy API key" });
    return;
  }
  for (const socket of io.sockets.sockets.values()) {
    if ((socket.data as { keyId?: string }).keyId === id) {
      socket.disconnect(true);
    }
  }
  res.json({ ok: true });
});

// === Connection watch ===
app.get("/api/admin/connections", (_req, res) => {
  res.json(Array.from(liveConnections.values()));
});

app.get("/api/admin/activity", (req, res) => {
  const keyId = typeof req.query.keyId === "string" ? req.query.keyId : undefined;
  const limit = Number(req.query.limit) || 200;
  const since = req.query.since ? Number(req.query.since) : undefined;
  res.json(activity.list({ keyId, limit, since }));
});

// === Cloudflared binary management ===
app.get("/api/admin/cloudflared/status", (_req, res) => {
  res.json(cloudflared.status());
});
app.post("/api/admin/cloudflared/install", async (_req, res) => {
  const status = await cloudflared.install();
  res.json(status);
});

// === Cloudflare tunnel admin ===
app.get("/api/admin/tunnel/status", (_req, res) => {
  res.json({ ...tunnel.getStatus(), config: db.getCloudflareConfig(), cloudflared: cloudflared.status(), auth: tunnel.getAuthStatus() });
});
app.get("/api/admin/tunnel/auth", (_req, res) => {
  res.json(tunnel.getAuthStatus());
});
app.post("/api/admin/tunnel/quick", async (_req, res) => {
  const status = await tunnel.startQuick(PORT);
  res.json(status);
});
app.post("/api/admin/tunnel/named", async (req, res) => {
  const tunnelName = typeof req.body?.tunnelName === "string" ? req.body.tunnelName.trim() : "";
  const domain = typeof req.body?.domain === "string" ? req.body.domain.trim() : "";
  const subdomain = typeof req.body?.subdomain === "string" ? req.body.subdomain.trim() : "";
  const validated = validateNamedTunnelInput({ tunnelName, domain, subdomain });
  if (!validated.ok) {
    res.status(400).json({ error: validated.error });
    return;
  }
  db.setCloudflareConfig({
    tunnelName: validated.value.tunnelName,
    domain: validated.value.domain,
    subdomain: validated.value.subdomain,
  });
  const status = await tunnel.startNamed(PORT, validated.value.tunnelName, validated.value.subdomain, validated.value.domain);
  res.json(status);
});
app.post("/api/admin/tunnel/stop", async (_req, res) => {
  const status = await tunnel.stop();
  res.json(status);
});
app.post("/api/admin/tunnel/authorize", async (_req, res) => {
  // cloudflared tunnel login — opens a browser URL on the server-side host so
  // the user (or someone with shell access) authorizes the domain. We surface
  // the URL out of stdout so the admin UI can show it.
  const result = await tunnel.authorize();
  res.json(result);
});

app.get("/api/status", (_req, res) => {
  res.json({ state: loginState, account, selfId, qrImage, error: lastError, counts: conversationCounts(), serverStartedAt: SERVER_STARTED_AT });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    state: loginState,
    error: lastError,
    selfId,
    counts: conversationCounts(),
    serverStartedAt: SERVER_STARTED_AT,
    cache: {
      conversations: conversations.size,
      messageThreads: messages.size,
    },
    listener: {
      wsReadyState: listenerWsReadyState(),
      startedAt: listenerStartedAt,
      lastActivityAt: lastListenerActivityAt,
      lastConnectedAt: lastListenerConnectedAt,
      lastDisconnectedAt: lastListenerDisconnectedAt,
      idleMs: lastListenerActivityAt ? Date.now() - lastListenerActivityAt : null,
      ageMs: listenerStartedAt ? Date.now() - listenerStartedAt : null,
      restartCount: listenerRestartCount,
      restarting: listenerRestarting,
      watchdogEnabled: listenerWatchdogTimer !== null,
    },
    messageStats: messageStats(),
    recentSends: sendAttempts,
    recentClientEvents: clientEvents,
    recentListenerEvents: listenerEvents,
  });
});

app.post("/api/client-events", (req, res) => {
  const { event, detail } = req.body as { event?: string; detail?: unknown };
  if (event) recordClientEvent(event, detail);
  res.json({ ok: true });
});

app.get("/api/attachments/proxy", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: "Invalid attachment URL" });
    return;
  }
  if (!["http:", "https:"].includes(url.protocol) || !isAllowedAttachmentHost(url.hostname)) {
    res.status(400).json({ error: "Attachment host is not allowed" });
    return;
  }

  const cookieJar = zaloApi.getCookie();
  const [cookie, session] = await Promise.all([
    cookieJar.getCookieString(url.href).catch(() => ""),
    loadSession().catch(() => null),
  ]);
  const upstream = await fetch(url, {
    headers: {
      Cookie: cookie,
      Referer: "https://chat.zalo.me/",
      "User-Agent": session?.userAgent ?? "Mozilla/5.0",
    },
  });

  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status).json({ error: `Attachment download failed: HTTP ${upstream.status}` });
    return;
  }

  const contentLength = Number(upstream.headers.get("content-length") ?? 0);
  if (contentLength > MAX_PROXY_BYTES) {
    res.status(413).json({ error: "Attachment is larger than 100MB" });
    return;
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const contentDisposition = upstream.headers.get("content-disposition");
  const filename = sanitizeDownloadName(req.query.name || path.basename(url.pathname) || "attachment");
  res.status(upstream.status);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("Content-Disposition", contentDisposition || `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  if (contentLength > 0) res.setHeader("Content-Length", String(contentLength));

  let transferred = 0;
  const stream = Readable.fromWeb(upstream.body);
  stream.on("data", (chunk: Buffer) => {
    transferred += chunk.length;
    if (transferred > MAX_PROXY_BYTES) stream.destroy(new Error("Attachment is larger than 100MB"));
  });
  stream.on("error", (error) => {
    if (!res.headersSent) res.status(500).json({ error: errorMessage(error) });
    else res.destroy(error);
  });
  stream.pipe(res);
});

app.post("/api/login/qr", async (req, res) => {
  activity.record({
    ts: Date.now(),
    keyId: req.apiKeyEntry?.id ?? null,
    keyName: req.apiKeyEntry?.name ?? "",
    action: "zalo_login",
  });
  if (zaloApi) {
    res.json({ ok: true, state: "online" });
    return;
  }
  if (loginPromise) {
    res.json({ ok: true, state: loginState });
    return;
  }

  loginState = "waiting_qr";
  lastError = "";
  emitState();
  loginPromise = createZalo().loginQR({ qrPath: QR_FILE }, async (event) => {
    if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
      qrImage = event.data.image.startsWith("data:")
        ? event.data.image
        : `data:image/png;base64,${event.data.image}`;
      await event.actions.saveToFile(QR_FILE);
      loginState = "waiting_qr";
      emitState();
    }
    if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
      loginState = "waiting_qr";
      event.actions.retry();
      emitState();
    }
    if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
      loginState = "scanned";
      emitState();
    }
    if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
      loginState = "offline";
      event.actions.abort();
      emitState();
    }
    if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
      await saveSession({
        imei: event.data.imei,
        cookie: event.data.cookie,
        userAgent: event.data.userAgent,
      });
    }
  });

  loginPromise
    .then(afterLogin)
    .catch((error) => {
      loginState = "error";
      lastError = errorMessage(error);
      emitState();
    })
    .finally(() => {
      loginPromise = null;
    });

  res.json({ ok: true, state: loginState });
});

app.post("/api/logout", async (req, res) => {
  activity.record({
    ts: Date.now(),
    keyId: req.apiKeyEntry?.id ?? null,
    keyName: req.apiKeyEntry?.name ?? "",
    action: "zalo_logout",
  });
  stopListenerWatchdog();
  zaloApi?.listener.stop();
  zaloApi = null;
  account = null;
  selfId = "";
  qrImage = "";
  lastError = "";
  loginState = "offline";
  await clearSession();
  emitState();
  res.json({ ok: true });
});

app.get("/api/friends", async (_req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const pageSize = 200;
  const maxPages = friendPageLimit(_req.query.pages ?? "all");
  const friends: User[] = [];
  let warning = "";
  let stoppedByLastPage = false;
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      if (page > 1) await delay(800);
      const batch = (await zaloApi.getAllFriends(pageSize, page, AvatarSize.Large)) as User[];
      friends.push(...batch);
      if (batch.length < pageSize) {
        stoppedByLastPage = true;
        break;
      }
    }
  } catch (error) {
    warning = errorMessage(error);
    if (friends.length === 0) friends.push(...await loadFriendsCache());
  }
  const unique = uniqueFriends(friends);
  if (!warning && !stoppedByLastPage && unique.length >= pageSize * maxPages) {
    warning = `Reached friends page limit (${maxPages}); raise the server limit if contacts are still missing.`;
  }
  if (unique.length > 0) {
    await saveFriendsCache(unique);
  }
  for (const friend of unique) {
    const name = friend.displayName || friend.zaloName || String(friend.userId);
    userNameCache.set(String(friend.userId), name);
    mergeConversation({
      id: String(friend.userId),
      type: "user",
      name,
      avatar: friend.avatar,
      raw: friend,
    }, { preferIncomingName: true });
  }
  schedulePersist();
  emitConversations();
  if (warning) res.setHeader("X-Zalo-Warning", warning);
  res.json(unique);
});

app.get("/api/groups", async (_req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const groups = await zaloApi.getAllGroups();
  const ids = Object.keys(groups.gridVerMap ?? {});
  for (const id of ids) {
    try {
      const info = await zaloApi.getGroupInfo(id);
      const group = info.gridInfoMap?.[id] as GroupInfo | undefined;
      mergeConversation({
        id,
        type: "group",
        name: group?.name || id,
        avatar: group?.fullAvt || group?.avt,
        raw: group ?? { id },
      }, { preferIncomingName: true });
    } catch (error) {
      mergeConversation({
        id,
        type: "group",
        name: id,
        raw: { id, error: errorMessage(error) },
      });
    }
  }
  schedulePersist();
  emitConversations();
  res.json(publicConversations(sortedConversations().filter((item) => item.type === "group")));
});

app.get("/api/groups/:groupId", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const groupId = req.params.groupId;
  const info = await zaloApi.getGroupInfo(groupId);
  const group = info.gridInfoMap?.[groupId] as (GroupInfo & { memVerList?: string[] }) | undefined;
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const beforeGroupConversation = conversations.get(groupId);
  const groupConversation = mergeConversation({
    id: groupId,
    type: "group",
    name: group.name || groupId,
    avatar: group.fullAvt || group.avt,
    raw: group,
  }, { preferIncomingName: true });
  if (conversationIdentityChanged(beforeGroupConversation, groupConversation)) {
    schedulePersist();
    emitConversation(groupConversation);
  }

  // Zalo's getGroupInfo returns members in `memVerList` (array of
  // "userId_version" strings), not `memberIds` or `currentMems` (those are
  // empty in current API responses).
  const memVerList = (group as { memVerList?: string[] }).memVerList ?? [];
  const idsFromVerList = memVerList.map((entry) => entry.split("_")[0]).filter(Boolean);
  const memberIds = Array.from(new Set([
    ...idsFromVerList,
    ...(group.memberIds ?? []),
    ...(group.currentMems ?? []).map((member) => member.id),
  ].map(String).filter(Boolean)));
  const limitedMemberIds = memberIds.slice(0, 200);
  let profiles: Record<string, GroupMemberProfile> = {};
  let warning = "";
  if (limitedMemberIds.length > 0) {
    try {
      const result = await zaloApi.getGroupMembersInfo(limitedMemberIds);
      profiles = result.profiles ?? {};
    } catch (error) {
      warning = errorMessage(error);
    }
  }

  const currentMembers = (group.currentMems ?? []).map((member) => ({
    id: String(member.id),
    displayName: member.dName || member.zaloName || String(member.id),
    zaloName: member.zaloName,
    avatar: member.avatar || member.avatar_25,
    type: member.type,
    accountStatus: member.accountStatus,
    isAdmin: (group.adminIds ?? []).map(String).includes(String(member.id)),
  }));
  const memberProfiles = limitedMemberIds.map((id) => {
    const profile = profiles[id];
    const fallback = currentMembers.find((member) => member.id === id);
    const displayName = profile?.displayName || fallback?.displayName || id;
    // Populate name cache so future group messages show names instead of IDs
    if (displayName && displayName !== id) {
      userNameCache.set(id, displayName);
    }
    return {
      id,
      displayName,
      zaloName: profile?.zaloName || fallback?.zaloName || "",
      avatar: profile?.avatar || fallback?.avatar || "",
      accountStatus: profile?.accountStatus ?? fallback?.accountStatus,
      type: profile?.type ?? fallback?.type,
      isAdmin: (group.adminIds ?? []).map(String).includes(id),
    };
  });

  res.json({
    id: group.groupId,
    name: group.name,
    description: group.desc,
    avatar: group.fullAvt || group.avt,
    type: group.type,
    totalMember: group.totalMember,
    maxMember: group.maxMember,
    adminIds: group.adminIds ?? [],
    creatorId: group.creatorId,
    createdTime: group.createdTime,
    setting: group.setting,
    hasMoreMember: group.hasMoreMember,
    members: memberProfiles,
    truncated: memberIds.length > limitedMemberIds.length,
    warning,
  });
});

app.get("/api/users/:userId", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const userId = req.params.userId;
  let profile: User | undefined;
  let conversation = conversations.get(userId);
  try {
    const hydrated = await hydrateUserConversation(userId);
    profile = hydrated.profile;
    conversation = hydrated.conversation ?? conversation;
  } catch (error) {
    if (!conversation) throw error;
    res.setHeader("X-Zalo-Warning", errorMessage(error));
  }
  if (!profile && !conversation) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: userId,
    username: profile?.username ?? "",
    displayName: profile?.displayName || profile?.zaloName || conversation?.name || userId,
    zaloName: profile?.zaloName ?? "",
    avatar: profile?.avatar || conversation?.avatar || "",
    cover: profile?.cover || profile?.bgavatar || "",
    phoneNumber: profile?.phoneNumber ?? "",
    status: profile?.status ?? "",
    gender: profile?.gender,
    birthday: profile?.sdob || (profile?.dob ? String(profile.dob) : ""),
    isFriend: profile?.isFr === 1 || conversation?.type === "user",
    isBlocked: profile?.isBlocked === 1,
    isActive: profile?.isActive === 1,
    isActivePC: profile?.isActivePC === 1,
    isActiveWeb: profile?.isActiveWeb === 1,
    accountStatus: profile?.accountStatus,
    lastActionTime: profile?.lastActionTime,
    lastUpdateTime: profile?.lastUpdateTime,
    raw: profile ?? conversation?.raw,
  });
});

app.get("/api/conversations", (_req, res) => {
  res.json(publicConversations());
});

// Categories (Slack-style channels) are stored server-side keyed by the
// logged-in Zalo account, so any machine that logs into the same account gets
// the same grouping back automatically.
app.get("/api/categories", (_req, res) => {
  if (!selfId) {
    res.json({ selfId: "", categories: [] });
    return;
  }
  res.json({ selfId, categories: categoryStore.get(selfId) });
});

app.put("/api/categories", (req, res) => {
  if (!selfId) {
    res.status(409).json({ error: "Zalo chưa đăng nhập — chưa biết tài khoản để lưu phân loại" });
    return;
  }
  const incoming = Array.isArray(req.body?.categories) ? req.body.categories : [];
  const saved = categoryStore.set(selfId, incoming);
  // Broadcast so other clients on the same account update live.
  io.emit("categories", { selfId, categories: saved });
  res.json({ selfId, categories: saved });
});

app.post("/api/conversations/:type/:threadId/action", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { type, threadId } = req.params as { type: ThreadKind; threadId: string };
  if (!isThreadKind(type)) {
    res.status(400).json({ error: "Missing or invalid thread type" });
    return;
  }
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  const existing = conversations.get(threadId);
  const conversation: Conversation = existing ?? {
    id: threadId,
    type,
    name: threadId,
    unread: 0,
    manualUnread: false,
  };

  switch (action) {
    case "mark_unread":
      await zaloApi.addUnreadMark(threadId, asThreadType(type));
      conversation.unread = Math.max(conversation.unread, 1);
      conversation.manualUnread = true;
      break;
    case "mark_read":
      await zaloApi.removeUnreadMark(threadId, asThreadType(type));
      conversation.unread = 0;
      conversation.manualUnread = false;
      break;
    case "mute":
      await zaloApi.setMute({ action: MuteAction.MUTE, duration: MuteDuration.FOREVER }, threadId, asThreadType(type));
      conversation.muted = true;
      break;
    case "unmute":
      await zaloApi.setMute({ action: MuteAction.UNMUTE }, threadId, asThreadType(type));
      conversation.muted = false;
      break;
    case "pin":
      await zaloApi.setPinnedConversations(true, threadId, asThreadType(type));
      conversation.pinned = true;
      break;
    case "unpin":
      await zaloApi.setPinnedConversations(false, threadId, asThreadType(type));
      conversation.pinned = false;
      break;
    default:
      res.status(400).json({ error: "Unknown conversation action" });
      return;
  }

  conversations.set(threadId, conversation);
  schedulePersist();
  emitConversation(conversation);
  res.json({ ok: true, conversation: publicConversation(conversation), action });
});

app.get("/api/messages/:type/:threadId", async (req, res) => {
  const { type, threadId } = req.params as { type: ThreadKind; threadId: string };
  const forceRefresh = req.query.refresh === "1";
  const markRead = req.query.markRead !== "0" && req.query.read !== "0";
  activity.record({
    ts: Date.now(),
    keyId: req.apiKeyEntry?.id ?? null,
    keyName: req.apiKeyEntry?.name ?? "",
    action: "open_thread",
    threadId,
    detail: { type, refresh: forceRefresh, markRead },
  });
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  if (type === "user") {
    const conversation = conversations.get(threadId);
    if (forceRefresh || !conversation?.avatar || isPlaceholderConversationName(threadId, conversation.name)) {
      await hydrateUserConversation(threadId).catch((error) => {
        res.setHeader("X-Zalo-Warning", errorMessage(error));
      });
    }
  }
  if (type === "group" && (forceRefresh || !messages.has(threadId))) {
    try {
      // upsertMessage dedupes by id, so re-pulling on refresh merges new
      // history into the cache rather than dropping what we already have.
      const history = await zaloApi.getGroupChatHistory(threadId, 100);
      for (const item of history.groupMsgs ?? []) upsertMessage(normalizeIncoming(item));
    } catch (error) {
      res.setHeader("X-Zalo-Warning", errorMessage(error));
    }
  }
  const threadMessages = messages.get(threadId) ?? [];
  const conversation = conversations.get(threadId);
  if (conversation && markRead) {
    const hadUnread = conversation.unread !== 0;
    conversation.unread = 0;
    conversation.manualUnread = false;
    schedulePersist();
    if (hadUnread) emitConversation(conversation);
  }
  // zca-js can fetch full history only for groups. For 1-1 chats the cache is
  // realtime-only, so tell the client to show a "from when server started"
  // hint when the cache is shallow.
  res.setHeader("X-Szalo-History", type === "group" ? "full" : "realtime-only");
  if (req.query.page === "1" || req.query.paged === "1") {
    const limit = boundedQueryNumber(req.query.limit, 220, 1, 500);
    const beforeTs = queryNumber(req.query.before ?? req.query.beforeTs);
    let endIndex = threadMessages.length;
    if (beforeTs !== null) {
      const index = threadMessages.findIndex((message) => message.timestamp >= beforeTs);
      endIndex = index === -1 ? threadMessages.length : index;
    }
    const startIndex = Math.max(0, endIndex - limit);
    const pageMessages = threadMessages.slice(startIndex, endIndex);
    res.json({
      messages: publicMessages(pageMessages),
      hasMore: startIndex > 0,
      total: threadMessages.length,
    });
    return;
  }
  res.json(publicMessages(threadMessages));
});

// === Rich messaging: reaction, undo (recall), sticker ===

app.post("/api/messages/reaction", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type, msgId, cliMsgId, icon } = req.body as {
    threadId?: string; type?: unknown; msgId?: string; cliMsgId?: string; icon?: string;
  };
  if (!threadId || !isThreadKind(type) || !msgId) {
    res.status(400).json({ error: "Missing threadId, type, msgId, or icon" });
    return;
  }
  const reactionIcon = (icon && icon in Reactions) ? Reactions[icon as keyof typeof Reactions] : (icon || Reactions.HEART);
  try {
    const result = await zaloApi.addReaction(
      reactionIcon as unknown as Parameters<typeof zaloApi.addReaction>[0],
      { data: { msgId, cliMsgId: cliMsgId || msgId }, threadId, type: asThreadType(type) },
    );
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/messages/undo", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type, msgId, cliMsgId } = req.body as {
    threadId?: string; type?: unknown; msgId?: string; cliMsgId?: string;
  };
  if (!threadId || !isThreadKind(type) || (!msgId && !cliMsgId)) {
    res.status(400).json({ error: "Missing threadId, type, or msgId/cliMsgId" });
    return;
  }
  try {
    const result = await zaloApi.undo(
      { msgId: msgId || cliMsgId || "", cliMsgId: cliMsgId || msgId || "" },
      threadId,
      asThreadType(type),
    );
    // Remove from local cache immediately
    applyUndo({ threadId, msgId, cliMsgId });
    io.emit("undo", { threadId, msgId, cliMsgId, isSelf: true });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/messages/sticker", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type, stickerId, cateId, stickerType } = req.body as {
    threadId?: string; type?: unknown; stickerId?: number; cateId?: number; stickerType?: number;
  };
  if (!threadId || !isThreadKind(type) || !stickerId || !cateId) {
    res.status(400).json({ error: "Missing threadId, type, stickerId, or cateId" });
    return;
  }
  try {
    const result = await zaloApi.sendSticker(
      { id: stickerId, cateId, type: stickerType ?? 7 },
      threadId,
      asThreadType(type),
    );
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Send card (share user profile) ===
app.post("/api/messages/card", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type, userId, phoneNumber } = req.body as {
    threadId?: string; type?: unknown; userId?: string; phoneNumber?: string;
  };
  if (!threadId || !isThreadKind(type) || !userId) {
    res.status(400).json({ error: "Cần threadId, type, userId" });
    return;
  }
  try {
    const result = await zaloApi.sendCard({ userId, phoneNumber }, threadId, asThreadType(type));
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Send bank card (Vietnam bank account info) ===
app.post("/api/messages/bank-card", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type, binBank, numAccBank, nameAccBank } = req.body as {
    threadId?: string; type?: unknown; binBank?: number; numAccBank?: string; nameAccBank?: string;
  };
  if (!threadId || !isThreadKind(type) || !binBank || !numAccBank?.trim()) {
    res.status(400).json({ error: "Cần threadId, type, binBank, numAccBank" });
    return;
  }
  try {
    const result = await zaloApi.sendBankCard({
      binBank: binBank as Parameters<typeof zaloApi.sendBankCard>[0]["binBank"],
      numAccBank: numAccBank.trim(),
      nameAccBank: nameAccBank?.trim(),
    }, threadId, asThreadType(type));
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Send voice message ===
// Client uploads the audio file (multipart/form-data field "voice"); we
// re-host it under /downloads and pass the public URL to zca-js.sendVoice.
app.post("/api/messages/voice", upload.single("voice"), async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const file = req.file as Express.Multer.File | undefined;
  const { threadId, type } = req.body as { threadId?: string; type?: unknown };
  if (!file) {
    res.status(400).json({ error: "Cần file âm thanh" });
    return;
  }
  if (!threadId || !isThreadKind(type)) {
    await unlink(file.path).catch(() => undefined);
    res.status(400).json({ error: "Cần threadId, type" });
    return;
  }
  try {
    // Build a public URL for the uploaded file. zca-js downloads the audio
    // from this URL and reuploads to Zalo's CDN, so it must be reachable
    // from the Internet — for local-only setups consider proxying via the
    // Cloudflare tunnel.
    const host = req.get("x-forwarded-host") || req.get("host") || `localhost:${PORT}`;
    const proto = req.get("x-forwarded-proto") || (req.secure ? "https" : "http");
    const voiceUrl = `${proto}://${host}/downloads/${path.basename(file.path)}`;
    const result = await zaloApi.sendVoice({ voiceUrl }, threadId, asThreadType(type));
    res.json({ ok: true, result, voiceUrl });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Bank list (BinBankCard enum exposed for client form) ===
app.get("/api/bank-bins", (_req, res) => {
  // Re-export as JSON so the client can build a dropdown without bundling zca-js.
  res.json(Object.entries(BinBankCard)
    .filter(([, value]) => typeof value === "number")
    .map(([name, value]) => ({ name, bin: value })));
});

app.get("/api/stickers", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const keyword = typeof req.query.q === "string" ? req.query.q : "";
    if (keyword) {
      const result = await zaloApi.searchSticker(keyword);
      res.json(result);
    } else {
      // getStickers requires a keyword — return empty for no-query
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Reactions enum for client ===
app.get("/api/reactions", (_req, res) => {
  res.json(Object.entries(Reactions).map(([key, value]) => ({ key, icon: value })));
});

// === Find user by phone / username ===
app.get("/api/users/find", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
  const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
  try {
    if (phone) {
      const result = await zaloApi.findUser(phone);
      res.json(result);
    } else if (username) {
      const result = await zaloApi.findUserByUsername(username);
      res.json(result);
    } else {
      res.status(400).json({ error: "Cần phone hoặc username" });
    }
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Friend requests ===
app.post("/api/friends/request", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { userId, message } = req.body as { userId?: string; message?: string };
  if (!userId) {
    res.status(400).json({ error: "Missing userId" });
    return;
  }
  try {
    const result = await zaloApi.sendFriendRequest(userId, message || "");
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Online status ===
app.get("/api/friends/online", async (_req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.getFriendOnlines();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Search messages across all threads ===
app.get("/api/search/messages", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  if (!query || query.length < 2) {
    res.status(400).json({ error: "Query phải có ít nhất 2 ký tự" });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const results: Array<ChatMessage & { conversationName?: string }> = [];
  for (const [threadId, list] of messages) {
    const conversation = conversations.get(threadId);
    for (const msg of list) {
      if (results.length >= limit) break;
      const searchable = `${msg.senderName ?? ""} ${msg.text} ${msg.attachments.map((a) => a.title ?? "").join(" ")}`.toLowerCase();
      if (searchable.includes(query)) {
        results.push({ ...publicMessage(msg), conversationName: conversation?.name });
      }
    }
    if (results.length >= limit) break;
  }
  results.sort((a, b) => b.timestamp - a.timestamp);
  res.json(results);
});

// === CRM Tools: Quick Replies, Labels, Auto-Reply ===

app.get("/api/quick-messages", async (_req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.getQuickMessageList();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/quick-messages", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { keyword, title } = req.body as { keyword?: string; title?: string };
  if (!keyword?.trim() || !title?.trim()) {
    res.status(400).json({ error: "Cần keyword và title" });
    return;
  }
  try {
    const result = await zaloApi.addQuickMessage({ keyword: keyword.trim(), title: title.trim() });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.delete("/api/quick-messages/:id", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.removeQuickMessage(Number(req.params.id) || req.params.id as unknown as number);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/labels", async (_req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.getLabels();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.put("/api/labels", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { labelData, version } = req.body as { labelData?: unknown[]; version?: number };
  if (!Array.isArray(labelData) || typeof version !== "number") {
    res.status(400).json({ error: "Cần labelData (array) và version (number)" });
    return;
  }
  try {
    const result = await zaloApi.updateLabels({ labelData: labelData as Parameters<typeof zaloApi.updateLabels>[0]["labelData"], version });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/auto-reply", async (_req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.getAutoReplyList();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/auto-reply", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { content, isEnable, startTime, endTime, scope, uids } = req.body as {
    content?: string; isEnable?: boolean; startTime?: number; endTime?: number;
    scope?: number; uids?: string | string[];
  };
  if (!content?.trim()) {
    res.status(400).json({ error: "Cần content" });
    return;
  }
  try {
    const result = await zaloApi.createAutoReply({
      content: content.trim(),
      isEnable: isEnable ?? true,
      startTime: startTime ?? 0,
      endTime: endTime ?? 0,
      scope: scope as Parameters<typeof zaloApi.createAutoReply>[0]["scope"] ?? 0,
      uids,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.delete("/api/auto-reply/:id", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.deleteAutoReply(Number(req.params.id));
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Reminders / follow-ups (per-thread) ===

app.get("/api/reminders/:type/:threadId", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { type, threadId } = req.params as { type: ThreadKind; threadId: string };
  if (!isThreadKind(type)) {
    res.status(400).json({ error: "Invalid thread type" });
    return;
  }
  const page = Number(req.query.page) || 1;
  const count = Number(req.query.count) || 50;
  try {
    const result = await zaloApi.getListReminder({ page, count }, threadId, asThreadType(type));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/reminders", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type, title, emoji, startTime, repeat } = req.body as {
    threadId?: string; type?: unknown; title?: string;
    emoji?: string; startTime?: number; repeat?: number;
  };
  if (!threadId || !isThreadKind(type) || !title?.trim()) {
    res.status(400).json({ error: "Cần threadId, type, title" });
    return;
  }
  try {
    const result = await zaloApi.createReminder({
      title: title.trim(),
      emoji: emoji || "📅",
      startTime: startTime || Date.now(),
      repeat: (repeat ?? 0) as Parameters<typeof zaloApi.createReminder>[0]["repeat"],
    }, threadId, asThreadType(type));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.delete("/api/reminders/:type/:threadId/:id", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { type, threadId, id } = req.params as { type: ThreadKind; threadId: string; id: string };
  if (!isThreadKind(type)) {
    res.status(400).json({ error: "Invalid thread type" });
    return;
  }
  try {
    const result = await zaloApi.removeReminder(id, threadId, asThreadType(type));
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

// === Last online status ===
app.get("/api/users/:userId/last-online", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  try {
    const result = await zaloApi.lastOnline(req.params.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/events/typing", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type } = req.body as { threadId: string; type: ThreadKind };
  await zaloApi.sendTypingEvent(threadId, asThreadType(type));
  res.json({ ok: true });
});

app.post("/api/events/seen", async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const { threadId, type } = req.body as { threadId: string; type: ThreadKind };
  if (!threadId || !isThreadKind(type)) {
    res.status(400).json({ error: "Missing or invalid threadId/type" });
    return;
  }
  const params = (messages.get(threadId) ?? [])
    .filter((message) => !message.isSelf)
    .map((message) => seenParamsFromRaw(message.raw))
    .filter((item): item is SendSeenEventMessageParams => item !== null);
  if (params.length > 0) {
    await zaloApi.sendSeenEvent(params.slice(-20), asThreadType(type));
  }
  const conversation = conversations.get(threadId);
  if (conversation && conversation.unread !== 0) {
    conversation.unread = 0;
    conversation.manualUnread = false;
    schedulePersist();
    emitConversation(conversation);
  }
  res.json({ ok: true, count: params.length });
});

app.post("/api/messages", upload.array("files", 10), async (req, res) => {
  if (!zaloApi) return res.status(401).json({ error: "Not logged in" });
  const files = (req.files ?? []) as Express.Multer.File[];
  const { threadId, type, text } = req.body as { threadId?: string; type?: unknown; text?: string };
  if (!threadId || !isThreadKind(type)) {
    await removeUploadedFiles(files);
    res.status(400).json({ error: "Missing or invalid threadId/type" });
    return;
  }
  if (!text?.trim() && files.length === 0) {
    res.status(400).json({ error: "Message text or file is required" });
    return;
  }

  activity.record({
    ts: Date.now(),
    keyId: req.apiKeyEntry?.id ?? null,
    keyName: req.apiKeyEntry?.name ?? "",
    action: "send_message",
    threadId,
    detail: { type, textLength: text?.length ?? 0, fileCount: files.length },
  });

  const attempt = recordSendAttempt({
    ts: Date.now(),
    threadId,
    type,
    textLength: text?.length ?? 0,
    fileCount: files.length,
    status: "started",
  });

  try {
    const messageText = text ?? "";
    const attachments = files.map((file) => file.path);

    // Rich message options from form body (JSON-encoded fields)
    let quote: MessageContent["quote"] | undefined;
    let mentions: MessageContent["mentions"] | undefined;
    let styles: MessageContent["styles"] | undefined;
    let ttl: number | undefined;
    try {
      if (req.body.quote) quote = typeof req.body.quote === "string" ? JSON.parse(req.body.quote) : req.body.quote;
      if (req.body.mentions) mentions = typeof req.body.mentions === "string" ? JSON.parse(req.body.mentions) : req.body.mentions;
      if (req.body.styles) styles = typeof req.body.styles === "string" ? JSON.parse(req.body.styles) : req.body.styles;
      if (req.body.ttl) ttl = Number(req.body.ttl) || undefined;
    } catch { /* ignore malformed rich fields */ }

    const hasRichFields = Boolean(quote || mentions || styles || ttl || attachments.length);
    const payload: string | MessageContent = hasRichFields
      ? { msg: messageText, attachments: attachments.length ? attachments : undefined, quote, mentions, styles, ttl }
      : messageText;
    const sendResult = await zaloApi.sendMessage(payload, threadId, asThreadType(type));
    const sent: ChatMessage = {
      id: String(sendResult.message?.msgId ?? Date.now()),
      threadId,
      type,
      senderId: selfId,
      senderName: "Ban",
      text: messageText,
      timestamp: Date.now(),
      isSelf: true,
      deliveryStatus: "sent",
      attachments: files.map((file) => ({
        title: file.originalname,
        href: `/downloads/${path.basename(file.path)}`,
        type: file.mimetype,
      })),
      raw: sendResult,
    };
    const update = upsertMessage(sent);
    const clientMessage = publicMessage(sent);
    io.emit("message", clientMessage);
    emitConversation(update.conversation);
    attempt.status = "sent";
    attempt.result = sendResult;
    res.json({ ok: true, result: sendResult, message: clientMessage });
  } catch (error) {
    await removeUploadedFiles(files);
    attempt.status = "failed";
    attempt.error = errorMessage(error);
    console.error(`sendMessage failed for ${type}:${threadId}: ${attempt.error}`);
    throw error;
  }
});

io.on("connection", (socket) => {
  const data = socket.data as { keyId?: string; keyName?: string };
  const keyId = data.keyId ?? "";
  const keyName = data.keyName ?? "";
  const ip = (socket.handshake.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? socket.handshake.address ?? "";
  const isAdmin = socket.handshake.auth?.admin === true || socket.handshake.auth?.admin === "true";

  liveConnections.set(socket.id, {
    socketId: socket.id,
    keyId,
    keyName,
    ip,
    connectedAt: Date.now(),
  });
  io.to("admins").emit("connections", Array.from(liveConnections.values()));
  activity.record({ ts: Date.now(), keyId, keyName, action: "connect", detail: { ip, socketId: socket.id, admin: isAdmin } });

  socket.on("disconnect", (reason) => {
    liveConnections.delete(socket.id);
    io.to("admins").emit("connections", Array.from(liveConnections.values()));
    activity.record({ ts: Date.now(), keyId, keyName, action: "disconnect", detail: { reason } });
  });

  // Admin-flagged sockets join the "admins" room for live admin events
  // (connections list + activity feed). They use the same API key — admin
  // is just an opt-in flag in the handshake.
  if (isAdmin) {
    socket.join("admins");
    socket.emit("connections", Array.from(liveConnections.values()));
    socket.emit("activity_history", activity.list({ limit: 200 }));
  }

  socket.emit("status", { state: loginState, account, selfId, qrImage, error: lastError, counts: conversationCounts(), serverStartedAt: SERVER_STARTED_AT });
  socket.emit("conversations", publicConversations());
  socket.emit("tunnel_status", tunnel.getStatus());
});

// Push every new activity event to admins in real time.
activity.on((event: ActivityEvent) => {
  io.to("admins").emit("activity", event);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next;
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "File is larger than 50MB"
      : error.code === "LIMIT_FILE_COUNT"
        ? "Maximum 10 files per message"
        : error.message;
    res.status(400).json({ error: message });
    return;
  }

  res.status(500).json({ error: errorMessage(error) });
});

async function bootstrap() {
  await mkdir(UPLOAD_DIR, { recursive: true });
  await loadLocalState();
  // Populate name cache from friends cache so group messages show names on boot
  const cachedFriends = await loadFriendsCache();
  for (const friend of cachedFriends) {
    const name = friend.displayName || friend.zaloName || "";
    if (name && name !== String(friend.userId)) {
      userNameCache.set(String(friend.userId), name);
    }
  }
  await restoreSession();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(PORT, () => {
      server.off("error", onError);
      console.log(`Szalo server listening on http://localhost:${PORT}`);
      console.log(`Admin UI: http://localhost:${PORT}/admin`);
      console.log(`Data dir: ${DATA_DIR}`);
      console.log(`CORS: ${CLIENT_ORIGIN_RAW}`);
      if (process.env.SZALO_EMBEDDED_SERVER === "1") {
        emitEmbeddedServerEvent("szalo-server-ready", {
          port: PORT,
          adminUrl: `http://localhost:${PORT}/admin`,
          dataDir: DATA_DIR,
        });
      }
      resolve();
    });
  });
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed:', error);
  if (process.env.SZALO_EMBEDDED_SERVER === "1") {
    emitEmbeddedServerEvent("szalo-server-error", error);
    return;
  }
  process.exit(1);
});
