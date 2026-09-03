import { describe, expect, it } from "vitest";
import { loginFor } from "./descriptors.js";
import { cookiesFromHeader } from "./jar.js";

const tesco = loginFor("tsc:tesco")!;

describe("cookiesFromHeader", () => {
  it("turns a Cookie header into domain cookies a context can adopt", () => {
    const now = Date.parse("2026-09-03T12:00:00Z");
    const out = cookiesFromHeader("OAuth.AccessToken=abc; atrc=1; broken; =x; empty=; atrc=dup", tesco, now);
    expect(out).toEqual([
      { name: "OAuth.AccessToken", value: "abc", domain: ".tesco.com", path: "/", secure: true, expires: now / 1000 + 31536000 },
      { name: "atrc", value: "1", domain: ".tesco.com", path: "/", secure: true, expires: now / 1000 + 31536000 },
    ]);
  });

  it("keeps a value that itself contains '='", () => {
    expect(cookiesFromHeader("k=a=b", tesco)[0]).toMatchObject({ name: "k", value: "a=b" });
  });
});
