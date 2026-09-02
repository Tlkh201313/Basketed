import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import {
  MCP_BODY_LIMIT,
  PANEL_BODY_LIMIT,
  readBody,
  readJsonBody,
  MCP_TIMEOUTS,
  PANEL_TIMEOUTS,
} from "./body.js";

/**
 * The bounded read. Driven over a real socket rather than a fake stream,
 * because the two things worth proving -- that an oversized body is refused
 * before it is buffered, and that refusing it does not hang the client -- are
 * both about the socket.
 */

type Reply = { status: number; text: string };

/** Serves one request through `handle`, POSTs `body` to it, returns the reply. */
async function roundTrip(
  handle: (req: IncomingMessage) => Promise<{ status: number; text: string }>,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const server: Server = createServer((req, res) => {
    void handle(req).then(({ status, text }) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body, headers });
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}

const asBody = (limit: number) => async (req: IncomingMessage) => {
  const out = await readBody(req, limit);
  return out.ok ? { status: 200, text: `${out.body.length}` } : { status: out.status, text: out.error };
};

const asJson = (limit: number) => async (req: IncomingMessage) => {
  const out = await readJsonBody(req, limit);
  return out.ok ? { status: 200, text: JSON.stringify(out.value) } : { status: out.status, text: out.error };
};

describe("readBody", () => {
  it("reads a body inside the limit", async () => {
    expect(await roundTrip(asBody(1000), "x".repeat(500))).toEqual({ status: 200, text: "500" });
  });

  it("takes a body exactly at the limit", async () => {
    expect(await roundTrip(asBody(500), "x".repeat(500))).toMatchObject({ status: 200 });
  });

  it("refuses one byte over, and says how big it may be", async () => {
    const reply = await roundTrip(asBody(500), "x".repeat(501));
    expect(reply.status).toBe(413);
    expect(reply.text).toMatch(/larger than/i);
  });

  it("refuses on the declared length without reading a single byte", async () => {
    // Content-Length is checked first so a large upload never reaches memory.
    // A liar still gets caught by the running count -- that is the next test.
    // Driven off a stub rather than a socket because the point is precisely
    // that the stream is never consumed, and fetch will not send a length it
    // did not compute.
    let consumed = false;
    const stream = Readable.from(
      (async function* () {
        consumed = true;
        yield Buffer.from("x");
      })(),
    ) as unknown as IncomingMessage;
    stream.headers = { "content-length": "999999" };

    const out = await readBody(stream, 100);
    expect(out).toMatchObject({ ok: false, status: 413 });
    expect(consumed).toBe(false);
  });

  it("catches a body that is bigger than it claimed to be", async () => {
    // Chunked encoding declares no length at all, so the running count is the
    // only real bound. This is the case the old unbounded loop could not see.
    const big = "x".repeat(300_000);
    const reply = await roundTrip(asBody(1000), Buffer.from(big));
    expect(reply.status).toBe(413);
  });

  it("an empty body is a body of length zero, not an error", async () => {
    expect(await roundTrip(asBody(1000), "")).toEqual({ status: 200, text: "0" });
  });
});

describe("readJsonBody", () => {
  it("parses an object", async () => {
    expect(await roundTrip(asJson(1000), '{"a":1}')).toEqual({ status: 200, text: '{"a":1}' });
  });

  it("treats an empty body as no fields", async () => {
    // Several panel routes are legitimately parameterless POSTs.
    expect(await roundTrip(asJson(1000), "")).toEqual({ status: 200, text: "{}" });
  });

  it("400s on JSON that will not parse, instead of pretending no fields were sent", async () => {
    // The old code returned {}, so a typo in a request arrived at the handler
    // as "you sent nothing" -- which reads as a bug in the route.
    const reply = await roundTrip(asJson(1000), "{not json");
    expect(reply.status).toBe(400);
    expect(reply.text).toMatch(/not valid JSON/i);
  });

  it("400s on valid JSON that is not an object", async () => {
    for (const body of ["[1,2]", '"a string"', "42", "null"]) {
      expect((await roundTrip(asJson(1000), body)).status).toBe(400);
    }
  });

  it("413s before it ever tries to parse", async () => {
    expect((await roundTrip(asJson(100), JSON.stringify({ a: "x".repeat(500) }))).status).toBe(413);
  });
});

describe("the limits themselves", () => {
  it("gives MCP room for a real tool argument and the panel none", () => {
    // A tool call may carry a long argument. A panel form field may not.
    expect(MCP_BODY_LIMIT).toBe(1024 * 1024);
    expect(PANEL_BODY_LIMIT).toBe(64 * 1024);
    expect(PANEL_BODY_LIMIT).toBeLessThan(MCP_BODY_LIMIT);
  });

  it("lets a request run longer than it may take to send its headers", () => {
    // A tool call is legitimately slow because a retailer is slow. A client
    // that has not finished its header block is not slow, it is stuck.
    for (const t of [MCP_TIMEOUTS, PANEL_TIMEOUTS]) {
      expect(t.headersTimeout).toBeGreaterThan(0);
      expect(t.requestTimeout).toBeGreaterThan(t.headersTimeout);
    }
    expect(PANEL_TIMEOUTS.requestTimeout).toBeLessThan(MCP_TIMEOUTS.requestTimeout);
  });
});
