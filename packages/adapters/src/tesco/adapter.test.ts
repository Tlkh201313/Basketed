import { describe, expect, it, vi } from "vitest";
import { TescoAdapter } from "./adapter.js";
import type { AdapterCtx } from "../types.js";

/**
 * Mocked at the HTTP boundary, not against the real network -- this suite
 * (like every other adapter's) runs under the offline drill's network-cut
 * guard, so it cannot make a real call to Tesco even if it wanted to. Live
 * verification of the real endpoints happened by hand against production
 * Tesco before this adapter was written; what belongs in the unit suite is
 * this file's OWN request/response handling, which is where the actual S16
 * bug lived (see the regression test below).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A tiny fake Tesco: search returns TPNBs, GraphQL hydrates by TPNB into a
 * product whose OWN `id` field is a different number entirely -- exactly the
 * real shape (Tesco's product `id` and its TPNB are unrelated numbers). A
 * mock where they happened to match would not have caught the bug.
 */
function fakeTescoHttp(opts: { basketAuthed?: boolean; staleUntilReauth?: { renewed: boolean; refusals: number } } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;

    if (url.includes("search.api.tesco.com")) {
      return jsonResponse({
        uk: { ghs: { products: { results: [{ tpnb: 50580405 }, { tpnb: 51517728 }], totals: { all: 2 } } } },
      });
    }

    if (url.includes("xapi.tesco.com")) {
      const ops = Array.isArray(body) ? body : [body];
      const first = ops[0] as { operationName: string; variables?: Record<string, unknown> };

      if (first.operationName === "GetProductByTpnb") {
        return jsonResponse(
          (ops as Array<{ variables: { tpnb: string } }>).map((op) => {
            // Product ids are deliberately NOT equal to the TPNB.
            const byTpnb: Record<string, { id: string; title: string; price: number }> = {
              "50580405": { id: "900000001", title: "Yorkshire 80 Teabags 250G", price: 3.75 },
              "51517728": { id: "900000002", title: "Tesco Gold Instant Coffee 200G", price: 2.65 },
            };
            const p = byTpnb[op.variables.tpnb];
            if (!p) return { data: { product: null }, status: 404 };
            return {
              data: {
                product: {
                  id: p.id,
                  title: p.title,
                  defaultImageUrl: "https://example.com/x.jpg",
                  price: { actual: p.price, unitPrice: p.price, unitOfMeasure: "kg" },
                  details: { packSize: [{ value: "200", units: "G" }] },
                },
              },
              status: 200,
            };
          }),
        );
      }

      if (first.operationName === "GetBasket") {
        if (opts.basketAuthed === false) return jsonResponse({}, 401);
        if (opts.staleUntilReauth && !opts.staleUntilReauth.renewed) {
          opts.staleUntilReauth.refusals++;
          return jsonResponse([{ errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }], status: 200 }]);
        }
        return jsonResponse([{ data: { basket: { id: "order_abc123", items: [] } }, status: 200 }]);
      }

      if (first.operationName === "UpdateBasket") {
        return jsonResponse([
          {
            data: {
              basket: {
                id: "order_abc123",
                items: [{ id: "li1", quantity: 2, cost: 5.3, product: { id: "900000002" } }],
                updates: { items: [{ id: "900000002", successful: true }] },
              },
            },
            status: 200,
          },
        ]);
      }
    }

    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

function ctxWith(http: typeof fetch): AdapterCtx {
  return { http, log: () => {}, snapshots: false };
}

describe("real Tesco adapter (S16)", () => {
  it("is mode native with only the tiers it actually implements", () => {
    const adapter = new TescoAdapter();
    expect(adapter.manifest.mode).toBe("native");
    expect(adapter.manifest.capabilities).toEqual(["discovery", "detail", "cart"]);
  });

  it("search returns real-shaped products, correctly priced", async () => {
    const adapter = new TescoAdapter();
    const products = await adapter.search({ query: "coffee" }, ctxWith(fakeTescoHttp()));
    expect(products).toHaveLength(2);
    const coffee = products.find((p) => p.name.includes("Coffee"))!;
    expect(coffee.price).toEqual({ value: 2.65, currency: "GBP" });
    expect(coffee.mode).toBe("native");
    expect(coffee.source).toBe("tesco.com");
  });

  /**
   * The actual S16 bug: detail() re-hydrated using Tesco's internal product
   * `id` as if it were the TPNB, because the cache stored `node.id` under the
   * `tpnb` key. Every detail lookup 404'd. This is the regression test.
   */
  it("detail() re-hydrates by the product's real TPNB, not its internal id", async () => {
    const adapter = new TescoAdapter();
    const http = fakeTescoHttp();
    const [product] = await adapter.search({ query: "coffee" }, ctxWith(http));
    const detail = await adapter.detail(product!.id, ["stock"], ctxWith(http));
    expect(detail.name).toBe(product!.name);
    expect(detail.stock).toBe("in_stock");
  });

  it("buildCart adds the resolved Tesco product id, not the search TPNB, and totals real costs", async () => {
    const adapter = new TescoAdapter();
    const http = fakeTescoHttp();
    const products = await adapter.search({ query: "coffee" }, ctxWith(http));
    const coffee = products.find((p) => p.name.includes("Coffee"))!;

    const cart = await adapter.buildCart([{ id: coffee.id, quantity: 2 }], ctxWith(http));
    expect(cart.cartId).toBe("order_abc123");
    expect(cart.total.value).toBeCloseTo(5.3, 2);
    expect(cart.handoffUrl).toBe("https://www.tesco.com/groceries/en-GB/trolley");
  });

  it("a missing or expired basket token fails with Tesco's own status, not a fabricated cart", async () => {
    const adapter = new TescoAdapter();
    const http = fakeTescoHttp({ basketAuthed: false });
    const [product] = await adapter.search({ query: "coffee" }, ctxWith(http));
    await expect(adapter.buildCart([{ id: product!.id, quantity: 1 }], ctxWith(http))).rejects.toThrow(/401|refused/i);
  });

  it("a stale session reported inside a 200 asks for one re-auth and retries once", async () => {
    const adapter = new TescoAdapter();
    const stale = { renewed: false, refusals: 0 };
    const http = fakeTescoHttp({ staleUntilReauth: stale });
    const [product] = await adapter.search({ query: "coffee" }, ctxWith(http));
    const reauth = vi.fn(async () => {
      stale.renewed = true;
      return true;
    });
    const cart = await adapter.buildCart([{ id: product!.id, quantity: 1 }], { ...ctxWith(http), reauth });
    expect(cart.cartId).toBe("order_abc123");
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(stale.refusals).toBe(1);
  });

  it("a stale session with no session manager, or one that cannot renew, is a real failure", async () => {
    const adapter = new TescoAdapter();
    const stale = { renewed: false, refusals: 0 };
    const http = fakeTescoHttp({ staleUntilReauth: stale });
    const [product] = await adapter.search({ query: "coffee" }, ctxWith(http));
    await expect(adapter.buildCart([{ id: product!.id, quantity: 1 }], ctxWith(http))).rejects.toThrow(/refused/i);
    const reauth = vi.fn(async () => false);
    await expect(adapter.buildCart([{ id: product!.id, quantity: 1 }], { ...ctxWith(http), reauth })).rejects.toThrow(
      /Reconnect Tesco/,
    );
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  it("detail() refuses an id it never minted", async () => {
    const adapter = new TescoAdapter();
    await expect(adapter.detail("bk_tsc-tesco_nope_00000000", ["stock"], ctxWith(fakeTescoHttp()))).rejects.toThrow(
      /server-minted/,
    );
  });
});
