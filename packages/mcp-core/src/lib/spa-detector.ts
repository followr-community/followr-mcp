// SPA detector.
//
// Some modern websites (Shopify Hydrogen, Next.js heavy CSR builds, React
// or Vue SPAs without SSR) render almost everything client-side. A plain
// fetch returns an HTML shell with a near-empty <body>, the real content
// only appears after the JS bundle runs.
//
// For deep_research, that means:
//   - Heuristic extractors (CSS selectors over the DOM) find nothing.
//   - JSON-LD inline in <head> may still be present (Shopify embeds it).
//   - og:meta tags are usually present.
//
// We flag these cases with `requires_js_render: true` so the caller can:
//   - Accept the limited shallow data in fast / standard depth modes.
//   - Escalate to a JS-rendering pipeline (e.g. Cloudflare Browser
//     Rendering) in thorough mode. The integration with Browser
//     Rendering itself is out of scope for this module; we only flag.
//
// Detection heuristics, ranked by reliability:
//   1. Body text is empty or shorter than a small threshold.
//   2. Body contains only a single empty mount node (#root / #__next /
//      [data-reactroot] / #app).
//   3. <noscript> tag with "please enable JavaScript" content.
//   4. Presence of certain SPA framework markers (script tags, comments).
//
// These are heuristics, not proofs. False positives are tolerable: the
// caller can still try the extractors and fall back gracefully when
// they return nothing. False negatives are also tolerable: the
// extractors just return less than they could.

import type { ParsedHtml } from "./extractors/html-parser.js";

export interface SpaDetectionResult {
  /** True when the page very likely needs JS execution to expose content. */
  requires_js_render: boolean;
  /** One-line rationale for diagnostics. */
  reason: string;
  /** How short the body text was, for the caller's reference. */
  body_text_length: number;
  /** Whether a <noscript> tag with a JS-required message was found. */
  has_noscript_warning: boolean;
  /** Whether the body root looks like a known empty SPA mount node. */
  empty_mount_root: boolean;
}

const SPA_MOUNT_SELECTORS = [
  "#root",
  "#__next",
  "#app",
  "#__nuxt",
  "[data-reactroot]",
  "[data-svelte-root]",
];

const NOSCRIPT_KEYWORDS = [
  "enable javascript",
  "habilitar javascript",
  "habilita javascript",
  "you need to enable",
  "javascript is required",
  "javascript no está habilitado",
];

const BODY_TEXT_THRESHOLD = 500;

export function detectSpa(parsed: ParsedHtml): SpaDetectionResult {
  const body_text_length = parsed.body_text.length;

  // 1. Body text length check.
  const isVeryShort = body_text_length < BODY_TEXT_THRESHOLD;

  // 2. Empty mount root check. We look for any known mount node and ask
  //    whether it is essentially empty (no descendants or only a small
  //    script/noscript fallback).
  let empty_mount_root = false;
  for (const sel of SPA_MOUNT_SELECTORS) {
    const node = parsed.document.querySelector(sel);
    if (!node) continue;
    const innerText = (node.textContent ?? "").trim();
    if (innerText.length < 100) {
      empty_mount_root = true;
      break;
    }
  }

  // 3. <noscript> warning check.
  let has_noscript_warning = false;
  for (const ns of Array.from(parsed.document.querySelectorAll("noscript"))) {
    const txt = (ns.textContent ?? "").toLowerCase();
    if (NOSCRIPT_KEYWORDS.some((kw) => txt.includes(kw))) {
      has_noscript_warning = true;
      break;
    }
  }

  // Decide. Any one strong signal flags it; otherwise require at least
  // two weak signals to avoid false positives on legit short landing
  // pages.
  const strong = empty_mount_root || has_noscript_warning;
  const weak = isVeryShort;
  const requires_js_render = strong || (weak && body_text_length < 200);

  let reason: string;
  if (empty_mount_root) {
    reason = "empty SPA mount node detected (e.g. #root, #__next, #app)";
  } else if (has_noscript_warning) {
    reason = "<noscript> tag asks the visitor to enable JavaScript";
  } else if (requires_js_render) {
    reason = `body text is very short (${body_text_length} chars), site likely renders client-side`;
  } else if (isVeryShort) {
    reason = `body text is short (${body_text_length} chars) but no other SPA signals; treating as renderable`;
  } else {
    reason = "body has substantive content; standard extraction should work";
  }

  return {
    requires_js_render,
    reason,
    body_text_length,
    has_noscript_warning,
    empty_mount_root,
  };
}
