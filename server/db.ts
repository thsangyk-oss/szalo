/**
 * JSON file store for server config: API keys + admin password + cloudflare config.
 *
 * Multi-key model: each key has an id, human-friendly name, the key string
 * itself, and a disabled flag. Admin can rename / disable / revoke individually
 * so per-machine access is auditable.
 *
 * Auto-migrates the previous single-key schema (`{apiKey: "..."}`) into the
 * multi-key shape on first read, so existing installs keep working.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ApiKey = {
  id: string;
  name: string;
  key: string;
  disabled: boolean;
  createdAt: string;
  lastSeenAt?: string;
  lastSeenIp?: string;
};

export type CloudflareConfig = {
  tunnelName: string;
  domain?: string;
  subdomain?: string;
};

export type ServerDb = {
  apiKeys: ApiKey[];
  adminPasswordHash: string;
  cloudflare: CloudflareConfig;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_PASSWORD = "123456";
const DEFAULT_TUNNEL_NAME = "szalo";

function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const candidate = scryptSync(password, salt, expected.length);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function newApiKeyEntry(name: string): ApiKey {
  return {
    id: randomBytes(8).toString("hex"),
    name,
    key: generateApiKey(),
    disabled: false,
    createdAt: new Date().toISOString(),
  };
}

export class Database {
  private readonly file: string;
  private data: ServerDb;
  private lastSeenTimer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.data = this.loadOrInit();
  }

  private loadOrInit(): ServerDb {
    if (existsSync(this.file)) {
      try {
        const raw = readFileSync(this.file, "utf8");
        return this.normalize(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        console.warn(`${path.basename(this.file)} unreadable (${error instanceof Error ? error.message : String(error)}) — recreating.`);
      }
    }
    const fresh = this.makeFresh();
    this.persist(fresh);
    console.log(`Initialized ${path.basename(this.file)} — admin password defaults to "${DEFAULT_PASSWORD}". Change it via /admin.`);
    return fresh;
  }

  private makeFresh(): ServerDb {
    const now = new Date().toISOString();
    return {
      apiKeys: [newApiKeyEntry("default")],
      adminPasswordHash: hashPassword(DEFAULT_PASSWORD),
      cloudflare: { tunnelName: DEFAULT_TUNNEL_NAME },
      createdAt: now,
      updatedAt: now,
    };
  }

  private normalize(parsed: Record<string, unknown>): ServerDb {
    const now = new Date().toISOString();
    let apiKeys = Array.isArray(parsed.apiKeys) ? parsed.apiKeys as ApiKey[] : [];

    // Migrate old single-key schema {apiKey: "..."} → multi-key.
    if (apiKeys.length === 0 && typeof parsed.apiKey === "string" && parsed.apiKey) {
      apiKeys = [{
        id: randomBytes(8).toString("hex"),
        name: "default",
        key: parsed.apiKey,
        disabled: false,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : now,
      }];
    }
    if (apiKeys.length === 0) apiKeys = [newApiKeyEntry("default")];

    const cf = (parsed.cloudflare && typeof parsed.cloudflare === "object")
      ? parsed.cloudflare as Partial<CloudflareConfig>
      : {};

    const data: ServerDb = {
      apiKeys,
      adminPasswordHash: typeof parsed.adminPasswordHash === "string"
        ? parsed.adminPasswordHash
        : hashPassword(DEFAULT_PASSWORD),
      cloudflare: { tunnelName: cf.tunnelName || DEFAULT_TUNNEL_NAME, domain: cf.domain, subdomain: cf.subdomain },
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : now,
      updatedAt: now,
    };

    // Persist healed shape so the file matches the type going forward.
    this.persist(data);
    return data;
  }

  private persist(data?: ServerDb) {
    const payload = data ?? this.data;
    payload.updatedAt = new Date().toISOString();
    writeFileSync(this.file, JSON.stringify(payload, null, 2), "utf8");
  }

  // ===== API keys =====

  listApiKeys(): ApiKey[] {
    return this.data.apiKeys.map((entry) => ({ ...entry }));
  }

  findApiKey(key: string): ApiKey | undefined {
    if (!key) return undefined;
    const provided = Buffer.from(key);
    for (const entry of this.data.apiKeys) {
      const candidate = Buffer.from(entry.key);
      if (candidate.length === provided.length && timingSafeEqual(candidate, provided)) {
        return { ...entry };
      }
    }
    return undefined;
  }

  findApiKeyById(id: string): ApiKey | undefined {
    const entry = this.data.apiKeys.find((k) => k.id === id);
    return entry ? { ...entry } : undefined;
  }

  createApiKey(name: string): ApiKey {
    const trimmed = name.trim() || `key-${this.data.apiKeys.length + 1}`;
    const entry = newApiKeyEntry(trimmed);
    this.data.apiKeys.push(entry);
    this.persist();
    return { ...entry };
  }

  renameApiKey(id: string, name: string): boolean {
    const entry = this.data.apiKeys.find((k) => k.id === id);
    if (!entry) return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    entry.name = trimmed;
    this.persist();
    return true;
  }

  setApiKeyDisabled(id: string, disabled: boolean): boolean {
    const entry = this.data.apiKeys.find((k) => k.id === id);
    if (!entry) return false;
    entry.disabled = disabled;
    this.persist();
    return true;
  }

  revokeApiKey(id: string): boolean {
    const before = this.data.apiKeys.length;
    this.data.apiKeys = this.data.apiKeys.filter((k) => k.id !== id);
    if (this.data.apiKeys.length === before) return false;
    // Keep at least one key so the server is never unreachable.
    if (this.data.apiKeys.length === 0) this.data.apiKeys.push(newApiKeyEntry("default"));
    this.persist();
    return true;
  }

  markApiKeyUsed(id: string, ip?: string) {
    const entry = this.data.apiKeys.find((k) => k.id === id);
    if (!entry) return;
    entry.lastSeenAt = new Date().toISOString();
    if (ip) entry.lastSeenIp = ip;
    if (this.lastSeenTimer) return;
    // Debounce — every active client can hit this many times per second.
    this.lastSeenTimer = setTimeout(() => {
      this.lastSeenTimer = null;
      this.persist();
    }, 5000);
  }

  // ===== Admin password =====

  verifyAdminPassword(password: string): boolean {
    return verifyPassword(password, this.data.adminPasswordHash);
  }

  setAdminPassword(password: string) {
    this.data.adminPasswordHash = hashPassword(password);
    this.persist();
  }

  // ===== Cloudflare =====

  getCloudflareConfig(): CloudflareConfig {
    return { ...this.data.cloudflare };
  }

  setCloudflareConfig(patch: Partial<CloudflareConfig>) {
    this.data.cloudflare = { ...this.data.cloudflare, ...patch };
    this.persist();
  }

  meta() {
    return { createdAt: this.data.createdAt, updatedAt: this.data.updatedAt };
  }
}
