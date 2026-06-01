/**
 * Admin session manager — issues bearer tokens after a successful password
 * login, expires them after a TTL, and exposes a middleware-friendly verify.
 *
 * Tokens live only in memory: restarting the server logs every admin out.
 * That's fine for an admin panel — the key + password persist in zalodata.json.
 */
import { randomBytes } from "node:crypto";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export class AdminSessions {
  private tokens = new Map<string, number>(); // token → expiresAt (ms)
  private sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  issue(): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
  }

  isValid(token: string): boolean {
    if (!token) return false;
    const expiresAt = this.tokens.get(token);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string) {
    this.tokens.delete(token);
  }

  private sweep() {
    const now = Date.now();
    for (const [token, expiresAt] of this.tokens) {
      if (expiresAt < now) this.tokens.delete(token);
    }
  }
}
