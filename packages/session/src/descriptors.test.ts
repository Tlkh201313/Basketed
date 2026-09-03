import { describe, it, expect } from "vitest";
import {
  TescoAdapter,
  AmazonAdapter,
  IkeaAdapter,
  TargetAdapter,
  EtsyAdapter,
  EbayAdapter,
  BestBuyAdapter,
} from "@basketed/adapters";
import { STORE_LOGINS, REAL_LOGIN_STORES, loginFor, cookieUrlsFor } from "./descriptors.js";
import { bearerFromHtml } from "./login.js";
import { profileDir } from "./profiles.js";

describe("store login descriptors", () => {
  it("cover the seven real retailers under their adapters' own ids", () => {
    const ids = [
      new TescoAdapter(),
      new AmazonAdapter(),
      new IkeaAdapter(),
      new TargetAdapter(),
      new EtsyAdapter(),
      new EbayAdapter(),
      new BestBuyAdapter(),
    ].map((a) => a.manifest.id);
    expect([...REAL_LOGIN_STORES].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(loginFor(id)).not.toBeNull();
  });

  it("every URL is https on one of the listed domains", () => {
    for (const [id, d] of Object.entries(STORE_LOGINS)) {
      for (const url of [d.accountUrl, d.loginUrl, ...(d.cookieUrls ?? [])]) {
        const u = new URL(url);
        expect(u.protocol, `${id} ${url}`).toBe("https:");
        expect(d.domains.some((dom) => u.hostname === dom || u.hostname.endsWith(`.${dom}`)), `${id} ${url}`).toBe(true);
      }
      if (d.bearer) expect(new URL(d.bearer.triggerUrl).protocol).toBe("https:");
    }
  });

  it("the logged-out pattern matches the login page and never the account page", () => {
    for (const [id, d] of Object.entries(STORE_LOGINS)) {
      expect(d.probe.loggedOutUrlPattern.test(d.loginUrl), `${id} login`).toBe(true);
      expect(d.probe.loggedOutUrlPattern.test(d.accountUrl), `${id} account`).toBe(false);
    }
  });

  it("Tesco's re-auth challenge reads as logged out, and the signed-in dashboard does not", () => {
    const d = STORE_LOGINS["tsc:tesco"]!;
    expect(d.probe.loggedOutUrlPattern.test("https://www.tesco.com/account/auth/en-GB/challenges?from=x")).toBe(true);
    expect(d.probe.loggedOutUrlPattern.test("https://www.tesco.com/account/dashboard/en-GB")).toBe(false);
  });

  it("a bearer embedded in page state can be lifted by pattern", () => {
    const pattern = /"authorization"\s*:\s*"([^"]+)"/;
    const html =
      '{"optimizelyDisabled":false,"authorization":"eyJabc.def_ghi-jkl","hasQueueItSession":false,' +
      '"mangoUrl":"https:\\u002F\\u002Fxapi.tesco.com\\u002F"}';
    expect(bearerFromHtml(html, pattern)).toBe("eyJabc.def_ghi-jkl");
    expect(bearerFromHtml('"authorization":"Bearer tok\\u002Fen"', pattern)).toBe("tok/en");
    expect(bearerFromHtml("<html>nothing</html>", pattern)).toBeNull();
  });

  it("cookie URLs ask for apex, www and the identity host", () => {
    expect(cookieUrlsFor(STORE_LOGINS["ebay:ebay"]!)).toEqual(["https://ebay.com", "https://www.ebay.com", "https://signin.ebay.com"]);
  });

  it("profile directories are filesystem-safe and distinct per store", () => {
    const a = profileDir("tsc:tesco");
    const b = profileDir("sim:tesco");
    expect(a).not.toBe(b);
    expect(a.endsWith("tsc_tesco")).toBe(true);
    expect(a).not.toContain(":tesco");
  });

  it("unknown stores have no sign-in flow", () => {
    expect(loginFor("shop:nowhere")).toBeNull();
  });
});
