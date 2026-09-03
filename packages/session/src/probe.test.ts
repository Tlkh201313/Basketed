import { describe, it, expect } from "vitest";
import { isSignedIn } from "./probe.js";
import { detectHumanNeeded } from "./detect.js";
import { FakePage } from "./fake-page.js";
import type { StoreLogin } from "./descriptors.js";

const FAST = { settleMs: 5, stabilityMs: 50 };

const store: StoreLogin = {
  accountUrl: "https://www.example.com/account",
  loginUrl: "https://www.example.com/login",
  domains: ["example.com"],
  probe: {
    loggedOutUrlPattern: /\/login/,
    loggedInSelector: "#signout",
    loggedOutSelector: "#signin-button",
    loggedInText: { selector: "#greeting", not: /sign in/i },
    authCookies: ["sess_", "auth"],
  },
  verify: "to-verify",
};

describe("isSignedIn", () => {
  it("navigates to the account page and calls a bounce to /login signed out", async () => {
    const page = new FakePage({ redirects: ["https://www.example.com/account", "https://www.example.com/login?from=account"] });
    const r = await isSignedIn(page, store, FAST);
    expect(page.gotos).toEqual(["https://www.example.com/account"]);
    expect(r.signedIn).toBe(false);
    expect(r.reason).toBe("url:logged_out");
    expect(r.finalUrl).toContain("/login");
  });

  it("a challenge page beats a login URL: needs a human, not 'signed out'", async () => {
    const page = new FakePage({
      redirects: ["https://www.example.com/login"],
      present: ['input[autocomplete="one-time-code"]'],
    });
    const r = await isSignedIn(page, store, FAST);
    expect(r.signedIn).toBe(false);
    expect(r.human).toBe("otp");
    expect(r.reason).toBe("needs_human:otp");
  });

  it("a signed-in selector wins over a cookie jar that says nothing", async () => {
    const page = new FakePage({ redirects: ["https://www.example.com/account"], present: ["#signout"] });
    const r = await isSignedIn(page, store, FAST);
    expect(r).toMatchObject({ signedIn: true, reason: "selector:logged_in" });
  });

  it("the greeting text counts, unless it still says Sign in", async () => {
    const yes = new FakePage({ redirects: ["https://www.example.com/account"], texts: { "#greeting": "Hello, Sam" } });
    expect((await isSignedIn(yes, store, FAST)).reason).toBe("text:logged_in");
    const no = new FakePage({ redirects: ["https://www.example.com/account"], texts: { "#greeting": "Sign in" } });
    expect((await isSignedIn(no, store, FAST)).signedIn).toBe(false);
  });

  it("a visible Sign in button is signed out even with stray cookies", async () => {
    const page = new FakePage({
      redirects: ["https://www.example.com/account"],
      present: ["#signin-button"],
      cookies: [{ name: "sess_x", value: "1" }],
    });
    expect((await isSignedIn(page, store, FAST)).reason).toBe("selector:logged_out");
  });

  it("falls back to a prefix-matched, non-empty cookie and names it -- never its value", async () => {
    const page = new FakePage({
      redirects: ["https://www.example.com/account"],
      cookies: [
        { name: "sess_abc", value: "" },
        { name: "AUTH_token", value: "topsecretvalue" },
      ],
    });
    const r = await isSignedIn(page, store, FAST);
    expect(r).toMatchObject({ signedIn: true, reason: "cookie:AUTH_token" });
    expect(JSON.stringify(r)).not.toContain("topsecretvalue");
  });

  it("no signal at all is signed out", async () => {
    const page = new FakePage({ redirects: ["https://www.example.com/account"] });
    expect((await isSignedIn(page, store, FAST)).reason).toBe("no_signal");
  });

  it("retries a reset connection and then succeeds", async () => {
    const page = new FakePage({ redirects: ["https://www.example.com/account"], present: ["#signout"], failGotos: 2 });
    const r = await isSignedIn(page, store, FAST);
    expect(page.gotos).toHaveLength(3);
    expect(r.signedIn).toBe(true);
  });

  it("gives up after three failed navigations without throwing", async () => {
    const page = new FakePage({ failGotos: 5 });
    const r = await isSignedIn(page, store, FAST);
    expect(r.signedIn).toBe(false);
    expect(r.reason).toMatch(/^error:net::ERR_CONNECTION_RESET/);
  });

  it("a throwing locator degrades to the next signal instead of propagating", async () => {
    const page = new FakePage({
      redirects: ["https://www.example.com/account"],
      throwing: ["#signout"],
      cookies: [{ name: "sess_1", value: "v" }],
    });
    const r = await isSignedIn(page, store, FAST);
    expect(r).toMatchObject({ signedIn: true, reason: "cookie:sess_1" });
  });

  it("a non-navigating probe reads wherever the page already is", async () => {
    const page = new FakePage({ url: "https://www.example.com/login", present: ["#signout"] });
    const r = await isSignedIn(page, store, { ...FAST, navigate: false });
    expect(page.gotos).toEqual([]);
    expect(r.reason).toBe("url:logged_out");
  });
});

describe("detectHumanNeeded", () => {
  it("cloudflare interstitial", async () => {
    expect(await detectHumanNeeded(new FakePage({ title: "Just a moment..." }))).toMatchObject({ kind: "cloudflare" });
    expect(await detectHumanNeeded(new FakePage({ present: ["#challenge-form"] }))).toMatchObject({ kind: "cloudflare" });
  });
  it("akamai access denied needs the reference line, not the phrase alone", async () => {
    expect(await detectHumanNeeded(new FakePage({ body: "Access Denied. Reference #18.abc" }))).toMatchObject({ kind: "access_denied" });
    expect(await detectHumanNeeded(new FakePage({ body: "Access denied to this coupon" }))).toBeNull();
  });
  it("captcha", async () => {
    expect(await detectHumanNeeded(new FakePage({ present: ['iframe[src*="recaptcha"]'] }))).toMatchObject({ kind: "captcha" });
    expect(await detectHumanNeeded(new FakePage({ body: "Type the characters you see in this image" }))).toMatchObject({
      kind: "captcha",
    });
  });
  it("one-time code, by field, URL or phrase", async () => {
    expect(await detectHumanNeeded(new FakePage({ present: ["#auth-mfa-otpcode"] }))).toMatchObject({ kind: "otp" });
    expect(await detectHumanNeeded(new FakePage({ url: "https://www.amazon.com/ap/cvf/request" }))).toMatchObject({ kind: "otp" });
    expect(await detectHumanNeeded(new FakePage({ body: "We sent a code to your phone ending in 12" }))).toMatchObject({ kind: "otp" });
  });
  it("a plain signed-in page is nothing to worry about", async () => {
    expect(await detectHumanNeeded(new FakePage({ title: "Your Account", body: "Hello Sam, your orders", present: ["#signout"] }))).toBeNull();
  });
  it("evidence never carries page content", async () => {
    const r = await detectHumanNeeded(new FakePage({ body: "We emailed a code to secret@example.com" }));
    expect(r?.evidence).toBe("text");
  });
});
