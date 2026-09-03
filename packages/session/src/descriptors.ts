/**
 * Where each store's sign-in lives, and how to tell a signed-in profile from a
 * signed-out one (S23).
 *
 * This replaces the old `ChromeLogin` table in the control package. That
 * table knew a landing URL and a handful of cookie-name prefixes, and nothing
 * ever read the page it landed on -- so a shopper sitting signed-in on the
 * Tesco homepage was indistinguishable from one who was not. A descriptor
 * here answers "am I signed in?" three ways, strongest first: the URL the
 * account page redirects to, what the page itself shows, and only then the
 * cookie jar.
 *
 * Every value is best-effort against a retailer that publishes no contract
 * and may rename a selector tomorrow. `verify` says whether a human has
 * walked the flow end to end on this build; a wrong selector degrades to the
 * next signal down, never to a crash, and the manual checklist in the plan
 * promotes each store as it passes.
 */

export interface LoginProbe {
  /** The account page redirects here when signed out. Tested against the final URL. */
  loggedOutUrlPattern: RegExp;
  /** Present (count > 0) only when signed in. */
  loggedInSelector?: string;
  /** Present only when signed out -- a "Sign in" control in the header, say. */
  loggedOutSelector?: string;
  /** Signed in when this element's text does NOT match `not`. */
  loggedInText?: { selector: string; not: RegExp };
  /**
   * Cookie-name prefixes only a signed-in session carries. The last resort,
   * kept from the old table: none of these retailers documents its cookies.
   */
  authCookies: string[];
}

export interface LoginForm {
  emailSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** Two-step forms (Amazon, eBay) ask for the email first, then the password. */
  continueSelector?: string;
}

export interface StoreLogin {
  /** A page that redirects to the sign-in page when signed out. */
  accountUrl: string;
  loginUrl: string;
  /** Registrable domains whose cookies make up the session. */
  domains: string[];
  /** Extra hosts to ask the jar for, when the identity provider lives elsewhere. */
  cookieUrls?: string[];
  probe: LoginProbe;
  /** Set when the retailer's own form is plain enough to fill in for the user. */
  loginForm?: LoginForm;
  /**
   * Capture the `Authorization` header off requests whose URL contains
   * `match`, and seal THAT rather than the cookie jar. `triggerUrl` is a page
   * that makes the frontend send one. Tesco only, today.
   */
  bearer?: {
    match: string;
    triggerUrl: string;
    /**
     * Lift the token out of the page itself, first capture group. Tesco's
     * trolley embeds its bearer in the page's inline state and talks to a
     * same-origin BFF, so the frontend never sends `match` a request a
     * listener could see (verified live, S23 e2e). The wire listener stays
     * as the fallback.
     */
    pagePattern?: RegExp;
  };
  verify: "verified" | "to-verify";
}

const AMAZON_SIGNIN =
  "https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fgp%2Fcss%2Fhomepage.html" +
  "&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0" +
  "&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select" +
  "&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex";

const TESCO_FORM: LoginForm = { emailSelector: "#username", passwordSelector: "#password", submitSelector: 'button[type="submit"]' };
const AMAZON_FORM: LoginForm = {
  emailSelector: "#ap_email, #ap_email_login",
  continueSelector: "#continue, input#continue",
  passwordSelector: "#ap_password",
  submitSelector: "#signInSubmit",
};

/** The seven real retailers, plus the simulated twins the offline drill signs into. */
export const STORE_LOGINS: Record<string, StoreLogin> = {
  // Tesco's signed-in state is its cookie jar: `OAuth.AccessToken` and its
  // refresh/sid siblings. The token the trolley page embeds is the SAME value
  // as that cookie, and xapi.tesco.com answers `basket` with UNAUTHENTICATED
  // for it (its audience is Tesco's identity service, not the basket API) --
  // verified from a signed-in tab, 2026-09-03. So there is no bearer to lift:
  // the session is sealed as cookies and the basket goes through the
  // site's own same-origin endpoints, cookie-authenticated.
  "tsc:tesco": {
    accountUrl: "https://www.tesco.com/account/en-GB/manage",
    loginUrl: "https://www.tesco.com/account/login/en-GB?from=https%3A%2F%2Fwww.tesco.com%2Fgroceries%2Fen-GB%2F",
    domains: ["tesco.com"],
    probe: {
      // `/account/auth/…/challenges` is the re-auth password prompt: it is
      // not `/account/login/`, and its "Forgotten your password?" link is an
      // `a[href*="/account/"]` that does not say "sign in", so without the
      // `auth` branch the text probe called that page signed-in (S23 e2e).
      loggedOutUrlPattern: /\/account\/(login|auth)\//i,
      loggedInText: { selector: '[data-auto="header-account"], a[href*="/account/"]', not: /sign in/i },
      authCookies: ["OAuth.AccessToken", "OAuth.RefreshToken", "OAuth.Sid", "atrc"],
    },
    loginForm: TESCO_FORM,
    verify: "to-verify",
  },
  // `at-main` is Amazon's authentication token and `sess-at-main` its signed
  // session twin; `x-main` alone only means "recognised", not "signed in".
  // /ap/mfa and /ap/cvf are challenge pages, left to detect.ts on purpose.
  "amz:amazon": {
    accountUrl: "https://www.amazon.com/gp/css/homepage.html",
    loginUrl: AMAZON_SIGNIN,
    domains: ["amazon.com"],
    probe: {
      loggedOutUrlPattern: /\/ap\/signin/i,
      loggedInSelector: "#nav-item-signout",
      loggedInText: { selector: "#nav-link-accountList-nav-line-1", not: /sign in/i },
      authCookies: ["at-main", "sess-at-main"],
    },
    loginForm: AMAZON_FORM,
    verify: "to-verify",
  },
  // IKEA's profile session is `idp_reference_id` plus the `ikea-` prefixed
  // pair its identity provider (Auth0, on login.ikea.com) sets.
  "ikea:ikea": {
    accountUrl: "https://www.ikea.com/us/en/profile/",
    loginUrl: "https://www.ikea.com/us/en/profile/login/",
    domains: ["ikea.com"],
    cookieUrls: ["https://login.ikea.com"],
    probe: {
      loggedOutUrlPattern: /login\.ikea\.com|\/profile\/login/i,
      loggedOutSelector: "form[data-form-primary]",
      loggedInSelector: '[data-testid*="profile"]',
      authCookies: ["idp_reference_id", "ikea-"],
    },
    loginForm: {
      emailSelector: 'input[name="username"]',
      passwordSelector: 'input[name="password"]',
      submitSelector: 'button[name="action"][value="default"], button[type="submit"]',
    },
    verify: "to-verify",
  },
  // Target sets an `accessToken` cookie for guests too, so the URL and the
  // header link are the signals; the cookie list is a last resort only.
  "tgt:target": {
    accountUrl: "https://www.target.com/account",
    loginUrl: "https://www.target.com/login",
    domains: ["target.com"],
    probe: {
      loggedOutUrlPattern: /\/login(\?|$)/i,
      loggedInText: { selector: '[data-test="@web/AccountLink"]', not: /sign in/i },
      authCookies: ["idToken", "refreshToken"],
    },
    loginForm: { emailSelector: "#username", passwordSelector: "#password", submitSelector: "#login" },
    verify: "to-verify",
  },
  // Etsy's `uaid` is set signed-out, so no cookie is trusted here at all.
  "etsy:etsy": {
    accountUrl: "https://www.etsy.com/your/account",
    loginUrl: "https://www.etsy.com/signin",
    domains: ["etsy.com"],
    probe: {
      loggedOutUrlPattern: /\/signin/i,
      loggedInSelector: '[data-selector="header-account-nav"]',
      loggedOutSelector: '[data-selector="sign-in-button"]',
      authCookies: [],
    },
    loginForm: {
      emailSelector: "#join_neu_email_field",
      passwordSelector: "#join_neu_password_field",
      submitSelector: 'button[name="submit_attempt"]',
    },
    verify: "to-verify",
  },
  // eBay signs in on its own host; the jar has to be asked for it explicitly.
  "ebay:ebay": {
    accountUrl: "https://www.ebay.com/mye/myebay/summary",
    loginUrl: "https://signin.ebay.com/signin/",
    domains: ["ebay.com"],
    cookieUrls: ["https://signin.ebay.com"],
    probe: {
      loggedOutUrlPattern: /signin\.ebay\.com/i,
      loggedInSelector: "#gh-ug",
      loggedOutSelector: '#gh-ug a[href*="signin"]',
      authCookies: ["ebaysignin"],
    },
    loginForm: {
      emailSelector: "#userid",
      continueSelector: "#signin-continue-btn",
      passwordSelector: "#pass",
      submitSelector: "#sgnBt",
    },
    verify: "to-verify",
  },
  // Best Buy commonly emails a one-time code after the password; detect.ts
  // turns that into "needs you" rather than a failed sign-in.
  "bby:bestbuy": {
    accountUrl: "https://www.bestbuy.com/profile/ss/account",
    loginUrl: "https://www.bestbuy.com/identity/signin",
    domains: ["bestbuy.com"],
    probe: {
      loggedOutUrlPattern: /\/identity\/(signin|global)/i,
      loggedInText: { selector: ".account-button", not: /^\s*account\s*$/i },
      authCookies: [],
    },
    loginForm: { emailSelector: "#fld-e", passwordSelector: "#fld-p1", submitSelector: 'button[type="submit"]' },
    verify: "to-verify",
  },

  /*
   * The simulated twins. Their catalogue is bundled demo data, but Connect
   * still signs into the real retailer -- the offline drill and the panel
   * tests depend on these having somewhere to go.
   */
  "sim:tesco": {
    accountUrl: "https://www.tesco.com/account/en-GB/manage",
    loginUrl: "https://www.tesco.com/account/login/en-GB",
    domains: ["tesco.com"],
    probe: { loggedOutUrlPattern: /\/account\/(login|auth)\//i, authCookies: ["OAuth.AccessToken", "OAuth.RefreshToken", "OAuth.Sid", "atrc"] },
    loginForm: TESCO_FORM,
    verify: "to-verify",
  },
  "sim:amazon": {
    accountUrl: "https://www.amazon.com/gp/css/homepage.html",
    loginUrl: AMAZON_SIGNIN,
    domains: ["amazon.com"],
    probe: { loggedOutUrlPattern: /\/ap\/signin/i, loggedInSelector: "#nav-item-signout", authCookies: ["at-main", "sess-at-main"] },
    loginForm: AMAZON_FORM,
    verify: "to-verify",
  },
  // Costco runs WebSphere Commerce, which issues WC_AUTHENTICATION_<userId>
  // on sign-in and nothing resembling it before.
  "sim:costco": {
    accountUrl: "https://www.costco.com/myaccount",
    loginUrl: "https://www.costco.com/LogonForm",
    domains: ["costco.com"],
    probe: { loggedOutUrlPattern: /LogonForm|\/logon/i, authCookies: ["WC_AUTHENTICATION_", "C_AUTH", "costco_auth"] },
    verify: "to-verify",
  },
  "sim:walmart": {
    accountUrl: "https://www.walmart.com/account",
    loginUrl: "https://www.walmart.com/account/login",
    domains: ["walmart.com"],
    probe: { loggedOutUrlPattern: /\/account\/login/i, authCookies: ["customer", "CID", "auth-"] },
    verify: "to-verify",
  },
  "sim:shopee": {
    accountUrl: "https://shopee.sg/user/account/profile",
    loginUrl: "https://shopee.sg/buyer/login",
    domains: ["shopee.sg"],
    probe: { loggedOutUrlPattern: /\/buyer\/login/i, authCookies: ["SPC_ST", "SPC_U", "SPC_R_T_ID"] },
    verify: "to-verify",
  },
  "sim:taobao": {
    accountUrl: "https://i.taobao.com/my_taobao.htm",
    loginUrl: "https://login.taobao.com/member/login.jhtml",
    domains: ["taobao.com"],
    probe: { loggedOutUrlPattern: /login\.taobao\.com/i, authCookies: ["_l_g_", "unb", "cookie2", "_nk_"] },
    verify: "to-verify",
  },
  "sim:ikea": {
    accountUrl: "https://www.ikea.com/gb/en/profile/",
    loginUrl: "https://www.ikea.com/gb/en/profile/login/",
    domains: ["ikea.com"],
    cookieUrls: ["https://login.ikea.com"],
    probe: { loggedOutUrlPattern: /login\.ikea\.com|\/profile\/login/i, authCookies: ["idp_reference_id", "ikea-"] },
    verify: "to-verify",
  },
};

/** The seven real retailers, in the order the manual checklist walks them. */
export const REAL_LOGIN_STORES = [
  "tsc:tesco",
  "amz:amazon",
  "ikea:ikea",
  "tgt:target",
  "etsy:etsy",
  "ebay:ebay",
  "bby:bestbuy",
] as const;

export function loginFor(storeId: string): StoreLogin | null {
  return STORE_LOGINS[storeId] ?? null;
}

/** Every URL the cookie jar is asked for: apex, www, and any named extra host. */
export function cookieUrlsFor(d: StoreLogin): string[] {
  return [...d.domains.flatMap((h) => [`https://${h}`, `https://www.${h}`]), ...(d.cookieUrls ?? [])];
}
