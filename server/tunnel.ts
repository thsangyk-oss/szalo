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
import { spawn, spawnSync, execSync, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";

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
const STARTUP_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 60_000;

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const TUNNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function validateNamedTunnelInput(input: { tunnelName: string; subdomain: string; domain: string }): { ok: true; value: { tunnelName: string; subdomain: string; domain: string; fqdn: string } } | { ok: false; error: string } {
  const tunnelName = input.tunnelName.trim();
  const subdomain = input.subdomain.trim().toLowerCase();
  const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!tunnelName || !subdomain || !domain) return { ok: false, error: "Cần đủ tunnel name, domain và subdomain." };
  if (!TUNNEL_NAME_PATTERN.test(tunnelName)) return { ok: false, error: "Tunnel name chỉ nên dùng chữ, số, dấu gạch ngang, gạch dưới hoặc dấu chấm." };
  if (!DNS_LABEL_PATTERN.test(subdomain)) return { ok: false, error: "Subdomain không hợp lệ. Dùng một nhãn DNS như 'zalo' hoặc 'demo-zalo'." };
  if (!DOMAIN_PATTERN.test(domain)) return { ok: false, error: "Domain không hợp lệ. Ví dụ đúng: example.com." };
  return { ok: true, value: { tunnelName, subdomain, domain, fqdn: `${subdomain}.${domain}` } };
}

async function runOnce(binary: string, args: string[], options: SpawnOptionsWithoutStdio = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stderr += `\nCommand timed out after ${Math.round(timeoutMs / 1000)}s`;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    (child.stdout as Readable | null)?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    (child.stderr as Readable | null)?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

export class TunnelManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private stopping = false;
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
    if (this.child) return this.busyStatus("quick");
    let binary: string;
    try { binary = this.getBinary(); } catch (error) {
      this.setError("quick", errorMessage(error));
      return this.getStatus();
    }
    return this.spawnTunnel(binary, "quick", ["tunnel", "--url", `http://localhost:${localPort}`], URL_PATTERN);
  }

  async startNamed(localPort: number, tunnelName: string, subdomain: string, domain: string): Promise<TunnelStatus> {
    if (this.child) return this.busyStatus("named");
    const validated = validateNamedTunnelInput({ tunnelName, subdomain, domain });
    if (!validated.ok) {
      this.setError("named", validated.error);
      return this.getStatus();
    }
    let binary: string;
    try { binary = this.getBinary(); } catch (error) {
      this.setError("named", errorMessage(error));
      return this.getStatus();
    }
    const { value } = validated;
    const { fqdn } = value;

    if (!this.getAuthStatus().authorized) {
      this.setError("named", "Chưa authorize Cloudflare. Bấm Authorize cloudflared trước khi chạy Named Tunnel.");
      return this.getStatus();
    }

    this.status = {
      state: "starting",
      mode: "named",
      publicUrl: `https://${fqdn}`,
      error: "",
      startedAt: Date.now(),
      recentLogs: [...this.status.recentLogs.slice(-20)],
    };
    this.emit("status", this.getStatus());

    // Step 1: only create the tunnel if it doesn't already exist. cloudflared
    // happily creates a new tunnel with a fresh UUID every time you call
    // `tunnel create <name>`, so we have to gate it on a tunnel-list lookup
    // first; otherwise route-dns fails with a "record already exists" because
    // the previous run's record still points at the old UUID.
    const existing = this.listTunnels().find((t) => t.name === value.tunnelName);
    if (!existing) {
      try {
        const create = await runOnce(binary, ["tunnel", "create", value.tunnelName]);
        this.recordLog(`[create] ${(create.stdout || create.stderr).trim()}`);
        if (create.code !== 0 && !/already exists/i.test(create.stderr + create.stdout)) {
          this.setError("named", `Tạo tunnel thất bại: ${(create.stderr || create.stdout || `exit ${create.code}`).trim()}`);
          return this.getStatus();
        }
      } catch (error) {
        const msg = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "cloudflared chưa cài đúng. Bấm 'Tải cloudflared' để tải lại."
          : errorMessage(error);
        this.setError("named", msg);
        return this.getStatus();
      }
    } else {
      this.recordLog(`[create] tunnel '${value.tunnelName}' already exists (id=${existing.id.slice(0, 8)}…), skipping create`);
    }

    // Step 2: route DNS. Use --overwrite-dns so a stale CNAME from a previous
    // tunnel UUID gets replaced rather than triggering "record already exists".
    try {
      const route = await runOnce(binary, ["tunnel", "route", "dns", "--overwrite-dns", value.tunnelName, fqdn]);
      const combined = (route.stdout + route.stderr).trim();
      this.recordLog(`[route] ${combined}`);
      if (route.code !== 0) {
        this.setError("named", `Gắn DNS thất bại cho ${fqdn}: ${combined || `exit ${route.code}`}`);
        return this.getStatus();
      }
    } catch (error) {
      this.setError("named", `Gắn DNS thất bại cho ${fqdn}: ${errorMessage(error)}`);
      return this.getStatus();
    }

    return this.spawnTunnel(binary, "named", ["tunnel", "run", "--url", `http://localhost:${localPort}`, value.tunnelName], null, fqdn);
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

  /**
   * Check authorization status: does cert.pem exist? What domain is it for?
   * Also list existing named tunnels if authorized.
   */
  getAuthStatus(): {
    authorized: boolean;
    certPath: string;
    domain?: string;
    zoneId?: string;
    accountId?: string;
    tunnels: Array<{ id: string; name: string; connections: string }>;
  } {
    const certPath = this.findCertPem();
    if (!certPath || !existsSync(certPath)) {
      return { authorized: false, certPath: "", tunnels: [] };
    }

    let domain: string | undefined;
    let zoneId: string | undefined;
    let accountId: string | undefined;

    try {
      const content = readFileSync(certPath, "utf8");
      const tokenMatch = content.match(/-----BEGIN ARGO TUNNEL TOKEN-----\s*([\s\S]*?)\s*-----END ARGO TUNNEL TOKEN-----/);
      if (tokenMatch) {
        try {
          const decoded = Buffer.from(tokenMatch[1].replace(/\s/g, ""), "base64").toString("utf8");
          const parsed = JSON.parse(decoded) as { zoneID?: string; accountID?: string; apiToken?: string };
          zoneId = parsed.zoneID;
          accountId = parsed.accountID;
          // Try to resolve zone name via Cloudflare API
          if (parsed.apiToken && parsed.zoneID) {
            domain = this.resolveZoneName(parsed.apiToken, parsed.zoneID);
          }
        } catch { /* ignore parse errors */ }
      }
    } catch { /* can't read cert */ }

    const tunnels = this.listTunnels();

    return { authorized: true, certPath, domain, zoneId, accountId, tunnels };
  }

  private resolveZoneName(apiToken: string, zoneId: string): string | undefined {
    // Synchronous curl call; called rarely on admin refresh and avoids storing
    // the Cloudflare token anywhere outside cloudflared's cert.
    try {
      const result = spawnSync("curl", [
        "-s",
        "-H",
        `Authorization: Bearer ${apiToken}`,
        `https://api.cloudflare.com/client/v4/zones/${zoneId}`,
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 8000 });
      if (result.status !== 0) return undefined;
      const output = result.stdout.toString("utf8");
      const parsed = JSON.parse(output) as { result?: { name?: string } };
      return parsed.result?.name;
    } catch {
      return undefined;
    }
  }

  private findCertPem(): string {
    // cloudflared stores cert.pem in ~/.cloudflared/ by default
    const candidates = [
      path.join(os.homedir(), ".cloudflared", "cert.pem"),
      path.join(process.env.USERPROFILE || os.homedir(), ".cloudflared", "cert.pem"),
    ];
    return candidates.find((p) => existsSync(p)) || "";
  }

  private listTunnels(): Array<{ id: string; name: string; connections: string }> {
    let binary: string;
    try { binary = this.resolveBinary(); } catch { return []; }
    if (!binary) return [];
    try {
      const output = execSync(`"${binary}" tunnel list --output json`, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10000,
      }).toString("utf8");
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((t: { id?: string; name?: string; connections?: unknown[] }) => ({
        id: String(t.id || ""),
        name: String(t.name || ""),
        connections: Array.isArray(t.connections) ? `${t.connections.length} conn` : "0 conn",
      })).slice(0, 50);
    } catch {
      // Fallback: parse text output
      try {
        const output = execSync(`"${binary}" tunnel list`, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 10000,
        }).toString("utf8");
        const lines = output.split(/\r?\n/).filter((l) => /^[0-9a-f-]{36}\s/.test(l.trim()));
        return lines.map((line) => {
          const parts = line.trim().split(/\s{2,}/);
          return { id: parts[0] || "", name: parts[1] || "", connections: parts[3] || "" };
        }).slice(0, 50);
      } catch { return []; }
    }
  }

  async stop(): Promise<TunnelStatus> {
    if (!this.child) {
      this.clearStartupTimer();
      this.stopping = false;
      this.status = { ...this.status, state: "stopped", mode: null, publicUrl: "", error: "" };
      this.emit("status", this.getStatus());
      return this.getStatus();
    }
    const child = this.child;
    this.stopping = true;
    return new Promise((resolve) => {
      let finished = false;
      const finalize = () => {
        if (finished) return;
        finished = true;
        this.clearStartupTimer();
        this.child = null;
        this.stopping = false;
        this.status.state = "stopped";
        this.status.publicUrl = "";
        this.status.mode = null;
        this.status.error = "";
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

  private busyStatus(requested: TunnelMode): TunnelStatus {
    const running = this.getStatus();
    if (running.mode !== requested) {
      this.recordLog(`[busy] ${running.mode ?? "another"} tunnel is already ${running.state}; stop it before starting ${requested}`);
    }
    return running;
  }

  private setError(mode: TunnelMode, error: string) {
    this.clearStartupTimer();
    this.status = {
      ...this.status,
      state: "error",
      mode,
      publicUrl: "",
      error,
      startedAt: this.status.startedAt || Date.now(),
    };
    this.recordLog(`[error] ${error}`);
    this.emit("status", this.getStatus());
  }

  private clearStartupTimer() {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private spawnTunnel(binary: string, mode: TunnelMode, args: string[], urlPattern: RegExp | null, knownPublicUrl?: string): TunnelStatus {
    this.clearStartupTimer();
    this.stopping = false;
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
    this.startupTimer = setTimeout(() => {
      if (!this.child || this.status.state !== "starting") return;
      const msg = mode === "quick"
        ? "Không nhận được URL Quick Tunnel sau 45 giây. Kiểm tra mạng, DNS hoặc thử tải lại cloudflared."
        : "Named Tunnel chưa kết nối Cloudflare sau 45 giây. Kiểm tra authorize, domain và kết nối mạng.";
      this.setError(mode, msg);
      try { child.kill(); } catch { /* ignore */ }
    }, STARTUP_TIMEOUT_MS);

    child.on("error", (error: NodeJS.ErrnoException) => {
      this.setError(mode, error.code === "ENOENT"
        ? "cloudflared chưa được cài. Vào tab Cloudflare Tunnel để tải tự động."
        : errorMessage(error));
    });

    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.recordLog(line);
        if (urlPattern && !this.status.publicUrl) {
          const match = line.match(urlPattern);
          if (match) {
            this.clearStartupTimer();
            this.status.publicUrl = match[0];
            this.status.state = "running";
            this.status.error = "";
            this.emit("status", this.getStatus());
          }
        }
        if (mode === "named" && /Registered tunnel connection/i.test(line)) {
          if (this.status.state !== "running") {
            this.clearStartupTimer();
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
      const wasStopping = this.stopping;
      this.clearStartupTimer();
      this.child = null;
      this.stopping = false;
      if (wasStopping) {
        this.status.state = "stopped";
        this.status.error = "";
        this.status.publicUrl = "";
        this.status.mode = null;
      } else if (this.status.state !== "error") {
        this.status.state = "error";
        this.status.error = wasRunning
          ? `Tunnel bị ngắt ngoài ý muốn (code ${code ?? "n/a"}, signal ${signal ?? "n/a"}).`
          : `cloudflared dừng trước khi sẵn sàng (code ${code ?? "n/a"}, signal ${signal ?? "n/a"}).`;
        this.status.publicUrl = "";
      }
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
