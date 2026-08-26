/**
 * The credential vault -- DESIGNED, NOT BUILT.
 *
 * This package is an empty placeholder and this file is the whole of it. It is
 * here because four packages already declare the dependency and because the
 * seam is where a vault would go, not because a vault exists behind it.
 *
 * What it would hold: retailer OAuth tokens sealed with AES-256-GCM, the AAD
 * bound to the account handle so a blob lifted from one account cannot be
 * replayed against another, and an interface that returns a CONFIGURED CLIENT
 * rather than a credential, so no token can reach a tool result by accident.
 *
 * What is true today: neither shipped adapter authenticates as anybody. The
 * Shopify UCP transport is anonymous and the simulated stores have nothing to
 * authenticate to, so Basketed currently holds no retailer credential at all --
 * which is a smaller claim than a vault, and the one we can actually make. The
 * only things on disk are the SQLite database under ~/.basketed and whatever
 * the user's own MCP client config already held.
 *
 * README.md says the same thing under "Not built". If that ever stops being
 * true, this comment is the first thing that has to change.
 */
export {};
