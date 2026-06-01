/**
 * Cloudflared binary manager.
 *
 * - Detects an existing `cloudflared` in PATH or in <DATA_DIR>/bin/cloudflared(.exe).
 * - Downloads the right binary for the current platform from GitHub releases
 *   when missing — no manual install required.
 * - Surfaces download progress via an EventEmitter so the admin UI can render
 *   a percentage.
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const DOWNLOAD_TIMEOUT_MS = 180_000;

export type CloudflaredStatus = {
  installed: boolean;
  path: string;
  source: "path" | "local" | "downloading" | "missing";
  version?: string;
  downloading: boolean;
  progress?: number;        // 0-100
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
};

function platformAsset(): { name: string; isExe: boolean; isTgz: boolean } | null {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "win32") {
    if (arch === "x64") return { name: "cloudflared-windows-amd64.exe", isExe: true, isTgz: false };
    if (arch === "arm64") return { name: "cloudflared-windows-arm64.exe", isExe: true, isTgz: false };
    if (arch === "ia32") return { name: "cloudflared-windows-386.exe", isExe: true, isTgz: false };
  } else if (platform === "darwin") {
    if (arch === "x64") return { name: "cloudflared-darwin-amd64.tgz", isExe: true, isTgz: true };
    if (arch === "arm64") return { name: "cloudflared-darwin-arm64.tgz", isExe: true, isTgz: true };
  } else if (platform === "linux") {
    if (arch === "x64") return { name: "cloudflared-linux-amd64", isExe: true, isTgz: false };
    if (arch === "arm64") return { name: "cloudflared-linux-arm64", isExe: true, isTgz: false };
    if (arch === "arm") return { name: "cloudflared-linux-arm", isExe: true, isTgz: false };
  }
  return null;
}

function localBinaryPath(dataDir: string): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(dataDir, "bin", `cloudflared${ext}`);
}

function probeBinary(binary: string): { ok: boolean; version?: string } {
  try {
    const result = spawnSync(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (result.status === 0) {
      const text = String(result.stdout || result.stderr || "").trim();
      const match = text.match(/(\d+\.\d+\.\d+)/);
      return { ok: true, version: match ? match[1] : text.slice(0, 80) };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class CloudflaredManager extends EventEmitter {
  private readonly dataDir: string;
  private downloading = false;
  private progress = 0;
  private downloadedBytes = 0;
  private totalBytes = 0;
  private lastError = "";
  private cachedSource: CloudflaredStatus["source"] = "missing";

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
  }

  /**
   * Resolve which `cloudflared` binary to use:
   * 1. local bundled copy under <DATA_DIR>/bin/cloudflared
   * 2. system PATH
   *
   * Result is cached in-memory.
   */
  resolve(): string {
    const local = localBinaryPath(this.dataDir);
    if (existsSync(local) && probeBinary(local).ok) {
      this.cachedSource = "local";
      return local;
    }
    const probe = probeBinary("cloudflared");
    if (probe.ok) {
      this.cachedSource = "path";
      return "cloudflared";
    }
    this.cachedSource = "missing";
    return "";
  }

  status(): CloudflaredStatus {
    if (this.downloading) {
      return {
        installed: false,
        path: "",
        source: "downloading",
        downloading: true,
        progress: this.progress,
        downloadedBytes: this.downloadedBytes,
        totalBytes: this.totalBytes,
        error: this.lastError,
      };
    }
    const binary = this.resolve();
    if (!binary) {
      return { installed: false, path: "", source: "missing", downloading: false, error: this.lastError };
    }
    const probe = probeBinary(binary);
    return {
      installed: probe.ok,
      path: binary,
      source: this.cachedSource,
      version: probe.version,
      downloading: false,
    };
  }

  async install(): Promise<CloudflaredStatus> {
    if (this.downloading) return this.status();

    const asset = platformAsset();
    if (!asset) {
      this.lastError = `Không có binary cloudflared cho ${process.platform}/${process.arch}`;
      this.emit("status", this.status());
      return this.status();
    }

    this.downloading = true;
    this.progress = 0;
    this.downloadedBytes = 0;
    this.totalBytes = 0;
    this.lastError = "";
    this.emit("status", this.status());

    let tmpPath = "";
    try {
      const binDir = path.join(this.dataDir, "bin");
      mkdirSync(binDir, { recursive: true });

      const url = `${RELEASE_BASE}/${asset.name}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} khi tải ${url}`);
      }
      this.totalBytes = Number(response.headers.get("content-length") ?? 0);

      const localPath = localBinaryPath(this.dataDir);
      tmpPath = asset.isTgz
        ? path.join(binDir, `download-${Date.now()}.tgz`)
        : `${localPath}.partial`;

      const fileStream = createWriteStream(tmpPath);
      const reader = Readable.fromWeb(response.body);
      reader.on("data", (chunk: Buffer) => {
        this.downloadedBytes += chunk.length;
        if (this.totalBytes > 0) {
          const next = Math.floor((this.downloadedBytes / this.totalBytes) * 100);
          if (next !== this.progress) {
            this.progress = next;
            this.emit("status", this.status());
          }
        }
      });
      await pipeline(reader, fileStream);

      // For .tgz (macOS), extract the binary inside.
      if (asset.isTgz) {
        // Best-effort tar extraction using the system tar (Windows 10+ ships it,
        // macOS has it natively). cloudflared archives are simple — single file.
        const extract = spawnSync("tar", ["-xzf", tmpPath, "-C", binDir], { stdio: ["ignore", "pipe", "pipe"] });
        if (extract.status !== 0) {
          throw new Error(`tar extract failed: ${extract.stderr?.toString() || "exit " + extract.status}`);
        }
        // The extracted binary is named "cloudflared" — rename to localPath.
        const extracted = path.join(binDir, "cloudflared");
        if (extracted !== localPath && existsSync(extracted)) {
          // already at localPath on darwin (no .exe)
          if (extracted !== localPath) {
            const fs = await import("node:fs/promises");
            await fs.rename(extracted, localPath);
          }
        }
        await rm(tmpPath, { force: true });
      } else {
        // Direct binary — atomically move to final path.
        const fs = await import("node:fs/promises");
        if (existsSync(localPath)) await rm(localPath, { force: true });
        await fs.rename(tmpPath, localPath);
      }

      // chmod +x on Unix-likes (Windows ignores).
      if (process.platform !== "win32") {
        try { chmodSync(localPath, 0o755); } catch { /* ignore */ }
      }

      // Probe to confirm.
      const probe = probeBinary(localPath);
      if (!probe.ok) {
        const sizeKb = Math.round(statSync(localPath).size / 1024);
        throw new Error(`Tải xong (${sizeKb} KB) nhưng cloudflared không chạy được — kiểm tra đĩa hoặc anti-virus.`);
      }

      this.cachedSource = "local";
      this.downloading = false;
      this.progress = 100;
      this.emit("status", this.status());
      return this.status();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.downloading = false;
      if (tmpPath && existsSync(tmpPath)) await rm(tmpPath, { force: true });
      this.emit("status", this.status());
      return this.status();
    }
  }
}
