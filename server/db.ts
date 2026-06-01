/**
 * Tiny JSON file store for server config: API key + admin password hash.
 *
 * - First boot: generates a 32-byte hex API key and seeds the admin password
 *   to "123456" (so the user can log in to /admin and immediately rotate).
 * - Reads + writes are synchronous because the data is tiny (a single object)
 *   and we only touch it on boot, password change, or key rotation.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ServerDb = {
  apiKey: string;
  adminPasswordHash: string;   // "scrypt:<saltHex>:<hashHex>"
  createdAt: string;
  updatedAt: string;
};

const SCRYPT_KEYLEN = 64;
const DEFAULT_PASSWORD = "123456";

function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
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

export class Database {
  private data: ServerDb;

  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.data = this.loadOrInit();
  }

  private loadOrInit(): ServerDb {
    if (existsSync(this.file)) {
      try {
        const raw = readFileSync(this.file, "utf8");
        const parsed = JSON.parse(raw) as Partial<ServerDb>;
        // Heal a missing API key or password — keeps the server usable even
        // if the file was hand-edited.
        const now = new Date().toISOString();
        const next: ServerDb = {
          apiKey: parsed.apiKey || generateApiKey(),
          adminPasswordHash: parsed.adminPasswordHash || hashPassword(DEFAULT_PASSWORD),
          createdAt: parsed.createdAt || now,
          updatedAt: now,
        };
        if (next.apiKey !== parsed.apiKey || next.adminPasswordHash !== parsed.adminPasswordHash) {
          this.persist(next);
        }
        return next;
      } catch (error) {
        console.warn(`db.json unreadable (${error instanceof Error ? error.message : String(error)}) — recreating.`);
      }
    }
    const now = new Date().toISOString();
    const fresh: ServerDb = {
      apiKey: generateApiKey(),
      adminPasswordHash: hashPassword(DEFAULT_PASSWORD),
      createdAt: now,
      updatedAt: now,
    };
    this.persist(fresh);
    console.log(`Initialized ${path.basename(this.file)} — admin password defaults to "${DEFAULT_PASSWORD}". Change it via /admin.`);
    return fresh;
  }

  private persist(data: ServerDb) {
    writeFileSync(this.file, JSON.stringify(data, null, 2), "utf8");
  }

  getApiKey(): string {
    return this.data.apiKey;
  }

  verifyAdminPassword(password: string): boolean {
    return verifyPassword(password, this.data.adminPasswordHash);
  }

  setAdminPassword(password: string) {
    this.data = { ...this.data, adminPasswordHash: hashPassword(password), updatedAt: new Date().toISOString() };
    this.persist(this.data);
  }

  rotateApiKey(): string {
    this.data = { ...this.data, apiKey: generateApiKey(), updatedAt: new Date().toISOString() };
    this.persist(this.data);
    return this.data.apiKey;
  }

  meta() {
    return { createdAt: this.data.createdAt, updatedAt: this.data.updatedAt };
  }
}
