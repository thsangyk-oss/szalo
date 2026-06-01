import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { Readable } from "node:stream";
import multer from "multer";
import { Server } from "socket.io";
import { TunnelManager } from "./tunnel";
import { Database } from "./db";
import { AdminSessions } from "./admin";
import { ActivityLog, type ActivityEvent } from "./activity";
import { CloudflaredManager } from "./cloudflared";
import { CategoryStore } from "./categories";
import {
  AvatarSize,
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
const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, ".zalo-manager");
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(DATA_DIR, "db.json");
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");
const SESSION_FILE = path.join(DATA_DIR, "session.json");

// Server config (API keys + admin password) lives in db.json — generated on
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
let persistTimer: NodeJS.Timeout | null = null;

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

  // Regular API: gated by a key from db.json. Multi-key — admin can disable
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

    const conversation = mergeConversation({
      id: userId,
      type: "user",
      name: profile.displayName || profile.zaloName || userId,
      avatar: profile.avatar,
      raw: profile,
    }, { preferIncomingName: true });

    if (conversationIdentityChanged(before, conversation)) {
      schedulePersist();
      if (emit) io.emit("conversations", sortedConversations());
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
  return {
    id: String(data.msgId ?? data.cliMsgId ?? `${message.threadId}-${Date.now()}`),
    threadId: String(message.threadId),
    type,
    senderId: isSelf && rawSenderId === "0" ? selfId : rawSenderId,
    senderName: String(data.dName ?? ""),
    text: pickText(data.content),
    timestamp: Number(data.ts ?? Date.now()),
    isSelf,
    deliveryStatus: isSelf ? "sent" : undefined,
    attachments: pickAttachments(data.content),
    raw: message,
  };
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
  const hasNewIncomingMessage = !message.isSelf && isNew;
  mergeConversation({
    id: message.threadId,
    type: message.type,
    name: message.isSelf ? undefined : message.senderName,
    lastMessage: message.text || (message.attachments.length ? "Attachment" : ""),
    lastTimestamp: message.timestamp,
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
    recordListenerEvent("connected");
    loginState = "online";
    emitState();
  });
  api.listener.on("disconnected", (_code, reason) => {
    recordListenerEvent("disconnected", { reason });
    lastError = reason;
    emitState();
  });
  api.listener.on("error", (error) => {
    recordListenerEvent("error", { error: errorMessage(error) });
    lastError = errorMessage(error);
    emitState();
  });
  api.listener.on("message", (message) => {
    const normalized = normalizeIncoming(message);
    recordListenerEvent("message", {
      threadId: normalized.threadId,
      type: normalized.type,
      isSelf: normalized.isSelf,
      senderId: normalized.senderId,
      textLength: normalized.text.length,
      fileCount: normalized.attachments.length,
    });
    upsertMessage(normalized);
    io.emit("message", normalized);
    io.emit("conversations", sortedConversations());
  });
  api.listener.on("typing", (typing) => {
    recordListenerEvent("typing", { threadId: typing.threadId, isSelf: typing.isSelf });
    io.emit("typing", typing);
  });
  api.listener.on("seen_messages", (items) => {
    const updates = markDeliveryStatus(items, "seen");
    recordListenerEvent("seen_messages", { count: items.length, updates: updates.length });
    io.emit("seen_messages", items);
  });
  api.listener.on("delivered_messages", (items) => {
    const updates = markDeliveryStatus(items, "delivered");
    recordListenerEvent("delivered_messages", { count: items.length, updates: updates.length });
    io.emit("delivered_messages", items);
  });
  api.listener.on("group_event", (event) => {
    recordListenerEvent("group_event", { threadId: event.threadId, isSelf: event.isSelf, type: event.type });
    io.emit("group_event", event);
  });
  api.listener.on("friend_event", (event) => {
    recordListenerEvent("friend_event", { isSelf: event.isSelf, type: event.type });
    io.emit("friend_event", event);
  });
  api.listener.on("reaction", (reaction) => {
    recordListenerEvent("reaction", { threadId: reaction.threadId, isSelf: reaction.isSelf });
    io.emit("reaction", reaction);
  });
  api.listener.on("undo", (undo) => {
    recordListenerEvent("undo", { threadId: undo.threadId, isSelf: undo.isSelf });
    applyUndo({ threadId: String(undo.threadId), msgId: (undo as { msgId?: string | number }).msgId, cliMsgId: (undo as { cliMsgId?: string | number }).cliMsgId });
    io.emit("undo", undo);
  });
  api.listener.start({ retryOnClose: true });
  void refreshConversationControls()
    .then(() => io.emit("conversations", sortedConversations()))
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
  if (!tunnelName || !domain || !subdomain) {
    res.status(400).json({ error: "Cần đủ tunnel name, domain, subdomain" });
    return;
  }
  db.setCloudflareConfig({ tunnelName, domain, subdomain });
  const status = await tunnel.startNamed(PORT, tunnelName, subdomain, domain);
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
  const maxPages = Math.max(1, Math.min(Number(_req.query.pages ?? 1), 10));
  const friends: User[] = [];
  let warning = "";
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      if (page > 1) await delay(800);
      const batch = (await zaloApi.getAllFriends(pageSize, page, AvatarSize.Large)) as User[];
      friends.push(...batch);
      if (batch.length < pageSize) break;
    }
  } catch (error) {
    warning = errorMessage(error);
    if (friends.length === 0) friends.push(...await loadFriendsCache());
  }
  if (friends.length > 0) {
    await saveFriendsCache(friends);
  }
  for (const friend of friends) {
    mergeConversation({
      id: String(friend.userId),
      type: "user",
      name: friend.displayName || friend.zaloName || String(friend.userId),
      avatar: friend.avatar,
      raw: friend,
    }, { preferIncomingName: true });
  }
  schedulePersist();
  io.emit("conversations", sortedConversations());
  if (warning) res.setHeader("X-Zalo-Warning", warning);
  res.json(friends);
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
  io.emit("conversations", sortedConversations());
  res.json(sortedConversations().filter((item) => item.type === "group"));
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
    io.emit("conversations", sortedConversations());
  }

  const memberIds = Array.from(new Set([
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
    return {
      id,
      displayName: profile?.displayName || fallback?.displayName || id,
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
  res.json(sortedConversations());
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
  io.emit("conversations", sortedConversations());
  res.json({ ok: true, conversation, action });
});

app.get("/api/messages/:type/:threadId", async (req, res) => {
  const { type, threadId } = req.params as { type: ThreadKind; threadId: string };
  const forceRefresh = req.query.refresh === "1";
  activity.record({
    ts: Date.now(),
    keyId: req.apiKeyEntry?.id ?? null,
    keyName: req.apiKeyEntry?.name ?? "",
    action: "open_thread",
    threadId,
    detail: { type, refresh: forceRefresh },
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
  if (conversation) {
    const hadUnread = conversation.unread !== 0;
    conversation.unread = 0;
    conversation.manualUnread = false;
    schedulePersist();
    if (hadUnread) io.emit("conversations", sortedConversations());
  }
  // zca-js can fetch full history only for groups. For 1-1 chats the cache is
  // realtime-only, so tell the client to show a "from when server started"
  // hint when the cache is shallow.
  res.setHeader("X-Szalo-History", type === "group" ? "full" : "realtime-only");
  res.json(threadMessages);
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
        results.push({ ...msg, conversationName: conversation?.name });
      }
    }
    if (results.length >= limit) break;
  }
  results.sort((a, b) => b.timestamp - a.timestamp);
  res.json(results);
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
    io.emit("conversations", sortedConversations());
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
    const result = await zaloApi.sendMessage(payload, threadId, asThreadType(type));
    const sent: ChatMessage = {
      id: String(result.message?.msgId ?? Date.now()),
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
      raw: result,
    };
    upsertMessage(sent);
    io.emit("message", sent);
    io.emit("conversations", sortedConversations());
    attempt.status = "sent";
    attempt.result = result;
    res.json({ ok: true, result, message: sent });
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
  socket.emit("conversations", sortedConversations());
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
  await restoreSession();

  server.listen(PORT, () => {
    console.log(`Szalo server listening on http://localhost:${PORT}`);
    console.log(`Admin UI: http://localhost:${PORT}/admin`);
    console.log(`Data dir: ${DATA_DIR}`);
    console.log(`CORS: ${CLIENT_ORIGIN_RAW}`);
  });
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
