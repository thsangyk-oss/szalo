/**
 * Per-Zalo-account category (channel/workspace) store.
 *
 * Categories group conversations into Slack-style channels. They're keyed by
 * the logged-in Zalo account id (selfId) so that whichever machine logs into
 * that account gets the same grouping back — the desktop client no longer
 * keeps them only in its own localStorage.
 *
 * Shape on disk (categories.json):
 *   { "<selfId>": [ { id, name, color, threadIds: [] }, ... ], ... }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type Category = {
  id: string;
  name: string;
  color: string;
  threadIds: string[];
};

type Store = Record<string, Category[]>;

export class CategoryStore {
  private readonly file: string;
  private data: Store = {};
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object") this.data = parsed as Store;
    } catch {
      // Corrupt file — start fresh.
    }
  }

  get(selfId: string): Category[] {
    if (!selfId) return [];
    return (this.data[selfId] ?? []).map((category) => ({ ...category, threadIds: [...category.threadIds] }));
  }

  set(selfId: string, categories: Category[]): Category[] {
    if (!selfId) return [];
    const sanitized = sanitizeCategories(categories);
    this.data[selfId] = sanitized;
    this.schedulePersist();
    return sanitized.map((category) => ({ ...category, threadIds: [...category.threadIds] }));
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf8");
      } catch (error) {
        console.warn("categories.json write failed:", error instanceof Error ? error.message : String(error));
      }
    }, 500);
  }
}

function sanitizeCategories(input: unknown): Category[] {
  if (!Array.isArray(input)) return [];
  const result: Category[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    const id = typeof value.id === "string" && value.id ? value.id : null;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!id || !name) continue;
    const color = typeof value.color === "string" ? value.color : "#7c5cff";
    const threadIds = Array.isArray(value.threadIds)
      ? Array.from(new Set(value.threadIds.filter((t): t is string => typeof t === "string")))
      : [];
    result.push({ id, name, color, threadIds });
  }
  return result.slice(0, 100);
}
