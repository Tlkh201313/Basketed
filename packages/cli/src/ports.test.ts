import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  listenSomewhere,
  describePort,
  busyPortMessage,
  describeOwnerLine,
  DEFAULT_HTTP_PORT,
  DEFAULT_PANEL_PORT,
} from "./ports.js";

describe("the two default ports", () => {
  // The bug this separation fixes: a stdio panel squatting on the port a
  // client had been told to POST /mcp to, answering 404 forever.
  it("are not the same number", () => {
    expect(DEFAULT_PANEL_PORT).not.toBe(DEFAULT_HTTP_PORT);
  });
});

describe("listenSomewhere", () => {
  it("takes the port it asked for when it is free", async () => {
    const server = createServer();
    try {
      const port = await listenSomewhere(server, 0);
      expect(port).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("moves to any free port rather than failing", async () => {
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const taken = (squatter.address() as AddressInfo).port;
    const server = createServer();
    try {
      const port = await listenSomewhere(server, taken);
      expect(port).not.toBeNull();
      expect(port).not.toBe(taken);
    } finally {
      server.close();
      squatter.close();
    }
  });
});

describe("describePort", () => {
  it("names a Basketed server that identifies itself", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "basketed", pid: 4242, mode: "stdio-panel" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const owner = await describePort(port);
      expect(owner).toEqual({ name: "basketed", pid: 4242, mode: "stdio-panel" });
    } finally {
      server.close();
    }
  });

  it("returns null for a process that is not ours", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "something-else" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await describePort(port)).toBeNull();
    } finally {
      server.close();
    }
  });

  it("returns null instead of throwing when nothing answers", async () => {
    // Never throws: this only ever makes an error message better, so failing
    // to find out must mean saying less, not raising a second error.
    await expect(describePort(9, { timeoutMs: 200 })).resolves.toBeNull();
  });
});

describe("busyPortMessage", () => {
  it("tells a person to move the PANEL, not the endpoint, when a stdio panel squats", () => {
    const msg = busyPortMessage(8787, { name: "basketed", pid: 77, mode: "stdio-panel" });
    expect(msg).toContain("stdio panel");
    expect(msg).toContain("pid 77");
    expect(msg).toContain("BASKETED_PANEL_PORT");
    expect(msg).toContain("no /mcp on it");
  });

  it("points at the server that is already serving when it is another HTTP one", () => {
    const msg = busyPortMessage(8787, { name: "basketed", pid: 88, mode: "http" });
    expect(msg).toContain("http://127.0.0.1:8787/mcp");
    expect(msg).toContain("pid 88");
  });

  it("falls back to 'pick another port' for a stranger", () => {
    const msg = busyPortMessage(8787, null);
    expect(msg).toContain("another process");
    expect(msg).toContain("--port 8790");
  });
});

describe("describeOwnerLine", () => {
  it("says free, and what the port is for", () => {
    expect(describeOwnerLine(8788, null, "the panel")).toContain("free — the panel");
  });

  it("omits a pid it does not know", () => {
    expect(describeOwnerLine(8787, { name: "basketed", pid: 0, mode: "http" }, "MCP")).not.toContain("pid");
  });
});
