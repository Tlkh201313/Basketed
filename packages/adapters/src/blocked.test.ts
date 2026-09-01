import { describe, expect, it } from "vitest";
import { classifyPage, pageHasResults, assertPageUsable, type PageSpec } from "./blocked.js";

/**
 * The distinction this file exists to draw: an anti-bot interstitial, a page
 * whose markup moved, and a genuine "nothing matched" are three different
 * answers. All three used to arrive at the model as `[]`.
 */

const SPEC: PageSpec = {
  store: "Testco",
  page: "search",
  expect: [/results-container/],
  empty: [/no results for/i],
  blocked: [/testco-shield/i],
};

const results = `<html><body><div class="results-container"><li>a thing</li></div></body></html>`;
const empty = `<html><body><div class="results-container"><p>No results for hjkl</p></div></body></html>`;

describe("classifyPage", () => {
  it("passes a page that has the container", () => {
    expect(classifyPage(results, SPEC)).toEqual({ kind: "ok" });
  });

  it("calls a page empty only when the store says so itself", () => {
    // The container is present in both. What separates them is the retailer's
    // own sentence, which is the only evidence that the shelf is really bare.
    expect(classifyPage(empty, SPEC).kind).toBe("empty");
  });

  it("calls an unfamiliar page unrecognised, not empty", () => {
    // Markup drift. The dangerous reading is "the store stocks none of these",
    // and this is the check that stops it.
    const verdict = classifyPage("<html><body><div class='new-markup'></div></body></html>", SPEC);
    expect(verdict.kind).toBe("unrecognised");
    expect(verdict.kind === "unrecognised" && verdict.reason).toMatch(/changed their markup/i);
  });

  it("recognises the interstitials the big anti-bot vendors serve", () => {
    for (const page of [
      "Please complete this CAPTCHA to continue",
      "Are you a human?",
      "Pardon Our Interruption",
      "Checking your browser before accessing",
      "Access Denied",
      "we have detected unusual traffic from your network",
      "Enable JavaScript and cookies to continue",
      `<script src="/_Incapsula_Resource?SWJIYLWA"></script>`,
    ]) {
      expect(classifyPage(`<html><body>${page}</body></html>`, SPEC).kind).toBe("blocked");
    }
  });

  it("takes per-store block signals on top of the universal ones", () => {
    expect(classifyPage("<html>testco-shield engaged</html>", SPEC).kind).toBe("blocked");
  });

  it("checks blocked before empty, because a block page can say 'no results'", () => {
    const trap = `<html><body><div class="results-container">No results for x</div> Are you a human?</body></html>`;
    expect(classifyPage(trap, SPEC).kind).toBe("blocked");
  });

  it("treats no HTML at all as unrecognised", () => {
    for (const html of ["", "   "]) expect(classifyPage(html, SPEC).kind).toBe("unrecognised");
  });

  it("names the store and the page in every failure a human will read", () => {
    for (const html of ["Access Denied", "<div class='new-markup'></div>", ""]) {
      const v = classifyPage(html, SPEC);
      expect(v.kind === "blocked" || v.kind === "unrecognised" ? v.reason : "").toMatch(/Testco/);
    }
  });
});

describe("pageHasResults", () => {
  it("is true for a results page and false for an honestly empty one", () => {
    expect(pageHasResults(results, SPEC)).toBe(true);
    expect(pageHasResults(empty, SPEC)).toBe(false);
  });

  it("throws on blocked and on unrecognised", () => {
    expect(() => pageHasResults("Access Denied", SPEC)).toThrow(/blocked/i);
    expect(() => pageHasResults("<div class='new-markup'></div>", SPEC)).toThrow(/did not look like/i);
  });

  it("throws in the words the retry policy treats as permanent", () => {
    // adapters cannot import commerce (commerce imports adapters), so the
    // contract is pinned as the phrases isTransientError keys on. The matching
    // assertion from the other side lives in commerce/retry.test.ts.
    for (const html of ["Access Denied", "<div class='new-markup'></div>"]) {
      const message = (() => {
        try {
          pageHasResults(html, SPEC);
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect(message).toMatch(/blocked|did not look like/i);
    }
  });
});

describe("assertPageUsable", () => {
  it("accepts a usable page and rejects the other three verdicts", () => {
    expect(() => assertPageUsable(results, SPEC)).not.toThrow();
    expect(() => assertPageUsable("Access Denied", SPEC)).toThrow(/blocked/i);
    expect(() => assertPageUsable("<div class='new-markup'></div>", SPEC)).toThrow(/did not look like/i);
    // There is no such thing as an honestly empty product page.
    expect(() => assertPageUsable(empty, SPEC)).toThrow(/not there/i);
  });
});
