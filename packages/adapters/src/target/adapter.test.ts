import { describe, expect, it } from "vitest";
import { TargetAdapter } from "./adapter.js";
import type { RenderResult } from "../stealth/browser.js";
import type { AdapterCtx, StoreAdapter } from "../types.js";

/**
 * Fixtures modeled on what was actually observed live against target.com
 * during development (a retry-poll probe against the real search and PDP
 * pages), not invented shapes -- see adapter.ts's header comment for the
 * investigation notes. In particular: card `data-focusid` and the TCIN in the
 * card's own link href are DIFFERENT numbers on live Target, so the fixture
 * below deliberately keeps them different, the same way Tesco's fixture keeps
 * its internal id and TPNB different -- a fixture where they happened to
 * match would not catch an id-conflation regression.
 */

const SEARCH_CARD_HTML = (focusId: string, tcin: string, slug: string, title: string, priceText: string) => `
  <div data-test="@web/site-top-of-funnel/ProductCardWrapper" data-focusid="${focusId}_product_card">
    <a href="/p/${slug}/-/A-${tcin}?preselect=${focusId}#lnk=sametab">
      <img src="https://target.scene7.com/is/image/Target/GUEST_${tcin}?wid=300" />
      <div data-test="@web/ProductCard/title">${title}</div>
    </a>
    <div data-test="current-price">${priceText}</div>
  </div>
`;

function searchPageHtml(cards: string): string {
  // Padded well past the adapter's MIN_PLAUSIBLE_HTML_LENGTH block heuristic.
  return `<html><body><!-- ${"x".repeat(21000)} -->${cards}</body></html>`;
}

function detailPageHtml(title: string, priceText: string, image: string): string {
  return `<html><body><!-- ${"x".repeat(21000)} -->
    <h1 data-test="product-title">${title}</h1>
    <div data-test="product-price">${priceText}</div>
    <div data-test="hero-image"><img src="${image}" /></div>
  </body></html>`;
}

const FIXTURE = {
  focusId: "1012908942",
  tcin: "1012910804",
  slug: "amerlife-wood-coffee-table-with-storage-2-drawers-open-shelf",
  title: "AMERLIFE Wood Coffee Table with Storage, 2 Drawers & Open Shelf",
  priceText: "$139.99 - $149.99reg $199.99Sale",
  image: "https://target.scene7.com/is/image/Target/GUEST_1012910804?wid=300",
};

function fakeRenderReturning(html: string, status = 200): (url: string, opts?: unknown) => Promise<RenderResult> {
  return async () => ({ status, html, finalUrl: "https://www.target.com/" });
}

function ctx(): AdapterCtx {
  return { http: fetch, log: () => {}, snapshots: false };
}

describe("real Target adapter (S16)", () => {
  it("is mode native with only the tiers it actually implements", () => {
    const adapter = new TargetAdapter({ render: fakeRenderReturning("") });
    expect(adapter.manifest.mode).toBe("native");
    expect(adapter.manifest.capabilities).toEqual(["discovery", "detail"]);
    const asInterface: StoreAdapter = adapter;
    expect(typeof asInterface.buildCart).toBe("undefined");
    expect(typeof asInterface.handoff).toBe("undefined");
  });

  it("search returns real-shaped products with server-minted ids and the low end of a ranged/sale price", async () => {
    const html = searchPageHtml(
      SEARCH_CARD_HTML(FIXTURE.focusId, FIXTURE.tcin, FIXTURE.slug, FIXTURE.title, FIXTURE.priceText),
    );
    const adapter = new TargetAdapter({ render: fakeRenderReturning(html) });
    const products = await adapter.search({ query: "coffee table" }, ctx());

    expect(products).toHaveLength(1);
    const p = products[0]!;
    expect(p.name).toBe(FIXTURE.title);
    expect(p.price).toEqual({ value: 139.99, currency: "USD" });
    expect(p.mode).toBe("native");
    expect(p.source).toBe("target.com");
    expect(p.id).toMatch(/^bk_tgt-target_/);
  });

  it("detail() round-trips a cached id back to a full product page", async () => {
    const searchHtml = searchPageHtml(
      SEARCH_CARD_HTML(FIXTURE.focusId, FIXTURE.tcin, FIXTURE.slug, FIXTURE.title, FIXTURE.priceText),
    );
    const detailHtml = detailPageHtml(FIXTURE.title, "$139.99", FIXTURE.image);

    let call = 0;
    const render = async (): Promise<RenderResult> => {
      call += 1;
      return { status: 200, html: call === 1 ? searchHtml : detailHtml, finalUrl: "https://www.target.com/" };
    };
    const adapter = new TargetAdapter({ render });

    const [product] = await adapter.search({ query: "coffee table" }, ctx());
    const detail = await adapter.detail(product!.id, [], ctx());

    expect(detail.name).toBe(FIXTURE.title);
    expect(detail.price).toEqual({ value: 139.99, currency: "USD" });
    expect(detail.image).toBe(FIXTURE.image);
    expect(detail._meta?.provenance).toBeDefined();
  });

  it("detail() refuses an id it never minted", async () => {
    const adapter = new TargetAdapter({ render: fakeRenderReturning("") });
    await expect(adapter.detail("bk_tgt-target_nope_00000000", [], ctx())).rejects.toThrow(/server-minted/);
  });

  /**
   * The TCIN embedded in a card's link href is Target's real product id;
   * `data-focusid` is a different, unrelated number. A regression that mints
   * ids from focusId instead would still "work" for search (the id round-
   * trips against whatever was cached) but silently point every detail()
   * lookup at the wrong page. This pins the href's TCIN as the source of
   * truth by asserting on the specific, deliberately-mismatched fixture
   * values above.
   */
  it("mints ids from the href TCIN, not the unrelated data-focusid", async () => {
    expect(FIXTURE.focusId).not.toBe(FIXTURE.tcin);
    const searchHtml = searchPageHtml(
      SEARCH_CARD_HTML(FIXTURE.focusId, FIXTURE.tcin, FIXTURE.slug, FIXTURE.title, FIXTURE.priceText),
    );
    const detailHtml = detailPageHtml(FIXTURE.title, "$139.99", FIXTURE.image);

    const seenUrls: string[] = [];
    const render = async (url: string): Promise<RenderResult> => {
      seenUrls.push(url);
      return { status: 200, html: seenUrls.length === 1 ? searchHtml : detailHtml, finalUrl: url };
    };
    const adapter = new TargetAdapter({ render });

    const [product] = await adapter.search({ query: "coffee table" }, ctx());
    await adapter.detail(product!.id, [], ctx());

    const detailUrl = seenUrls[1]!;
    expect(detailUrl).toContain(`A-${FIXTURE.tcin}`);
    expect(detailUrl).not.toContain(FIXTURE.focusId);
  });

  it("throws an honest block error when the search page never hydrates real cards", async () => {
    const blockedHtml = searchPageHtml("");
    const adapter = new TargetAdapter({ render: fakeRenderReturning(blockedHtml) });
    await expect(adapter.search({ query: "coffee table" }, ctx())).rejects.toThrow(/blocked|did not render/i);
  });

  it("throws an honest block error on a suspiciously short response", async () => {
    const adapter = new TargetAdapter({ render: fakeRenderReturning("<html>short</html>") });
    await expect(adapter.search({ query: "coffee table" }, ctx())).rejects.toThrow(/blocked|did not render/i);
  });
});
