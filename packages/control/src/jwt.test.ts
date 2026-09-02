import { describe, expect, it } from "vitest";
import { expiryOf } from "./jwt.js";

/** A JWT with the given payload, unsigned -- the signature is never checked here. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.signature-we-never-verify`;
}

describe("expiryOf", () => {
  it("reads the exp claim as milliseconds", () => {
    expect(expiryOf(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it("tolerates a Bearer prefix, because that is how the header arrives", () => {
    expect(expiryOf(`Bearer ${jwt({ exp: 1_800_000_000 })}`)).toBe(1_800_000_000_000);
  });

  it("returns null for a token with no exp, and for something that is not a JWT", () => {
    expect(expiryOf(jwt({ sub: "someone" }))).toBeNull();
    expect(expiryOf("not-a-jwt")).toBeNull();
    expect(expiryOf("")).toBeNull();
  });

  it("returns null rather than NaN when exp is not a number", () => {
    expect(expiryOf(jwt({ exp: "soon" }))).toBeNull();
  });

  /*
   * The signature is not checked and must not be: this is a hint for the
   * panel, not an authorisation decision. A forged exp costs a wrong label on
   * a card the user owns -- checking it would mean holding a retailer's public
   * key, which we have no way to obtain.
   */
  it("does not care that the signature is nonsense", () => {
    const parts = jwt({ exp: 1_800_000_000 }).split(".");
    expect(expiryOf(`${parts[0]}.${parts[1]}.zzzz`)).toBe(1_800_000_000_000);
  });

  it("survives a payload that is not JSON at all", () => {
    expect(expiryOf("aaa.bbb.ccc")).toBeNull();
  });
});
