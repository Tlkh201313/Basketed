/**
 * Hardening for untrusted vendor text (§5 threat model).
 *
 * Product titles, descriptions and reviews are attacker-controlled in the
 * general case: anyone who can list a product can write text that an agent
 * will read. This module makes that text safe to *show*; it is defence in
 * depth, not the primary defence.
 *
 * The primary defence is architectural and lives in commerce: the approval
 * summary a human sees is built ONLY from numeric and enumerated fields plus
 * the normalized product name. No vendor prose reaches the approval screen at
 * all, so there is no sentence an attacker can write that changes what gets
 * bought.
 */

// Built from strings with explicit escapes on purpose: these characters are
// invisible in an editor, so a literal copy of them is unreviewable and is
// silently corrupted by tooling that normalises whitespace.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]", "g");
/** Zero-width and word-joiner characters -- invisible, so they hide payloads. */
const ZERO_WIDTH = new RegExp("[\\u200B-\\u200F\\u2060\\uFEFF]", "g");
/** Bidi overrides can visually reorder text so it reads differently than it parses. */
const BIDI_OVERRIDES = new RegExp("[\\u202A-\\u202E\\u2066-\\u2069]", "g");

const HTML_TAG = /<[^>]*>/g;
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Patterns that look like an attempt to address the model rather than describe
 * a product. Matching does not mean "malicious" -- it means "stop trusting this
 * field", so we flag and truncate rather than silently scrubbing, because a
 * silent scrub would hide an attack we want to know about.
 */
const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  ["override", /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\b/i],
  ["role_marker", /^\s*(system|assistant|user|developer)\s*:/im],
  ["instruction", /\b(you\s+must|your\s+new\s+instructions?|new\s+instructions?\s*:)/i],
  ["tool_shaped", /<\/?(tool_call|function_call|invoke)\b/i],
  ["json_tool", /"(tool_calls?|function_call)"\s*:/i],
  ["approval_bait", /\b(auto[-\s]?approve|approve\s+(this|the)\s+(purchase|order|cart))\b/i],
  ["exfil", /\b(api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|password)\b/i],
];

export interface SanitiseOptions {
  /** Hard character cap. Defaults to 2000; reviews should pass 200. */
  maxLength?: number;
}

export interface SanitiseResult {
  text: string;
  flags: string[];
  truncated: boolean;
}

/**
 * Normalise, strip and cap a single untrusted string.
 *
 * Order matters: normalise first (so lookalike encodings collapse), strip
 * invisibles second (so they cannot hide a pattern from the matcher), and only
 * then run injection detection against what a reader would actually see.
 */
export function sanitiseText(input: string | null | undefined, opts: SanitiseOptions = {}): SanitiseResult {
  const maxLength = opts.maxLength ?? 2000;
  const flags: string[] = [];

  if (!input) return { text: "", flags, truncated: false };

  let text = input.normalize("NFKC");
  text = text.replace(CONTROL_CHARS, "");
  text = text.replace(ZERO_WIDTH, "");
  text = text.replace(BIDI_OVERRIDES, "");

  text = text.replace(HTML_TAG, " ");
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) text = text.split(entity).join(char);
  text = text.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));

  text = text.replace(/\s+/g, " ").trim();

  const matched = INJECTION_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (matched.length) {
    flags.push("possible_injection", ...matched.map((m) => `injection:${m}`));
    // Truncate hard: keep enough to be diagnosable, not enough to be persuasive.
    text = text.slice(0, 120);
    return { text, flags, truncated: true };
  }

  const truncated = text.length > maxLength;
  if (truncated) text = text.slice(0, maxLength).trimEnd() + "…";

  return { text, flags, truncated };
}

/**
 * Product names are shown in the approval summary, so they get the strictest
 * treatment: short cap, and anything that trips a pattern is replaced outright
 * rather than truncated. A name is meant to be a noun phrase; if it is trying
 * to be a sentence addressed to a model, we do not display it at all.
 */
export function sanitiseProductName(input: string | null | undefined): SanitiseResult {
  const res = sanitiseText(input, { maxLength: 120 });
  if (res.flags.includes("possible_injection")) {
    return { text: "[product name withheld: failed safety check]", flags: res.flags, truncated: true };
  }
  return res;
}
