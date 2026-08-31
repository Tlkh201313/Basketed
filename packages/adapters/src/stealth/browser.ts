import { chromium } from "patchright";

/**
 * Shared stealth-browser render for the three scrape-based adapters (Amazon,
 * IKEA, Target). Public, unauthenticated search/detail pages only -- no
 * login, no cart automation, nothing that touches a shopper's own session.
 *
 * This is NOT ctx.http. These retailers' anti-bot layers (Amazon's own
 * system; Akamai on Target) reject a plain HTTP client outright -- there is
 * no JSON API to call, so an adapter here drives a real, patched Chromium
 * instead. That is a genuine departure from the AdapterCtx contract (see
 * types.ts): ctx.http is the only network primitive an adapter is handed
 * specifically so it can never see a credential, but there is no credential
 * in play for these three -- every page rendered here is one a signed-out
 * browser can already see. Cart-tier automation would require an
 * authenticated session and is out of scope for exactly that reason.
 *
 * The launch config below is Chromium's own "harmful" launch flags removed
 * and a set of stealth flags added -- reverse-engineered from Scrapling
 * (github.com/d4vinci/Scrapling), whose StealthyFetcher wraps this same
 * patchright engine. Verified live, store by store, before any adapter code
 * was written against it: Amazon and IKEA passed on the first attempt;
 * Target needed no config change, only a longer settle wait. Shopee was
 * tried against this same config and stayed genuinely blocked -- see
 * "Where the data comes from" in the repo README -- so it has no adapter
 * here.
 */

const DEFAULT_ARGS = [
  "--no-pings",
  "--no-first-run",
  "--disable-infobars",
  "--disable-breakpad",
  "--no-service-autorun",
  "--homepage=about:blank",
  "--password-store=basic",
  "--disable-hang-monitor",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--disable-search-engine-choice-screen",
];

const STEALTH_ARGS = [
  "--test-type",
  "--mute-audio",
  "--disable-sync",
  "--hide-scrollbars",
  "--disable-logging",
  "--start-maximized", // headless-check bypass
  "--enable-async-dns",
  "--use-mock-keychain",
  "--disable-translate",
  "--disable-voice-input",
  "--window-position=0,0",
  "--disable-wake-on-wifi",
  "--ignore-gpu-blocklist",
  "--enable-tcp-fast-open",
  "--enable-web-bluetooth",
  "--disable-cloud-import",
  "--disable-print-preview",
  "--disable-dev-shm-usage",
  "--metrics-recording-only",
  "--disable-crash-reporter",
  "--disable-partial-raster",
  "--disable-gesture-typing",
  "--disable-checker-imaging",
  "--disable-prompt-on-repost",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--aggressive-cache-discard",
  "--disable-cookie-encryption",
  "--disable-domain-reliability",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--enable-simple-cache-backend",
  "--disable-background-networking",
  "--enable-surface-synchronization",
  "--disable-image-animation-resync",
  "--disable-renderer-backgrounding",
  "--disable-ipc-flooding-protection",
  "--prerender-from-omnibox=disabled",
  "--safebrowsing-disable-auto-update",
  "--disable-offer-upload-credit-cards",
  "--disable-background-timer-throttling",
  "--disable-new-content-rendering-timeout",
  "--run-all-compositor-stages-before-draw",
  "--disable-client-side-phishing-detection",
  "--disable-backgrounding-occluded-windows",
  "--disable-layer-tree-host-memory-pressure",
  "--autoplay-policy=user-gesture-required",
  "--disable-offer-store-unmasked-wallet-cards",
  "--disable-blink-features=AutomationControlled",
  "--disable-component-extensions-with-background-pages",
  "--enable-features=NetworkService,NetworkServiceInProcess,TrustTokens,TrustTokensAlwaysAllowIssuance",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
  "--disable-features=AudioServiceOutOfProcess,TranslateUI,BlinkGenPropertyTrees",
];

/** Chromium adds these by default; each one is itself a detectable signal. */
const HARMFUL_ARGS = [
  "--enable-automation",
  "--disable-popup-blocking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface RenderOptions {
  /** Extra settle time after `domcontentloaded`, for pages that hydrate client-side. */
  settleMs?: number;
  timeoutMs?: number;
}

export interface RenderResult {
  status: number | null;
  html: string;
  finalUrl: string;
}

/**
 * Renders one URL in a fresh, throwaway browser and returns its HTML.
 *
 * A fresh browser per call, not a shared long-lived instance: these are
 * low-volume discovery/detail lookups, not a crawl, and a clean profile per
 * request is one less thing that can accumulate a detectable fingerprint or
 * leak state between unrelated searches.
 *
 * `waitUntil: "networkidle"` was tried first and rejected -- IKEA (and
 * likely others) never goes network-idle within a normal timeout because of
 * persistent background scripts (chat widgets, analytics beacons), which
 * reads as a block but isn't. `domcontentloaded` plus an explicit settle
 * wait is what the store adapters actually verified against.
 */
export async function renderPage(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const browser = await chromium.launch({
    headless: true,
    channel: "chromium", // NOT "chrome" -- that silently swaps in a stock installed
    // Chrome via CDP and defeats patchright's own patches.
    args: [...DEFAULT_ARGS, ...STEALTH_ARGS],
    ignoreDefaultArgs: HARMFUL_ARGS,
  });
  try {
    const context = await browser.newContext({
      colorScheme: "dark", // bypasses creepjs's prefersLightColor check
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: false,
      serviceWorkers: "allow",
      ignoreHTTPSErrors: true,
      screen: { width: 1920, height: 1080 },
      viewport: { width: 1920, height: 1080 },
      permissions: ["geolocation", "notifications"],
      locale: "en-US",
      extraHTTPHeaders: { referer: "https://www.google.com/" },
      userAgent: USER_AGENT,
    });
    const page = await context.newPage();
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 30000,
    });
    await page.waitForTimeout(opts.settleMs ?? 4000);
    const html = await page.content();
    return { status: resp?.status() ?? null, html, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}
