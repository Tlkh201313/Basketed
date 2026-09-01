import { describe, expect, it } from "vitest";
import { SCRIPT } from "./script.js";
import { renderApprovals } from "./pages.js";

/**
 * The panel script ships as a string, so there is no bundler and no linter
 * standing between a typo and a page that silently stops working. These are
 * source contracts: not "does the DOM do the right thing" -- that needs a
 * browser -- but "the properties we fixed bugs to get are still written down".
 *
 * Every assertion here corresponds to a real failure:
 *  - a five-second re-render eating a half-typed total
 *  - a poll that threw leaving a stale page looking live
 *  - four intervals that never stopped
 */

/** The script body, minus comments, so prose cannot satisfy a check. */
const CODE = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the script is a valid program at all", () => {
  it("parses", () => {
    // It is injected into a <script> tag verbatim. A syntax error here is a
    // panel with no behaviour and one line in a console nobody opened.
    expect(() => new Function(SCRIPT)).not.toThrow();
  });

  it("closes every brace and paren it opens", () => {
    for (const [open, close] of [["{", "}"], ["(", ")"], ["[", "]"]] as const) {
      const count = (c: string) => CODE.split(c).length - 1;
      expect(count(open)).toBe(count(close));
    }
  });
});

describe("the approvals poll", () => {
  it("routes every repeating timer through the registry", () => {
    // A bare setInterval is one that pagehide will not clear.
    const bare = CODE.match(/(?<!\w)setInterval\s*\(/g) ?? [];
    // Exactly one: the definition of every() itself.
    expect(bare).toHaveLength(1);
    expect(CODE).toMatch(/function every\(fn, ms\)\s*\{\s*const id = setInterval\(fn, ms\);/);
  });

  it("clears them on pagehide", () => {
    // pagehide, not unload: unload is the event that is not guaranteed to fire
    // and that disqualifies the page from the back/forward cache.
    expect(CODE).toMatch(/addEventListener\("pagehide"/);
    expect(CODE).toMatch(/clearInterval\(id\)/);
    expect(CODE).not.toMatch(/addEventListener\("unload"/);
  });

  it("only re-renders a region whose data changed", () => {
    expect(CODE).toMatch(/function changed\(region, payload\)/);
    expect(CODE).toMatch(/if \(changed\("approvals",/);
    expect(CODE).toMatch(/if \(changed\("orders",/);
    expect(CODE).toMatch(/if \(changed\("state",/);
  });

  it("diffs the approvals payload without its ticking field", () => {
    // Otherwise the diff always says "changed" and we are back to a re-render
    // every five seconds, on top of whatever someone was typing.
    expect(CODE).toMatch(/delete copy\.expires_in_ms/);
    expect(CODE).toMatch(/changed\("approvals", withoutClocks\(data\)\)/);
  });

  it("moves the countdown on its own timer instead of rebuilding the card", () => {
    expect(CODE).toMatch(/function tickClocks\(\)/);
    expect(CODE).toMatch(/every\(tickClocks, 1000\)/);
    expect(CODE).toMatch(/data-deadline=/);
  });

  it("carries a typed total across a re-render, focus included", () => {
    expect(CODE).toMatch(/function snapshotTyped\(\)/);
    expect(CODE).toMatch(/function restoreTyped\(typed\)/);
    // Without re-firing input, the Approve button stays disabled against a
    // total that is now correctly typed.
    expect(CODE).toMatch(/dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
  });

  it("catches a failed poll and says the page is not live", () => {
    expect(CODE).toMatch(/async function refresh\(\)\s*\{\s*try\s*\{/);
    expect(CODE).toMatch(/catch \(err\) \{/);
    expect(CODE).toMatch(/Not live/);
    expect(CODE).toMatch(/\$\("#refresh-status"\)/);
  });
});

describe("the page the script writes into", () => {
  it("has the status line the failure handler targets", () => {
    const html = renderApprovals("tok");
    expect(html).toContain('id="refresh-status"');
    // Announced, because a page that quietly stopped updating is the failure.
    expect(html).toMatch(/id="refresh-status"[^>]*aria-live="polite"/);
  });

  it("still has every container the script queries", () => {
    const html = renderApprovals("tok");
    for (const id of ["approvals", "orders", "guardrails"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
