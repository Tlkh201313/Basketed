/**
 * Outbound redaction (§5) -- the final net over every MCP response.
 *
 * This is deliberately NOT the primary defence. Nothing upstream should ever
 * put a credential in a response: no adapter is handed one (`AdapterCtx` cannot
 * carry a secret), and today Basketed holds none at all. So a redaction hit
 * means something upstream is broken, and it is treated as an alarm rather than
 * as routine hygiene.
 *
 * `watched` stays because the design has a vault in it. It is empty for as long
 * as there is nothing to watch, and a net over nothing costs nothing.
 */

export const REDACTED = "[redacted:secret]";

/**
 * Shapes that are secrets regardless of context. Kept narrow on purpose --
 * a pattern loose enough to catch everything also mangles product
 * descriptions, and a redactor nobody trusts gets switched off.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["stripe", /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g],
  ["github", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g],
  ["shopify", /\bshp(at|ca|pa|ss)_[A-Fa-f0-9]{16,}\b/g],
  ["openai", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["aws", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];

export interface RedactionReport {
  hits: string[];
  count: number;
}

export interface Redactor {
  /** Register a live secret value so its literal appearance is caught too. */
  watch(value: string): void;
  redact<T>(payload: T): { value: T; report: RedactionReport };
  /** Cumulative alarm count, surfaced in the control panel. */
  alarms(): number;
}

export function createRedactor(onAlarm?: (report: RedactionReport) => void): Redactor {
  // Exact secret values the process knows it is holding -- the vault's contents,
  // once there is a vault. Matched literally so that a token which happens not
  // to fit any known shape is still caught on its way out.
  const watched = new Set<string>();
  let alarmCount = 0;

  function scrubString(input: string, hits: string[]): string {
    let out = input;

    for (const value of watched) {
      // Short values would cause absurd false positives; a real credential is long.
      if (value.length < 12) continue;
      if (out.includes(value)) {
        hits.push("vault_value");
        out = out.split(value).join(REDACTED);
      }
    }

    for (const [name, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(out)) {
        hits.push(name);
        pattern.lastIndex = 0;
        out = out.replace(pattern, REDACTED);
      }
    }

    return out;
  }

  function walk(node: unknown, hits: string[]): unknown {
    if (typeof node === "string") return scrubString(node, hits);
    if (Array.isArray(node)) return node.map((n) => walk(n, hits));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v, hits);
      return out;
    }
    return node;
  }

  return {
    watch(value: string) {
      if (value && value.length >= 12) watched.add(value);
    },
    redact<T>(payload: T) {
      const hits: string[] = [];
      const value = walk(payload, hits) as T;
      const report: RedactionReport = { hits: [...new Set(hits)], count: hits.length };
      if (report.count > 0) {
        alarmCount += report.count;
        onAlarm?.(report);
      }
      return { value, report };
    },
    alarms: () => alarmCount,
  };
}
