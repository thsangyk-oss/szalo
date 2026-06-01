const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:4010";

async function expectOk(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response;
}

async function expectJson<T>(path: string) {
  const response = await expectOk(path);
  return await response.json() as T;
}

async function expectOneOfStatuses(path: string, statuses: number[]) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!statuses.includes(response.status)) {
    throw new Error(`${path} returned HTTP ${response.status}, expected one of ${statuses.join(", ")}`);
  }
}

type HealthResponse = {
  ok: boolean;
  state: string;
  error?: string;
  serverStartedAt?: string;
  counts: {
    total: number;
    users: number;
    groups: number;
  };
  cache: {
    conversations: number;
    messageThreads: number;
  };
  messageStats: {
    total: number;
    self: number;
    received: number;
    lastSelfTimestamp?: number;
  };
  recentSends: unknown[];
  recentClientEvents: unknown[];
  recentListenerEvents: unknown[];
};

async function main() {
  await expectOk("/");
  await expectOk("/chat/smoke");
  await expectOneOfStatuses("/api/attachments/proxy?url=https%3A%2F%2Fexample.com%2Ffile.txt", [400, 401]);

  const health = await expectJson<HealthResponse>("/api/health");
  if (!health.ok) throw new Error("/api/health did not report ok=true");
  if (health.counts.total !== health.cache.conversations) {
    throw new Error(`health count mismatch: total=${health.counts.total}, cache=${health.cache.conversations}`);
  }
  if (!health.serverStartedAt) throw new Error("/api/health is missing serverStartedAt");
  if (!health.messageStats || health.messageStats.total < health.messageStats.self) {
    throw new Error("/api/health returned invalid messageStats");
  }
  if (!Array.isArray(health.recentSends)) throw new Error("/api/health recentSends is not an array");
  if (!Array.isArray(health.recentClientEvents)) throw new Error("/api/health recentClientEvents is not an array");
  if (!Array.isArray(health.recentListenerEvents)) throw new Error("/api/health recentListenerEvents is not an array");

  const conversations = await expectJson<unknown[]>("/api/conversations");
  if (conversations.length !== health.counts.total) {
    throw new Error(`conversation count mismatch: health=${health.counts.total}, api=${conversations.length}`);
  }

  const firstConversation = conversations[0] as { id?: string; type?: string } | undefined;
  if (health.state === "online" && firstConversation?.id && (firstConversation.type === "user" || firstConversation.type === "group")) {
    const seenResponse = await fetch(`${baseUrl}/api/events/seen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: firstConversation.id, type: firstConversation.type }),
    });
    if (!seenResponse.ok) {
      throw new Error(`/api/events/seen returned HTTP ${seenResponse.status}`);
    }
  }

  const firstGroup = conversations.find((item): item is { id: string; type: "group" } => {
    const conversation = item as { id?: unknown; type?: unknown };
    return typeof conversation.id === "string" && conversation.type === "group";
  });
  if (health.state === "online" && firstGroup) {
    const detail = await expectJson<{ id: string; members: unknown[]; totalMember: number }>(`/api/groups/${firstGroup.id}`);
    if (detail.id !== firstGroup.id) throw new Error(`/api/groups/${firstGroup.id} returned mismatched id`);
    if (!Array.isArray(detail.members)) throw new Error(`/api/groups/${firstGroup.id} members is not an array`);
  }

  const firstUser = conversations.find((item): item is { id: string; type: "user" } => {
    const conversation = item as { id?: unknown; type?: unknown };
    return typeof conversation.id === "string" && conversation.type === "user";
  });
  if (health.state === "online" && firstUser) {
    const detail = await expectJson<{ id: string; displayName: string }>(`/api/users/${firstUser.id}`);
    if (detail.id !== firstUser.id) throw new Error(`/api/users/${firstUser.id} returned mismatched id`);
    if (!detail.displayName) throw new Error(`/api/users/${firstUser.id} missing displayName`);
    const badAction = await fetch(`${baseUrl}/api/conversations/user/${firstUser.id}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bad_action" }),
    });
    if (badAction.status !== 400) throw new Error(`/api/conversations action validation returned HTTP ${badAction.status}`);
  }

  const authNote = health.state === "online" ? "" : `, auth=${health.error || "offline"}`;
  console.log(`Smoke OK: ${health.state}${authNote}, ${health.counts.total} conversations, ${health.cache.messageThreads} message threads`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
