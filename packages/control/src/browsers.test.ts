import { afterEach, describe, expect, it } from "vitest";
import { browserNameFor, candidateChromePaths } from "./browser-connect.js";

/**
 * Which browsers Connect will look for.
 *
 * The list was Chrome and only Chrome, so the panel told anyone running Edge,
 * Brave or a distro Chromium to install Chrome -- on Windows, where Edge
 * ships with the operating system and is very often the browser they are
 * reading the panel in. All of these are the same engine and the sign-in
 * happens on the retailer's own page either way, so refusing the others
 * bought nothing and cost those users the feature entirely.
 */

const ORIGINAL = process.env["BASKETED_CHROME"];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["BASKETED_CHROME"];
  else process.env["BASKETED_CHROME"] = ORIGINAL;
});

describe("candidateChromePaths", () => {
  it("looks for Edge, Brave and Chromium as well as Chrome", () => {
    delete process.env["BASKETED_CHROME"];
    const names = candidateChromePaths().map(browserNameFor);
    for (const name of ["Google Chrome", "Microsoft Edge", "Brave", "Chromium"]) {
      expect(names, name).toContain(name);
    }
  });

  it("tries Chrome first", () => {
    // Not a correctness rule, a hit-rate one: a session captured in the
    // browser someone already uses is the one most likely to be signed in.
    delete process.env["BASKETED_CHROME"];
    expect(browserNameFor(candidateChromePaths()[0]!)).toBe("Google Chrome");
  });

  it("puts an explicitly named browser ahead of every guess", () => {
    // The escape hatch for a build in a place none of these guesses reach.
    process.env["BASKETED_CHROME"] = "/opt/weird/bin/my-chromium";
    expect(candidateChromePaths()[0]).toBe("/opt/weird/bin/my-chromium");
    expect(candidateChromePaths().length).toBeGreaterThan(1);
  });

  it("ignores an empty or blank override rather than trying to launch it", () => {
    process.env["BASKETED_CHROME"] = "   ";
    expect(candidateChromePaths().every((p) => p.trim() !== "")).toBe(true);
  });

  it("offers something on every platform it can run on", () => {
    delete process.env["BASKETED_CHROME"];
    expect(candidateChromePaths().length).toBeGreaterThan(3);
  });
});

describe("browserNameFor", () => {
  it("names each family from its executable path", () => {
    expect(browserNameFor("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe")).toBe("Microsoft Edge");
    expect(browserNameFor("/usr/bin/brave-browser")).toBe("Brave");
    expect(browserNameFor("/usr/bin/chromium")).toBe("Chromium");
    expect(browserNameFor("/usr/bin/google-chrome-stable")).toBe("Google Chrome");
  });

  it("does not read Edge as Chrome", () => {
    // Edge's own path contains no "chrome", but Chromium's contains "chrom",
    // and a naive substring order reports every one of them as Chrome. The
    // doctor line is worthless if it names the wrong browser.
    expect(browserNameFor("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")).toBe("Microsoft Edge");
    expect(browserNameFor("/Applications/Chromium.app/Contents/MacOS/Chromium")).toBe("Chromium");
  });

  it("falls back to the path rather than inventing a name", () => {
    expect(browserNameFor("/opt/unknown/bin/thing")).toBe("/opt/unknown/bin/thing");
  });
});
