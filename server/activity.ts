/**
 * Capped activity log persisted to JSON.
 *
 * Every meaningful client action (connect, open thread, send message,
 * Zalo login, etc) is recorded with the API key that performed it. Used by
 * the admin "Connection Watch" tab to audit who did what.
 *
 * - Capped at MAX_EVENTS (oldest dropped) so the file stays bounded.
 * - Writes are debounced (≥ 1s) so a burst of socket events doesn't thrash disk.
 * - Listeners get notified synchronously so the admin UI can subscribe via
 *   socket.io for live updates.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ActivityEvent = {
  ts: number;
  keyId: string | null;
  keyName: string;
  action: "connect" | "disconnect" | "open_thread" | "send_message" | "zalo_login" | "zalo_logout" | string;
  threadId?: string;
  detail?: Record<string, unknown>;
};

const MAX_EVENTS = 5000;
const PERSIST_DELAY_MS = 1000;

export class ActivityLog {
  private readonly file: string;
  private events: ActivityEvent[] = [];
  private persistTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(event: ActivityEvent) => void>();

  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.events = parsed;
    } catch {
      // Corrupt file — start fresh, keep going.
    }
  }

  record(event: ActivityEvent) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* ignore */ }
    }
    this.schedulePersist();
  }

  list(filter: { keyId?: string; since?: number; limit?: number } = {}): ActivityEvent[] {
    let result = this.events;
    if (filter.keyId) result = result.filter((event) => event.keyId === filter.keyId);
    if (filter.since) result = result.filter((event) => event.ts >= (filter.since as number));
    if (filter.limit && filter.limit > 0) result = result.slice(-filter.limit);
    return result;
  }

  on(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        writeFileSync(this.file, JSON.stringify(this.events), "utf8");
      } catch (error) {
        console.warn("activity.json write failed:", error instanceof Error ? error.message : String(error));
      }
    }, PERSIST_DELAY_MS);
  }
}
