import { describe, it, expect, vi } from "vitest";
import { withSessionRefresh, type PurchaseDeps } from "./purchase.js";

/**
 * The 401 hook (S23): one refresh, one retry, and the original answer when
 * the refresh cannot help. Everything else in PurchaseDeps is irrelevant to
 * it, so the deps here are the three fields it reads.
 */
function deps(over: Partial<PurchaseDeps> = {}): PurchaseDeps {
  const log = vi.fn();
  return {
    ctx: { http: fetch, log, snapshots: true },
    registry: { setStatus: vi.fn() } as never,
    vault: { get: () => ({ storeId: "tsc:tesco" }) } as never,
    sessions: { refresh: vi.fn(async () => ({ ok: true, state: "live" as const })) },
    ...over,
  } as PurchaseDeps;
}

const responder = (...statuses: number[]) => {
  const calls: RequestInit[] = [];
  const http = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response("body", { status: statuses.shift() ?? 200 });
  });
  return { http: http as unknown as typeof fetch, calls };
};

describe("withSessionRefresh", () => {
  it("passes a good answer straight through", async () => {
    const { http } = responder(200);
    const d = deps();
    const res = await withSessionRefresh(http, "tsc:tesco", d)("https://x/", {});
    expect(res.status).toBe(200);
    expect(d.sessions!.refresh).not.toHaveBeenCalled();
  });

  it("refreshes once on 401 and retries with the same request", async () => {
    const { http, calls } = responder(401, 200);
    const d = deps();
    const res = await withSessionRefresh(http, "tsc:tesco", d)("https://x/", { method: "POST", body: "q" });
    expect(res.status).toBe(200);
    expect(d.sessions!.refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: "POST", body: "q" });
  });

  it("returns the original 401 and flips the registry when the refresh cannot help", async () => {
    const { http, calls } = responder(401, 200);
    const d = deps({ sessions: { refresh: vi.fn(async () => ({ ok: false, state: "needs_human" as const, reason: "otp" })) } });
    const res = await withSessionRefresh(http, "tsc:tesco", d)("https://x/");
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(d.registry.setStatus).toHaveBeenCalledWith("tsc:tesco", "needs_auth");
  });

  it("marks expired when the refresh found the session dead", async () => {
    const { http } = responder(403);
    const d = deps({ sessions: { refresh: vi.fn(async () => ({ ok: false, state: "expired" as const })) } });
    await withSessionRefresh(http, "tsc:tesco", d)("https://x/");
    expect(d.registry.setStatus).toHaveBeenCalledWith("tsc:tesco", "expired");
  });

  it("never retries a body that cannot be sent twice", async () => {
    const { http, calls } = responder(401, 200);
    const d = deps();
    const stream = new ReadableStream();
    const res = await withSessionRefresh(http, "tsc:tesco", d)("https://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(d.sessions!.refresh).not.toHaveBeenCalled();
  });

  it("does nothing for a store with no credential, or with no session engine", async () => {
    const { http, calls } = responder(401, 401);
    const noCred = deps({ vault: { get: () => null } as never });
    expect((await withSessionRefresh(http, "tsc:tesco", noCred)("https://x/")).status).toBe(401);
    expect(noCred.sessions!.refresh).not.toHaveBeenCalled();
    const plain = deps();
    delete plain.sessions;
    expect(withSessionRefresh(http, "tsc:tesco", plain)).toBe(http);
    expect(calls).toHaveLength(1);
  });

  it("a refresh that throws is logged and the original answer returned", async () => {
    const { http } = responder(401);
    const d = deps({ sessions: { refresh: vi.fn(async () => { throw new Error("boom"); }) } });
    expect((await withSessionRefresh(http, "tsc:tesco", d)("https://x/")).status).toBe(401);
    expect(d.ctx.log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
