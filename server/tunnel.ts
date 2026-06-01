/**
 * Cloudflare Tunnel manager — supports two modes:
 *
 *   quick:  `cloudflared tunnel --url http://localhost:<port>`
 *           Sinh subdomain *.trycloudflare.com tạm thời, không cần tài khoản.
 *
 *   named:  Yêu cầu user đã chạy `cloudflared tunnel login` (ta wrap như một
 *           bước riêng — `authorize()`). Sau đó tạo tunnel theo `tunnelName`,
 *           route DNS `<subdomain>.<domain>`, và chạy với
 *           `cloudflared tunnel run --url http://localhost:<port> <name>`.
 *           URL ổn định, gắn với domain của user trên Cloudflare.
 *
 * State của tunnel được broadcast qua EventEmitter để admin UI cập nhật realtime.
 */
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";

export type TunnelMode = "quick" | "named";

export type TunnelStatus = {
  state: "stopped" | "starting" | "running" | "error";
  mode: TunnelMode | null;
  publicUrl: string;
  error: string;
  startedAt: number;
  recentLogs: string[];
};

const URL_PATTERN = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const MAX_LOGS = 80;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runOnce(binary: string, args: string[], options: SpawnOptionsWithoutStdio = {}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    (child.stdout as Readable | null)?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    (child.stderr as Readable | null)?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

export class TunnelManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly resolveBinary: () => string;
  private status: TunnelStatus = {
    state: "stopped",
    mode: null,
    publicUrl: "",
    error: "",
    startedAt: 0,
    recentLogs: [],
  };

  constructor(resolveBinary: () => string) {
    super();
    this.resolveBinary = resolveBinary;
  }

  private getBinary(): string {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new Error("cloudflared chưa cài. Vào tab Cloudflare Tunnel → bấm \"Tải cloudflared\" để cài tự động, hoặc cài thủ công từ github.com/cloudflare/cloudflared/releases.");
    }
    return binary;
  }

  getStatus(): TunnelStatus {
    return { ...this.status, recentLogs: [...this.status.recentLogs] };
  }

  /**
   * Start a Cloudflare Quick Tunnel — single command, prints a
   * `*.trycloudflare.com` URL when ready.
   */
  async startQuick(localPort: number): Promise<TunnelStatus> {
    if (this.child) return this.getStatus();
    let binary: string;
    try { binary = this.getBinary(); } catch (error) {
      this.status = { ...this.status, state: "error", error: errorMessage(error), mode: "quick" };
      this.emit("status", this.getStatus());
      return this.getStatus();
    }
    return this.spawnTunnel(binary, "quick", ["tunnel", "--url", `http://localhost:${localPort}`], URL_PATTERN);
  }

  async startNamed(localPort: number, tunnelName: string, subdomain: string, domain: string): Promise<TunnelStatus> {
    if (this.child) return this.getStatus();
    if (!tunnelName.trim() || !subdomain.trim() || !domain.trim()) {
      this.status = { ...this.status, state: "error", error: "Tunnel name, subdomain và domain bắt buộc.", mode: "named" };
      this.emit("status", this.getStatus());
      return this.getStatus();
    }
    let binary: string;
    try { binary = this.getBinary(); } catch (error) {
      this.status = { ...this.status, state: "error", error: errorMessage(error), mode: "named" };
      this.emit("status", this.getStatus());
      return this.getStatus();
    }
    const fqdn = `${subdomain}.${domain}`;

    // Step 1: create if missing.
    try {
      const create = await runOnce(binary, ["tunnel", "create", tunnelName]);
      this.recordLog(`[create] ${(create.stdout || create.stderr).trim()}`);
    } catch (error) {
      const msg = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "cloudflared chưa cài đúng. Bấm 'Tải cloudflared' để tải lại."
        : errorMessage(error);
      this.status = { ...this.status, state: "error", error: msg, mode: "named" };
      this.emit("status", this.getStatus());
      return this.getStatus();
    }

    // Step 2: route DNS.
    try {
      const route = await runOnce(binary, ["tunnel", "route", "dns", tunnelName, fqdn]);
      this.recordLog(`[route] ${(route.stdout || route.stderr).trim()}`);
    } catch (error) {
      this.recordLog(`[route] error: ${errorMessage(error)}`);
    }

    return this.spawnTunnel(binary, "named", ["tunnel", "run", "--url", `http://localhost:${localPort}`, tunnelName], null, fqdn);
  }

  async authorize(): Promise<{ ok: boolean; url?: string; output: string; error?: string }> {
    let binary: string;
    try { binary = this.getBinary(); } catch (error) { return { ok: false, output: "", error: errorMessage(error) }; }

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, ["tunnel", "login"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        resolve({ ok: false, output: "", error: errorMessage(error) });
        return;
      }
      let combined = "";
      let foundUrl: string | undefined;
      let settled = false;
      const finish = (result: { ok: boolean; url?: string; output: string; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const consume = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        combined += text;
        this.recordLog(`[login] ${text.trim()}`);
        if (!foundUrl) {
          const match = text.match(/https:\/\/dash\.cloudflare\.com\/[^\s]+/);
          if (match) {
            foundUrl = match[0];
            this.emit("authorize_url", foundUrl);
          }
        }
      };
      (child.stdout as Readable | null)?.on("data", consume);
      (child.stderr as Readable | null)?.on("data", consume);
      child.on("error", (error: NodeJS.ErrnoException) => {
        const msg = error.code === "ENOENT"
          ? "cloudflared không chạy được. Bấm 'Tải cloudflared' để tải lại."
          : errorMessage(error);
        finish({ ok: false, output: combined, error: msg });
      });
      child.on("exit", (code) => {
        finish({ ok: code === 0, url: foundUrl, output: combined, error: code === 0 ? undefined : `exit ${code}` });
      });
    });
  }

  async listAuthorizedDomains(): Promise<string[]> {
    return [];
  }

  async stop(): Promise<TunnelStatus> {
    if (!this.child) return this.getStatus();
    const child = this.child;
    return new Promise((resolve) => {
      const finalize = () => {
        this.child = null;
        this.status.state = "stopped";
        this.status.publicUrl = "";
        this.status.mode = null;
        this.emit("status", this.getStatus());
        resolve(this.getStatus());
      };
      child.once("exit", finalize);
      try { child.kill(); } catch { finalize(); }
      setTimeout(() => {
        if (this.child === child) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          finalize();
        }
      }, 5000);
    });
  }

  // ===== internal =====

  private spawnTunnel(binary: string, mode: TunnelMode, args: string[], urlPattern: RegExp | null, knownPublicUrl?: string): TunnelStatus {
    this.status = {
      state: "starting",
      mode,
      publicUrl: knownPublicUrl ? `https://${knownPublicUrl}` : "",
      error: "",
      startedAt: Date.now(),
      recentLogs: [...this.status.recentLogs.slice(-20)],
    };
    this.emit("status", this.getStatus());

    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      this.status.state = "error";
      this.status.error = errorMessage(error);
      this.emit("status", this.getStatus());
      return this.getStatus();
    }
    this.child = child;

    child.on("error", (error: NodeJS.ErrnoException) => {
      this.status.state = "error";
      this.status.error = error.code === "ENOENT"
        ? "cloudflared chưa được cài. Vào tab Cloudflare Tunnel để tải tự động."
        : errorMessage(error);
      this.recordLog(`[error] ${this.status.error}`);
      this.emit("status", this.getStatus());
    });

    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.recordLog(line);
        if (urlPattern && !this.status.publicUrl) {
          const match = line.match(urlPattern);
          if (match) {
            this.status.publicUrl = match[0];
            this.status.state = "running";
            this.status.error = "";
            this.emit("status", this.getStatus());
          }
        }
        if (mode === "named" && /Registered tunnel connection/i.test(line)) {
          if (this.status.state !== "running") {
            this.status.state = "running";
            this.status.error = "";
            this.emit("status", this.getStatus());
          }
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
      this.status.mode = null;
      this.emit("status", this.getStatus());
    });

    return this.getStatus();
  }

  private recordLog(line: string) {
    this.status.recentLogs.push(`${new Date().toISOString()} ${line}`);
    if (this.status.recentLogs.length > MAX_LOGS) {
      this.status.recentLogs.splice(0, this.status.recentLogs.length - MAX_LOGS);
    }
    this.emit("status", this.getStatus());
  }
}

