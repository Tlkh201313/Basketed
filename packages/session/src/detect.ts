import type { ProbePage } from "./page.js";

/**
 * Is the page asking for something only a human can give?
 *
 * Basketed does not solve captchas, guess one-time codes or bypass Cloudflare
 * -- and does not try to. What it does is NOTICE, so a sign-in that stalled on
 * a challenge reads as "needs you" in the panel rather than "not signed in",
 * and so a headless re-login never sits on an OTP prompt pretending to work.
 *
 * Every signal here is public page structure: a title, a selector, a phrase.
 * `evidence` names the signal that fired, never the page content.
 */

export type HumanKind = "cloudflare" | "access_denied" | "captcha" | "otp";

export interface HumanNeeded {
  kind: HumanKind;
  evidence: string;
}

interface Signal {
  kind: HumanKind;
  title?: RegExp;
  url?: RegExp;
  selectors?: string[];
  text?: RegExp;
  /** For `text`: every pattern in `and` must match too. */
  and?: RegExp;
}

/** Ordered: an interstitial hides the form behind it, so it is asked about first. */
const SIGNALS: Signal[] = [
  {
    kind: "cloudflare",
    title: /just a moment|attention required/i,
    selectors: ["#challenge-form", "#cf-challenge-running", 'iframe[src*="challenges.cloudflare.com"]', "#cf-chl-widget"],
    text: /verify you are human|checking your browser before accessing|performance & security by cloudflare/i,
  },
  {
    kind: "access_denied",
    title: /access denied/i,
    text: /access denied/i,
    and: /reference #|errors\.edgesuite\.net|don't have permission to access/i,
  },
  {
    kind: "captcha",
    selectors: [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      "#auth-captcha-image",
      'form[action*="validateCaptcha"]',
      '[id*="captcha" i]',
      'img[src*="captcha" i]',
      '[class*="px-captcha" i]',
    ],
    text: /type the characters|enter the characters you see|solve this puzzle|press and hold/i,
  },
  {
    kind: "otp",
    url: /\/ap\/(mfa|cvf|challenge)|signin\.ebay\.com\/.*(otp|verify|challenge)|\/identity\/(challenge|verify)/i,
    selectors: [
      'input[autocomplete="one-time-code"]',
      "#auth-mfa-otpcode",
      "#cvf-input-code",
      'input[name="otpCode"]',
      'input[name="verificationCode"]',
      "#otp-input",
      'input[name="code"][inputmode="numeric"]',
    ],
    text: /enter the (code|verification code|one[- ]time (code|passcode))|we (sent|texted|emailed) (you )?a (code|verification)|two[- ]step verification|verify it'?s you|approve (this )?sign[- ]in|check your (phone|email) for a code/i,
  },
];

/** Never throws: a page that vanishes mid-question is simply "no signal". */
export async function detectHumanNeeded(page: ProbePage): Promise<HumanNeeded | null> {
  let title = "";
  let url = "";
  let body: string | null = null;
  try {
    url = page.url();
    title = await page.title();
  } catch {
    return null;
  }
  const bodyText = async (): Promise<string> => {
    if (body === null) {
      try {
        body = (await page.bodyText()).slice(0, 20_000);
      } catch {
        body = "";
      }
    }
    return body;
  };

  for (const s of SIGNALS) {
    if (s.title?.test(title)) return { kind: s.kind, evidence: "title" };
    if (s.url?.test(url)) return { kind: s.kind, evidence: "url" };
    for (const sel of s.selectors ?? []) {
      try {
        if ((await page.count(sel)) > 0) return { kind: s.kind, evidence: sel };
      } catch {
        /* a locator that throws is a page mid-navigation, not a signal */
      }
    }
    if (s.text) {
      const text = await bodyText();
      if (s.text.test(text) && (!s.and || s.and.test(text))) return { kind: s.kind, evidence: "text" };
    }
  }
  return null;
}
