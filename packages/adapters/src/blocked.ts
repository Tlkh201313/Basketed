/**
 * Telling "the retailer refused us" apart from "there really is nothing".
 *
 * Every scrape adapter had the same hole: fetch the page, run the selectors,
 * return whatever came out. When the selectors matched nothing the adapter
 * returned `[]`, and `[]` is the single most dangerous value in this codebase
 * because it has the right shape. An anti-bot interstitial, a page whose
 * markup moved last Tuesday, and a genuine "no results for hjkl" all arrive as
 * an empty list, and the model then tells a shopper the store does not stock
 * the thing. It does. We just could not see it.
 *
 * So a page is classified before it is parsed:
 *
 *   blocked        the retailer served an interstitial. Report it in failed[],
 *                  never as results, and never retry -- a second identical
 *                  request from the same address is not going to be let
 *                  through, it just costs another few seconds.
 *   unrecognised   200, not an interstitial, but nothing that makes this a
 *                  results page. Almost always our selectors, occasionally a
 *                  redirect. Also a failure, and also loud -- a silently
 *                  drifted selector is a store that quietly stops working.
 *   empty          the page said so itself, in the retailer's own words.
 *                  The only honest `[]`.
 *   ok             parse it.
 *
 * The messages below are worded to fall on the PERMANENT side of
 * isTransientError in commerce/retry.ts. Retrying either failure is pure
 * latency.
 */

/** Interstitials, in the words the big anti-bot vendors actually use. */
const UNIVERSAL_BLOCK = [
  /\bcaptcha\b/i,
  /are you a human/i,
  /robot or human/i,
  /\baccess denied\b/i,
  /unusual traffic/i,
  /verify you are (?:a )?human/i,
  /enable javascript and cookies to continue/i,
  /request (?:was )?blocked/i,
  /pardon our interruption/i,
  /checking your browser/i,
  /cf-browser-verification/i,
  /px-captcha/i,
  /\bincapsula\b/i,
  /\/_Incapsula_Resource/i,
];

export interface PageSpec {
  /** The retailer, for the message a human reads. e.g. "Amazon". */
  store: string;
  /** What this page is, for the same message. e.g. "search", "product page". */
  page: string;
  /**
   * Markup that only a correctly rendered page of this kind has. A container
   * element, a JSON blob, a header. NOT the individual result rows -- a real
   * zero-result page still has the container, and that is exactly the
   * distinction being drawn.
   */
  expect: RegExp[];
  /**
   * The retailer's own way of saying it found nothing. Only a match here
   * turns into an honest empty list.
   */
  empty?: RegExp[];
  /** Block signals particular to this store, on top of the universal ones. */
  blocked?: RegExp[];
}

export type PageVerdict =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "blocked"; reason: string }
  | { kind: "unrecognised"; reason: string };

export function classifyPage(html: string, spec: PageSpec): PageVerdict {
  if (!html || html.trim().length === 0) {
    return { kind: "unrecognised", reason: `${spec.store} ${spec.page} came back empty -- no HTML at all.` };
  }

  const blockHit = [...UNIVERSAL_BLOCK, ...(spec.blocked ?? [])].find((re) => re.test(html));
  if (blockHit) {
    return {
      kind: "blocked",
      reason:
        `${spec.store} blocked this ${spec.page} request -- the page served an anti-bot interstitial ` +
        `(matched ${blockHit.source}) rather than results. Reporting it as a failure, not as an empty ` +
        `list: the store may well stock what was asked for.`,
    };
  }

  // Order matters. A block page can contain the phrase "no results", so the
  // block check runs first; and a real empty page still carries the container
  // the `expect` markers name, so `empty` is checked before `unrecognised`.
  if (spec.empty?.some((re) => re.test(html))) return { kind: "empty" };
  if (spec.expect.some((re) => re.test(html))) return { kind: "ok" };

  return {
    kind: "unrecognised",
    reason:
      `${spec.store} answered, but the ${spec.page} did not look like one -- none of the markers this ` +
      `adapter reads were present. Most likely ${spec.store} changed their markup and this adapter ` +
      `needs updating. Reporting it as a failure rather than as zero results.`,
  };
}

/**
 * `classifyPage` with the two failing verdicts already thrown.
 *
 * Returns true when there is something to parse and false when the page
 * honestly has no results, so a call site reads:
 *
 *     if (!pageHasResults(html, spec)) return [];
 */
export function pageHasResults(html: string, spec: PageSpec): boolean {
  const verdict = classifyPage(html, spec);
  if (verdict.kind === "blocked" || verdict.kind === "unrecognised") throw new Error(verdict.reason);
  return verdict.kind === "ok";
}

/**
 * The detail-page form: there is no "honestly empty" product page, so an
 * `empty` verdict is as much a failure as the other two.
 */
export function assertPageUsable(html: string, spec: PageSpec): void {
  const verdict = classifyPage(html, spec);
  if (verdict.kind === "ok") return;
  if (verdict.kind === "empty") {
    throw new Error(`${spec.store} ${spec.page} reports the item is not there.`);
  }
  throw new Error(verdict.reason);
}
