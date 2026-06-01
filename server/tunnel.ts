/**
 * Cloudflare Quick Tunnel manager.
 *
 * Wraps `cloudflared tunnel --url http://localhost:<port>` so the user can
 * expose the local server to the public internet without owning a domain.
 * Parses the trycloudflare.com URL out of cloudflared's logs and exposes
 * start/stop/status to the admin endpoints.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";

export type TunnelStatus = {
  state: "stopped" | "starting" | "running" | "error";
  publicUrl: string;
  error: string;
  startedAt: number;
  recentLogs: string[];
};

const URL_PATTERN = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const MAX_LOGS = 60;

export class TunnelManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private status: TunnelStatus = {
    state: "stopped",
    publicUrl: "",
    error: "",
    startedAt: 0,
    recentLogs: [],
  };

  getStatus(): TunnelStatus {
    return { ...this.status, recentLogs: [...this.status.recentLogs] };
  }

  async start(localPort: number): Promise<TunnelStatus> {
    if (this.child) return this.getStatus();

    this.status = {
      state: "starting",
      publicUrl: "",
      error: "",
      startedAt: Date.now(),
      recentLogs: [],
    };
    this.emit("status", this.getStatus());

    let child: ChildProcess;
    try {
      child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${localPort}`], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.status.state = "error";
      this.status.error = errorMessage(error);
      this.emit("status", this.getStatus());
      return this.getStatus();
    }

    this.child = child;

    child.on("error", (error: Error & { code?: string }) => {
      this.status.state = "error";
      this.status.error = error.code === "ENOENT"
        ? "cloudflared chưa được cài. Tải tại https://github.com/cloudflare/cloudflared/releases và đảm bảo có trong PATH."
        : errorMessage(error);
      this.recordLog(`[error] ${this.status.error}`);
      this.emit("status", this.getStatus());
    });

    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.recordLog(line);
        const match = line.match(URL_PATTERN);
        if (match && !this.status.publicUrl) {
          this.status.publicUrl = match[0];
          this.status.state = "running";
          this.status.error = "";
          this.emit("status", this.getStatus());
        }
      }
    };
    (child.stdout as Readable | null)?.on("data", consume);
    (child.stderr as Readable | null)?.on("data", consume);

    child.on("exit", (code, signal) => {
      const wasRunning = this.status.state === "running";
      this.child = null;
      if (this.status.state !== "error") {
        this.status.state = "stopped";
        if (wasRunning) {
          this.status.error = `Tunnel kết thúc (code ${code ?? "n/a"}, signal ${signal ?? "n/a"})`;
        }
      }
      this.status.publicUrl = "";
      this.emit("status", this.getStatus());
    });

    return this.getStatus();
  }

  async stop(): Promise<TunnelStatus> {
    if (!this.child) return this.getStatus();
    const child = this.child;
    return new Promise((resolve) => {
      const finalize = () => {
        this.child = null;
        this.status.state = "stopped";
        this.status.publicUrl = "";
        this.emit("status", this.getStatus());
        resolve(this.getStatus());
      };
      child.once("exit", finalize);
      try {
        child.kill();
      } catch {
        finalize();
      }
      // Force-kill after 5s if it doesn't exit gracefully.
      setTimeout(() => {
        if (this.child === child) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          finalize();
        }
      }, 5000);
    });
  }

  private recordLog(line: string) {
    this.status.recentLogs.push(`${new Date().toISOString()} ${line}`);
    if (this.status.recentLogs.length > MAX_LOGS) {
      this.status.recentLogs.splice(0, this.status.recentLogs.length - MAX_LOGS);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
