// Industry-aware deep research tools.
//
// Two tools:
//
//   deep_research(company_id, depth?, user_industry_hint?, force_refresh?)
//     End-to-end: fetches the company website, classifies the industry,
//     runs the matching IndustryProfile's extractors, returns a
//     normalized DeepResearchResult with detected_industry, common
//     fields (name, description, logo, contact, social), industry-
//     specific data (products, menu, articles, etc), suggested content
//     pillars, sufficiency score, and meta diagnostics.
//
//   classify_industry(website_url? OR text_sample?)
//     Lighter: only classification, no extractors, no fetch needed when
//     text_sample is provided. Useful when the agent wants to disambiguate
//     without paying the deep_research cost.
//
// Architecture:
//   - The MCP server is stateless. We do NOT call an LLM from this tool.
//     When the heuristic classifier is ambiguous, we surface candidates
//     plus signals_for_classification and let the LLM client decide.
//   - We DO persist the detected industry on Company.description (only
//     the [industry:<id>@<date>] marker) before returning successfully.
//     This unblocks prepare_content_plan_context / draft_content_plan
//     which read cached_industry from that marker; before this change
//     the agent had to call update_company itself, but no generic
//     update_company tool is exposed, so the cache never got written
//     and downstream planning tools blocked on a null cache forever.
//   - Extraction is per-profile declarative: IndustryProfile.extractors
//     tells us what fields to fetch and how. The actual extraction logic
//     lives in lib/extractors and is industry-agnostic.

import type { Company, FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import {
  bodyTextExcerpt,
  detectEcommercePlatform,
  extractArticles,
  extractContact,
  extractImages,
  extractJsonLd,
  extractMenu,
  extractOgMeta,
  extractProducts,
  fetchPlatformCatalog,
  fetchProductsViaSitemap,
  parseHtml,
  type ArticleEntry,
  type ContactInfo,
  type EcommercePlatform,
  type ExtractedProduct,
  type MenuItem,
  type OgMetaResult,
  type ParsedHtml,
} from "../lib/extractors/index.js";
import {
  ALL_INDUSTRY_IDS,
  getProfile,
  INDUSTRY_PROFILES,
  type ExtractorSpec,
  type IndustryId,
  type IndustryProfile,
} from "../lib/industry-profiles/index.js";
import { invalidateContextsForCompany } from "../lib/content-plan-state.js";
import { detectSpa, type SpaDetectionResult } from "../lib/spa-detector.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

// ── Depth modes ─────────────────────────────────────────────────────────────

interface DepthSettings {
  fetch_timeout_ms: number;
  max_bytes: number;
  max_extra_paths: number;
  use_sitemap: boolean;
}

const DEPTH_SETTINGS: Record<"fast" | "standard" | "thorough", DepthSettings> = {
  fast: { fetch_timeout_ms: 5_000, max_bytes: 500_000, max_extra_paths: 0, use_sitemap: false },
  standard: { fetch_timeout_ms: 10_000, max_bytes: 2_000_000, max_extra_paths: 2, use_sitemap: false },
  thorough: { fetch_timeout_ms: 15_000, max_bytes: 5_000_000, max_extra_paths: 6, use_sitemap: true },
};

// ── Classifier ─────────────────────────────────────────────────────────────

interface ClassificationCandidate {
  id: IndustryId;
  score: number;
  matched_keywords: string[];
}

interface ClassificationOutcome {
  best: ClassificationCandidate;
  candidates: ClassificationCandidate[];
  confidence: "high" | "medium" | "low" | "ambiguous";
  reasoning: string;
}

/**
 * Score a text sample against every IndustryProfile. Returns the full
 * candidate list sorted desc + a chosen confidence level based on the
 * gap between best and runner-up.
 */
function classifyText(text: string): ClassificationOutcome {
  const lowerText = text.toLowerCase();
  const scored: ClassificationCandidate[] = [];

  for (const id of ALL_INDUSTRY_IDS) {
    if (id === "generic_business") continue;
    const profile = INDUSTRY_PROFILES[id];
    if (!profile) continue;

    let score = 0;
    const matched: string[] = [];

    for (const kw of profile.keywords.strong) {
      if (containsWord(lowerText, kw)) {
        score += 3;
        matched.push(kw);
      }
    }
    for (const kw of profile.keywords.weak) {
      if (containsWord(lowerText, kw)) {
        score += 1;
        matched.push(kw);
      }
    }
    if (profile.negative_keywords) {
      for (const kw of profile.negative_keywords) {
        if (containsWord(lowerText, kw)) score -= 2;
      }
    }

    scored.push({ id, score, matched_keywords: matched });
  }

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0] ?? { id: "generic_business" as IndustryId, score: 0, matched_keywords: [] };
  const runnerUp = scored[1] ?? { id: "generic_business" as IndustryId, score: 0, matched_keywords: [] };

  let confidence: ClassificationOutcome["confidence"];
  let reasoning: string;
  if (best.score >= 6 && runnerUp.score * 2 <= best.score) {
    confidence = "high";
    reasoning = `Strong match: ${best.id} with score ${best.score}, runner-up ${runnerUp.id} at ${runnerUp.score}`;
  } else if (best.score >= 3 && runnerUp.score * 1.5 <= best.score) {
    confidence = "medium";
    reasoning = `Moderate match: ${best.id} with score ${best.score}, gap to runner-up ${runnerUp.id} at ${runnerUp.score}`;
  } else if (best.score >= 2) {
    confidence = "ambiguous";
    reasoning = `Ambiguous: ${best.id} and ${runnerUp.id} have comparable scores (${best.score} vs ${runnerUp.score})`;
  } else {
    confidence = "low";
    reasoning = "No industry profile scored above the floor; falling back to generic_business";
  }

  return { best, candidates: scored, confidence, reasoning };
}

/** Word-boundary containment so we do not match "art" inside "earth". */
function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const n = needle.toLowerCase();
  // Multi-word needles: substring match is fine (spaces are word boundaries).
  if (n.includes(" ")) return haystack.includes(n);
  // Single-word: use a regex with \b on both sides.
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  } catch {
    return haystack.includes(n);
  }
}

// ── Cache helpers ──────────────────────────────────────────────────────────

// Marker shape on Company.description:
//   [industry:<id>@<YYYY-MM-DD>]            auto-detected (default, heuristic or deep_research)
//   [industry:<id>@<YYYY-MM-DD>:confirmed]  user confirmed (after presenting the auto result)
//
// Group 3 captures any colon-prefixed flag so callers can branch on confirmation
// state. Legacy markers (no flag) are treated as auto / not confirmed; that is
// intentional, so cached values written before 2026-05-26 get re-confirmed by
// the user the next time prepare_content_plan_context runs.
//
// The id class MUST include digits ([a-z0-9_]+): industries like service_b2b
// contain a digit and were silently unparseable with the old [a-z_]+ class.
// That bug manifested in the PipeLime session (2026-05-27) as an infinite
// confirm_industry → prepare_content_plan_context loop because the marker
// was being written but never matched on read, and applyCacheSuffixToDescription
// then appended a duplicate marker on every retry.
export const CACHE_SUFFIX_RE = /\[industry:([a-z0-9_]+)@(\d{4}-\d{2}-\d{2})(?::([a-z0-9_]+))?\]/i;
// Global variant used by applyCacheSuffixToDescription to strip ALL existing
// markers before writing a fresh one. Without this, two confirm_industry calls
// can leave two markers in the description when the first marker was unreadable
// by the previous buggy regex.
const CACHE_SUFFIX_STRIP_RE = /\n*\s*\[industry:[a-z0-9_]+@\d{4}-\d{2}-\d{2}(?::[a-z0-9_]+)?\]\s*/gi;
export const CONFIRMED_FLAG = "confirmed";
// Bump 2026-05-25: 30 → 90 días. La industria de una marca cambia rara vez;
// si cambia el user puede forzar refresh con force_refresh: true.
const CACHE_TTL_DAYS = 90;

/**
 * Append (or replace) the `[industry:<id>@<date>]` marker on a company
 * description. Used by deep_research and confirm_industry to persist the
 * cache itself instead of asking the agent to call update_company (the
 * agent has no exposed update_company tool, so leaving this to the agent
 * created a structural dead-end where downstream planning tools blocked
 * on a missing cache the agent could not write).
 */
export function applyCacheSuffixToDescription(currentDescription: string | null, suffix: string): string {
  const desc = currentDescription ?? "";
  // Strip ALL existing industry markers (global flag) so any duplicates left
  // behind by the pre-fix bug get collapsed into a single fresh marker. Then
  // append the new suffix. Plain replace-first-match would leave older
  // duplicates intact and let the read path pick a stale auto marker over the
  // newly written :confirmed one.
  const stripped = desc.replace(CACHE_SUFFIX_STRIP_RE, "").trimEnd();
  return stripped.length > 0 ? `${stripped}\n\n${suffix}` : suffix;
}

export interface CachedIndustry {
  id: IndustryId;
  cached_at: string;
  age_days: number;
  fresh: boolean;
  /**
   * True only when the marker carries the `:confirmed` flag, which means the
   * user (not just the heuristic / deep_research) approved this industry.
   * Auto-detected and legacy markers come back with confirmed: false; the
   * planning tools treat them as "needs confirmation before drafting".
   */
  confirmed: boolean;
}

export function readCachedIndustry(description: string | null | undefined): CachedIndustry | null {
  if (!description) return null;
  const m = description.match(CACHE_SUFFIX_RE);
  if (!m) return null;
  const id = m[1] as IndustryId;
  const cachedAt = m[2];
  const flag = m[3] ?? null;
  if (!cachedAt || !ALL_INDUSTRY_IDS.includes(id)) return null;
  const cachedMs = Date.parse(cachedAt);
  if (Number.isNaN(cachedMs)) return null;
  const ageDays = Math.floor((Date.now() - cachedMs) / (1000 * 60 * 60 * 24));
  return {
    id,
    cached_at: cachedAt,
    age_days: ageDays,
    fresh: ageDays <= CACHE_TTL_DAYS,
    confirmed: flag === CONFIRMED_FLAG,
  };
}

export function buildCacheSuffix(id: IndustryId, confirmed: boolean = false): string {
  const today = new Date().toISOString().slice(0, 10);
  return confirmed
    ? `[industry:${id}@${today}:${CONFIRMED_FLAG}]`
    : `[industry:${id}@${today}]`;
}

// ── Fetch with budget ──────────────────────────────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  truncated: boolean;
  /** Response headers with lowercased keys. set-cookie values are joined with "; ". */
  headers: Record<string, string>;
  error?: string;
}

async function fetchWithBudget(url: string, settings: DepthSettings): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.fetch_timeout_ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "FollowrMCP-DeepResearch/1.0 (contact: marcos@followr.ai)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    // Capture response headers (lowercased). Used downstream for platform
    // detection (e.g. Shopify sets link: <https://cdn.shopify.com>; and
    // _shopify_* cookies).
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      headers[k] = headers[k] ? `${headers[k]}; ${value}` : value;
    });
    if (!res.ok) {
      return { ok: false, status: res.status, body: "", truncated: false, headers, error: `HTTP ${res.status}` };
    }
    // Read up to max_bytes. We stream when available, otherwise read text and truncate.
    const text = await res.text();
    const truncated = text.length > settings.max_bytes;
    const body = truncated ? text.slice(0, settings.max_bytes) : text;
    return { ok: true, status: res.status, body, truncated, headers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, body: "", truncated: false, headers: {}, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── Extractor runner ───────────────────────────────────────────────────────

interface ExtractorRunReport {
  succeeded: string[];
  failed: { name: string; reason: string }[];
}

interface IndustrySpecificData {
  // Discriminated union shape; emitted as a plain object so the LLM client
  // can read whatever subset of fields the profile filled in.
  industry: IndustryId;
  data: Record<string, unknown>;
}

/**
 * Run a profile's primary extractors against the parsed HTML and return
 * the assembled industry_specific data + a per-extractor report.
 *
 * This function does not crawl additional paths; the caller decides
 * whether to invoke it once per fetched page.
 */
function runProfileExtractors(
  parsed: ParsedHtml,
  profile: IndustryProfile,
): { data: Record<string, unknown>; report: ExtractorRunReport } {
  const data: Record<string, unknown> = {};
  const report: ExtractorRunReport = { succeeded: [], failed: [] };

  const allSpecs = [...profile.extractors.primary, ...profile.extractors.secondary];

  for (const spec of allSpecs) {
    try {
      const value = runOneExtractor(parsed, spec);
      if (value === undefined || value === null) {
        if (spec.required) {
          report.failed.push({ name: `${spec.field}:${spec.strategy}`, reason: "no result" });
        }
        continue;
      }
      // Merge: lists get concatenated, scalars get last-write-wins.
      const existing = data[spec.field];
      if (Array.isArray(value) && Array.isArray(existing)) {
        data[spec.field] = [...existing, ...value];
      } else {
        data[spec.field] = value;
      }
      report.succeeded.push(`${spec.field}:${spec.strategy}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.failed.push({ name: `${spec.field}:${spec.strategy}`, reason: msg });
    }
  }

  return { data, report };
}

function runOneExtractor(parsed: ParsedHtml, spec: ExtractorSpec): unknown {
  switch (spec.strategy) {
    case "json_ld": {
      const entries = extractJsonLd(parsed, spec.jsonld_types);
      if (entries.length === 0) return null;
      return entries.slice(0, spec.max_items ?? 30);
    }
    case "og_meta": {
      // og_meta extractors typically target a single common field; we
      // return the full og meta object so the planner can pick what it
      // needs. The data.og_meta key is always set when this runs.
      return extractOgMeta(parsed);
    }
    case "css_selector": {
      // For images, products, menu, articles, etc. We route via the
      // declared field name to the right extractor.
      if (!spec.selectors || spec.selectors.length === 0) return null;
      switch (spec.field) {
        case "products":
          return extractProducts(parsed, { selectors: spec.selectors, maxItems: spec.max_items ?? 30 });
        case "menu_items":
        case "dish_photos":
          return extractMenu(parsed, { selectors: spec.selectors, maxItems: spec.max_items ?? 50 });
        case "latest_articles":
        case "top_stories":
        case "recent_content":
        case "case_studies":
        case "thought_leadership":
        case "past_events_gallery":
        case "current_campaigns":
        case "transformation_gallery":
        case "portfolio_projects":
        case "premises_photos":
        case "model_photos":
        case "product_images":
        case "clients_logos":
        case "gallery":
        case "logo_url":
          return extractImagesField(parsed, spec);
        case "social_links":
          return extractSocialLinks(parsed, spec.selectors);
        default:
          return extractGenericText(parsed, spec.selectors, spec.max_items ?? 10);
      }
    }
    case "regex_text": {
      if (!spec.regex) return null;
      try {
        const re = new RegExp(spec.regex, "g");
        const matches = parsed.body_text.match(re) ?? [];
        const dedup = Array.from(new Set(matches.map((s) => s.trim())));
        return dedup.slice(0, spec.max_items ?? 10);
      } catch {
        return null;
      }
    }
    case "rss_feed":
    case "sitemap_path":
      // Async strategies are handled at a higher level (with their own
      // fetch). Skip here.
      return null;
  }
}

function extractImagesField(parsed: ParsedHtml, spec: ExtractorSpec): string[] | null {
  if (!spec.selectors || spec.selectors.length === 0) return null;
  const urls = extractImages(parsed, {
    selectors: spec.selectors,
    maxItems: spec.max_items ?? 30,
  });
  return urls.length > 0 ? urls : null;
}

interface SocialLink {
  type: string;
  url: string;
}

function extractSocialLinks(parsed: ParsedHtml, selectors: string[]): SocialLink[] {
  const seen = new Set<string>();
  const out: SocialLink[] = [];
  for (const node of parsed.querySelectorAll(selectors)) {
    const href = node.getAttribute("href");
    if (!href) continue;
    const absolute = parsed.resolveUrl(href);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    const type = inferSocialType(absolute);
    out.push({ type, url: absolute });
    if (out.length >= 20) break;
  }
  return out;
}

function inferSocialType(url: string): string {
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("facebook.com")) return "facebook";
  if (url.includes("linkedin.com")) return "linkedin";
  if (url.includes("twitter.com") || url.includes("x.com")) return "x";
  if (url.includes("youtube.com")) return "youtube";
  if (url.includes("threads.net")) return "threads";
  if (url.includes("pinterest.com")) return "pinterest";
  if (url.includes("bluesky.app") || url.includes("bsky.app")) return "bluesky";
  return "other";
}

function extractGenericText(parsed: ParsedHtml, selectors: string[], maxItems: number): string[] | null {
  const out: string[] = [];
  for (const node of parsed.querySelectorAll(selectors)) {
    const txt = node.textContent?.trim();
    if (txt && txt.length > 0 && txt.length < 500) {
      out.push(txt);
    }
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : null;
}

// ── Content pillars + sufficiency ──────────────────────────────────────────

interface InferredPillar {
  pillar: string;
  rationale: string;
  sample_post_idea: string;
}

function inferContentPillars(profile: IndustryProfile, data: Record<string, unknown>): InferredPillar[] {
  return profile.content_pillars_suggested.map((pillar) => ({
    pillar,
    rationale: `Suggested by the ${profile.id} profile; surfaces a common content angle for this kind of brand.`,
    sample_post_idea: sampleIdeaFor(pillar, data),
  }));
}

function sampleIdeaFor(pillar: string, data: Record<string, unknown>): string {
  const products = data["products"];
  if (Array.isArray(products) && products.length > 0) {
    const first = products[0] as { name?: string };
    if (first?.name) return `${pillar} featuring ${first.name}`;
  }
  return `${pillar} post tailored to the brand context surfaced in industry_specific.data`;
}

interface Sufficiency {
  score: "complete" | "partial" | "thin";
  missing_for_high_quality_plan: string[];
  recommendations: string[];
}

function scoreSufficiency(
  profile: IndustryProfile,
  data: Record<string, unknown>,
  report: ExtractorRunReport,
): Sufficiency {
  const required = profile.extractors.primary.filter((s) => s.required);
  const missingRequired = required.filter((s) => !data[s.field] || isEmpty(data[s.field]));

  const missing: string[] = missingRequired.map((s) => s.field);
  const recommendations: string[] = [];

  if (missing.length === 0 && report.succeeded.length >= 3) {
    return { score: "complete", missing_for_high_quality_plan: [], recommendations: [] };
  }
  if (missingRequired.length === 0) {
    return {
      score: "partial",
      missing_for_high_quality_plan: missing,
      recommendations: ["consider uploading additional brand assets (logo, product photos, lifestyle shots) to enrich plans"],
    };
  }
  return {
    score: "thin",
    missing_for_high_quality_plan: missing,
    recommendations: [
      "ask the user for product photos or a Google Sheet with catalog data",
      "consider re-running with depth: thorough to crawl more pages",
    ],
  };
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object" && value !== null && Object.keys(value).length === 0) return true;
  return false;
}

// ── Auto-orchestration helper for prepare_content_plan_context ────────────
//
// THE PROBLEM this solves
// =======================
// prepare_content_plan_context surfaces a warning when the company has no
// cached industry, then draft_content_plan refuses to execute when the cache
// is still missing. The agent has to: (1) notice the warning OR hit the
// draft block, (2) call deep_research separately, (3) call
// prepare_content_plan_context AGAIN because the first context_id captured
// cached_industry_id: null (now stale, since deep_research wrote the suffix).
// That's three round-trips for what should be a single bootstrap operation.
//
// THE SHAPE of this fix
// =====================
// ensureIndustryClassified is a thin, fast version of deep_research that
// does ONLY what's needed to unblock the planning hard-block:
//
//   1. read the company description, return early on a fresh cache hit
//   2. fetch the home page with the "fast" depth budget (5s / 500KB)
//   3. run the heuristic classifier
//   4. persist [industry:<id>@<date>] back to Company.description
//
// It deliberately SKIPS the full deep_research extractors (no product
// catalog crawl, no sitemap fallback, no ecommerce platform fast-path),
// because those are expensive and not required to lift the draft block.
// prepare_content_plan_context calls this when it detects a cache miss;
// the agent can still call deep_research explicitly later for the full
// catalog data if the brand benefits from product image grounding (fashion,
// food, retail, real estate).
//
// All errors are absorbed and surfaced via the discriminated result so a
// classification failure never breaks prepare_content_plan_context (the
// existing "no cache" path remains a graceful degradation).
export interface EnsureIndustryClassifiedResult {
  /** True when an industry id is available after this call (cache hit or fresh classify). */
  classified: boolean;
  /** The industry id when classified, null otherwise. */
  industry_id: IndustryId | null;
  /** True when the cache was already populated before this call. */
  from_cache: boolean;
  /** True when a fresh classification was performed (i.e. fetch + classify ran). */
  classification_performed: boolean;
  /** True when the suffix was written back to Company.description. */
  persistence_ok: boolean;
  /** When classification failed, a short human-readable explanation. */
  reason: string | null;
  /** Wall-clock duration in ms. */
  duration_ms: number;
}

export async function ensureIndustryClassified(
  client: FollowrClient,
  company_id: number,
  options: { userIndustryHint?: string } = {},
): Promise<EnsureIndustryClassifiedResult> {
  const startedAt = Date.now();
  const durationMs = (): number => Date.now() - startedAt;

  let company: Company;
  try {
    company = await client.getCompany(company_id);
  } catch (err) {
    return {
      classified: false,
      industry_id: null,
      from_cache: false,
      classification_performed: false,
      persistence_ok: false,
      reason: `getCompany failed: ${err instanceof Error ? err.message : String(err)}`,
      duration_ms: durationMs(),
    };
  }

  const description = (company as Company & { description?: string | null }).description ?? null;
  const websiteUrl = (company as Company & { website?: string | null }).website ?? null;

  // Cache hit: nothing to do.
  const cached = readCachedIndustry(description);
  if (cached && cached.fresh) {
    return {
      classified: true,
      industry_id: cached.id,
      from_cache: true,
      classification_performed: false,
      persistence_ok: true,
      reason: null,
      duration_ms: durationMs(),
    };
  }

  if (!websiteUrl || websiteUrl.trim().length === 0) {
    return {
      classified: false,
      industry_id: null,
      from_cache: false,
      classification_performed: false,
      persistence_ok: false,
      reason: "company has no website URL, cannot classify automatically",
      duration_ms: durationMs(),
    };
  }

  // Fetch the home page at STANDARD depth (10s, 2MB cap). Antes era "fast"
  // (5s/500KB) y producía clasificaciones flacas: landings con un home
  // minimalista (ej. SaaS con poco copy en home) caían en clasificación
  // generica/local_business porque las keywords técnicas del producto vivían
  // en sub-pages que el fast budget no alcanzaba a llegar.
  const fetched = await fetchWithBudget(websiteUrl, DEPTH_SETTINGS.standard);
  if (!fetched.ok) {
    return {
      classified: false,
      industry_id: null,
      from_cache: false,
      classification_performed: false,
      persistence_ok: false,
      reason: `home page fetch failed: ${fetched.error ?? `HTTP ${fetched.status}`}`,
      duration_ms: durationMs(),
    };
  }

  const parsed = parseHtml(fetched.body, websiteUrl);
  const og = extractOgMeta(parsed);
  let classification = classifyWithHint(parsed, og, options.userIndustryHint);

  // CAMBIO 2026-05-25: confidence-gated sub-path crawl.
  // Si la home page DIO una clasificación con alta confidence, no perdemos
  // tiempo crawleando sub-pages (la mayoría de los casos obvios: pizza shop,
  // fashion store, gym). Solo cuando confidence es medium/low/ambiguous
  // intentamos enriquecer con 2 sub-pages del candidato top, y re-clasificamos
  // con el texto combinado. Mantiene el path rápido cuando es trivial,
  // mejora accuracy cuando es ambiguo.
  //
  // Esto fixea el caso PipeLime (SaaS minimal-landing → clasificaba como
  // local_business) y similares.
  if (classification.confidence !== "high") {
    const candidateProfile = getProfile(classification.best.id);
    try {
      const extraPages = await crawlExtraPages(
        candidateProfile,
        websiteUrl,
        DEPTH_SETTINGS.standard,
      );
      if (extraPages.length > 0) {
        // Re-clasifica con el texto combinado de home + sub-pages.
        // Cada sub-page aporta hasta 3000 chars del body para no inflar.
        const combinedTextParts: string[] = [];
        if (options.userIndustryHint) combinedTextParts.push(options.userIndustryHint);
        if (og.title) combinedTextParts.push(og.title);
        if (og.description) combinedTextParts.push(og.description);
        if (og.og_description) combinedTextParts.push(og.og_description);
        combinedTextParts.push(bodyTextExcerpt(parsed, 6000));
        for (const extra of extraPages) {
          combinedTextParts.push(bodyTextExcerpt(extra.parsed, 3000));
        }
        const combinedText = combinedTextParts.join("\n");
        const secondPass = classifyText(combinedText);
        // Solo aceptamos la second pass si mejoró la confidence o cambió la
        // industria a algo más específico. Si bajó la confidence, descartamos.
        const confidenceRank: Record<typeof secondPass.confidence, number> = {
          ambiguous: 0,
          low: 1,
          medium: 2,
          high: 3,
        };
        if (confidenceRank[secondPass.confidence] >= confidenceRank[classification.confidence]) {
          classification = secondPass;
        }
      }
    } catch {
      // Sub-page fetch failures non-fatal: nos quedamos con la first-pass.
    }
  }
  const profile = getProfile(classification.best.id);

  // Persist the cache suffix. Failure here is non-fatal: we still return
  // classified: true so the caller can use the industry_id in-memory for the
  // current session; the next session will re-classify (cheap).
  let persistence_ok = false;
  try {
    const suffix = buildCacheSuffix(profile.id);
    const newDescription = applyCacheSuffixToDescription(description, suffix);
    if (newDescription !== description) {
      await client.updateCompany(company_id, { description: newDescription });
    }
    persistence_ok = true;
  } catch {
    persistence_ok = false;
  }

  return {
    classified: true,
    industry_id: profile.id,
    from_cache: false,
    classification_performed: true,
    persistence_ok,
    reason: null,
    duration_ms: durationMs(),
  };
}

// ── Tool registrations ────────────────────────────────────────────────────

export function registerResearchTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "deep_research",
    {
      annotations: READ_ONLY,
      title: "Deep research on a company website: detect industry, extract product images and catalog, menu items, articles or properties (Shopify, WooCommerce, VTEX, generic). Investigar empresa y extraer imágenes y catálogo de marca",
      description: `Investigar el sitio de una empresa y extraer assets reales (imágenes de catálogo, fotos de productos, lookbook, menu items, articles, properties) para usar como referencia en planes de contenido. The tool fetches the company website, detects ecommerce platform (Shopify, WooCommerce, VTEX), uses documented JSON catalog APIs when available, falls back to sitemap parsing for unrecognized sites, runs industry-specific HTML extractors, classifies the industry from page text, and returns a normalized payload the planning agent uses to ground content plans in the brand's real material.

WHEN TO CALL: al inicio de cualquier tarea de contenido no trivial (a week of posts, a campaign, a launch, a series). Una llamada por conversación por compañía alcanza; cacheá el resultado con el cache_suggestion. Llamar SIEMPRE antes de armar un plan si la marca tiene catálogo visual (moda, comida, retail, real estate) para que los assets generados se parezcan a la marca real y no a fashion-genérico-AI.

NOTE (2026-05-26): prepare_content_plan_context no longer auto-classifies on cache miss. The keyword heuristic was wrong too often for minimalist B2B SaaS landings, and it then poisoned the cache. The new flow is explicit: (1) when industry_setup_proposal is present on the context response, call deep_research; (2) it writes an auto marker [industry:<id>@<date>] to Company.description; (3) present the detected_industry to the user with the catalog of available industries and ask for confirmation; (4) call confirm_industry({ company_id, industry_id }) with the user's final pick. Only after that final call does draft_content_plan accept the plan. The user can override the auto-detection (free-text like "es Software B2C") and the agent should map their response to the closest available industry before calling confirm_industry.

EXTRACTION STRATEGY (in priority order):
1. Ecommerce platform fast-path. Detects Shopify (cdn.shopify.com header, _shopify_* cookie), WooCommerce (meta generator, /wp-json/wc/), VTEX (vtexassets.com, vtexcommerce.com). When matched, hits the platform's documented JSON catalog API (/products.json, /wp-json/wc/store/v1/products, /api/catalog_system/pub/products/search/) for full product data with image arrays in one request.
2. Sitemap fallback for SPA sites or unrecognized platforms. Reads sitemap_products_*.xml or sitemap.xml, filters product-shaped URLs, fetches the first 4-8 in parallel and extracts JSON-LD Product or og:image+title from each.
3. HTML CSS extractors per industry profile (products, menu, articles, etc). Runs on the home page and up to 2 profile-suggested sub-paths.
4. LLM handoff. When 1-3 all fail, returns hints_for_llm_fallback with sitemap_urls_to_try, og_image and next_steps_for_agent. The agent can then WebFetch those URLs manually or ask the user for product URLs to retry with website_url override.

DEPTH MODES:
- fast: home page only, 5s timeout, 500KB cap, no sub-page crawl. Use when iterating quickly.
- standard (default): home page + up to 2 profile-suggested sub-paths + sitemap fallback for ecommerce when extractors return empty, 10s timeout, 2MB cap. Recommended.
- thorough: aggressive crawl including sitemap top URLs, 15s timeout, 5MB cap. Use when onboarding a new company.

CLASSIFIER: a heuristic keyword scorer matches the page text against 16 industry profiles plus a generic fallback. When confidence is "ambiguous" the tool returns the top candidates plus signals_for_classification ({title, description, body_excerpt, og_type, social_links_types}) and the LLM client decides. The MCP itself never calls an external LLM for classification.

OUTPUT:
- detected_industry: id + confidence + reasoning + (when ambiguous) candidates + signals.
- common: company_name, title, description, language, logo_url, contact (emails, phones), social_links.
- industry_specific: { industry, data } where data is industry-specific (products with image_urls, menu_items, latest_articles, properties, etc).
- content_pillars_inferred: suggested pillars with sample post ideas.
- sufficiency: complete | partial | thin, with recommendations to enrich data.
- hints_for_llm_fallback (only when sufficiency is thin and ecommerce extraction failed): platform_detected, sitemap_urls_to_try, og_image, next_steps_for_agent so the LLM can recover via WebFetch or user prompts.
- meta: extractors_succeeded, extractors_failed, parser_used, requires_js_render, platform_detected, sitemap_diagnostics, duration_ms.
- cache_suggestion: deep_research now persists the [industry:<id>@<date>] marker on Company.description automatically before returning, so subsequent prepare_content_plan_context / draft_content_plan calls read cached_industry and skip the re-classification. The suffix in cache_suggestion.suffix_to_append is what was applied; cache_suggestion.persisted is true when the write succeeded (false + persistence_error when not, in which case the planning tools will trigger another deep_research instead of reading from cache). The agent does NOT need to call any follow-up tool to apply the cache.

LIMITATIONS:
- Pure custom SPAs without documented APIs and without a sitemap may still return empty. The tool surfaces hints_for_llm_fallback in that case so the LLM can try its own WebFetch on specific URLs.
- The classifier works best in es / en. Other languages: the heuristic still runs on universal keywords (most strong keywords have es+en synonyms) but confidence may be lower; the LLM client handles the ambiguous case.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        website_url: z
          .string()
          .url()
          .optional()
          .describe("Override the company's website URL. Default reads Company.website."),
        user_industry_hint: z
          .string()
          .optional()
          .describe("Free-text hint from the user (e.g. 'my restaurant' or 'soy una SaaS'). Used to bias the classifier."),
        depth: z.enum(["fast", "standard", "thorough"]).optional().describe("Depth of crawl and extraction. Default standard."),
        force_refresh: z.boolean().optional().describe("Ignore the cached industry suffix on Company.description and re-classify."),
      },
    },
    async ({ company_id, website_url, user_industry_hint, depth, force_refresh }) => {
      const startedAt = Date.now();
      const depthMode: "fast" | "standard" | "thorough" = depth ?? "standard";
      const settings = DEPTH_SETTINGS[depthMode];

      try {
        // 1. Load company (need website + description for cache).
        const company = await client.getCompany(company_id);
        const websiteFromCompany = (company as Company & { website?: string | null }).website ?? null;
        const description = (company as Company & { description?: string | null }).description ?? null;
        const effectiveUrl = website_url ?? websiteFromCompany ?? null;

        if (!effectiveUrl) {
          return ok(buildNoWebsiteResult(company, depthMode, startedAt));
        }

        // 2. Cache check.
        const cached = readCachedIndustry(description);
        if (cached && cached.fresh && !force_refresh && !user_industry_hint) {
          return ok(
            buildCachedResult(company, cached, depthMode, startedAt, effectiveUrl),
          );
        }

        // 3. Fetch home page.
        const fetched = await fetchWithBudget(effectiveUrl, settings);
        if (!fetched.ok) {
          return ok(
            buildFetchFailedResult(
              company,
              effectiveUrl,
              fetched.error ?? "unknown",
              depthMode,
              startedAt,
            ),
          );
        }

        const parsed = parseHtml(fetched.body, effectiveUrl);
        const og = extractOgMeta(parsed);
        const spa = detectSpa(parsed);

        // 4. Ecommerce platform detection + fast-path catalog fetch.
        //    Many ecommerce sites (Shopify Hydrogen, Next.js Commerce, custom
        //    React shells) are SPAs at the HTML level but expose stable JSON
        //    APIs for their catalog. Detecting the platform and hitting that
        //    API is more reliable than scraping a JS-rendered home and gives
        //    full image arrays + prices + descriptions in one request.
        const platform = detectEcommercePlatform(fetched.headers, fetched.body);
        let platformProducts: ExtractedProduct[] = [];
        let platformError: string | null = null;
        if (platform) {
          try {
            platformProducts = await fetchPlatformCatalog(platform, effectiveUrl, {
              timeoutMs: settings.fetch_timeout_ms,
              maxItems: 30,
            });
          } catch (err) {
            platformError = err instanceof Error ? err.message : String(err);
          }
        }

        // 5. Sitemap probe. Cheap when the site has no sitemap (one 404),
        //    high-value when the home is SPA but product detail pages are
        //    SSR (Shopify Hydrogen, most VTEX themes). Only run as a rescue
        //    for SPA or thorough mode; standard mode with a non-SPA home
        //    skips this here and runs it again later if extractors fail.
        let sitemapResult: Awaited<ReturnType<typeof fetchProductsViaSitemap>> | null = null;
        const sitemapAttemptedEarly =
          platformProducts.length === 0 && (spa.requires_js_render || depthMode === "thorough");
        if (sitemapAttemptedEarly) {
          try {
            sitemapResult = await fetchProductsViaSitemap(effectiveUrl, {
              timeoutMs: settings.fetch_timeout_ms,
              maxProductFetches: spa.requires_js_render ? 8 : 4,
            });
          } catch {
            // best effort; do not surface
          }
        }

        // 6. SPA short-circuit ONLY if neither platform nor sitemap rescued
        //    us. With either of those, the JS-rendered home is irrelevant
        //    because we already have product data.
        if (
          spa.requires_js_render &&
          depthMode !== "thorough" &&
          platformProducts.length === 0 &&
          (sitemapResult?.products.length ?? 0) === 0
        ) {
          return ok(
            buildSpaShortCircuitResult(company, effectiveUrl, parsed, og, spa, depthMode, startedAt, {
              platform_detected: platform,
              platform_fast_path_error: platformError,
              sitemap_urls_found: sitemapResult?.sitemap_urls ?? [],
              sitemap_diagnostics: sitemapResult?.diagnostics ?? null,
            }),
          );
        }

        // 7. Classify.
        const classification = classifyWithHint(parsed, og, user_industry_hint);
        const profile = getProfile(classification.best.id);

        // 8. Run extractors on the home page.
        const { data: home_data, report } = runProfileExtractors(parsed, profile);

        // 8.5. Merge fast-path products (platform API + early sitemap rescue).
        //      Platform entries go first because they have the richest data
        //      (full image arrays, structured prices). CSS-extracted entries
        //      are kept only when their name does not duplicate a platform
        //      entry.
        const recoveredProducts: ExtractedProduct[] = [
          ...platformProducts,
          ...(sitemapResult?.products ?? []),
        ];
        if (recoveredProducts.length > 0) {
          const existing = ((home_data["products"] as unknown[]) ?? []) as ExtractedProduct[];
          const seen = new Set(recoveredProducts.map((p) => p.name.toLowerCase()));
          home_data["products"] = [
            ...recoveredProducts,
            ...existing.filter((p) => !seen.has(p.name.toLowerCase())),
          ];
          const recoveredImgs = recoveredProducts.flatMap((p) => p.image_urls).filter(Boolean);
          const existingImgs = (home_data["product_images"] as string[] | undefined) ?? [];
          home_data["product_images"] = Array.from(new Set([...recoveredImgs, ...existingImgs])).slice(0, 60);
          if (platformProducts.length > 0 && platform) {
            report.succeeded.push(`products:platform_api:${platform}`);
          }
          if ((sitemapResult?.products.length ?? 0) > 0) {
            report.succeeded.push("products:sitemap_fallback");
          }
        }
        if (platform && platformProducts.length === 0 && platformError) {
          report.failed.push({ name: `products:platform_api:${platform}`, reason: platformError });
        }

        // 9. Contact (always; profile-agnostic).
        const contact = extractContact(parsed);

        // 10. Extra page crawl in standard / thorough.
        const extraPages = await crawlExtraPages(profile, effectiveUrl, settings);
        for (const { parsed: extraParsed } of extraPages) {
          const { data: extraData, report: extraReport } = runProfileExtractors(extraParsed, profile);
          mergeData(home_data, extraData);
          report.succeeded.push(...extraReport.succeeded);
          report.failed.push(...extraReport.failed);
        }

        // 11. Async strategies (RSS for news_media).
        if (profile.id === "news_media" && og.rss_url) {
          try {
            const articles = await extractArticles(parsed, {
              rss_url: og.rss_url,
              selectors: profile.extractors.primary
                .filter((s) => s.field === "latest_articles" && s.strategy === "css_selector")
                .flatMap((s) => s.selectors ?? []),
              maxItems: 30,
            });
            home_data["latest_articles"] = articles;
            report.succeeded.push("latest_articles:rss_feed");
          } catch (err) {
            report.failed.push({ name: "latest_articles:rss_feed", reason: err instanceof Error ? err.message : String(err) });
          }
        }

        // 12. Late sitemap fallback for ecommerce industries when nothing
        //     else has produced products (and we did not run sitemap earlier
        //     under the SPA-rescue path).
        const isEcommerceProfile =
          profile.id === "ecommerce_fashion" || profile.id === "ecommerce_general";
        const productsAfterExtractors = ((home_data["products"] as unknown[] | undefined) ?? []).length;
        if (isEcommerceProfile && productsAfterExtractors === 0 && !sitemapAttemptedEarly) {
          try {
            const lateResult = await fetchProductsViaSitemap(effectiveUrl, {
              timeoutMs: settings.fetch_timeout_ms,
              maxProductFetches: 8,
            });
            if (lateResult.products.length > 0) {
              home_data["products"] = lateResult.products;
              const imgs = lateResult.products.flatMap((p) => p.image_urls).filter(Boolean);
              const existingImgs = (home_data["product_images"] as string[] | undefined) ?? [];
              home_data["product_images"] = Array.from(
                new Set([...imgs, ...existingImgs]),
              ).slice(0, 60);
              report.succeeded.push("products:sitemap_fallback");
              sitemapResult = lateResult;
            } else {
              report.failed.push({
                name: "products:sitemap_fallback",
                reason:
                  lateResult.sitemap_urls.length > 0
                    ? `sitemap had ${lateResult.sitemap_urls.length} candidate URLs but none yielded JSON-LD Product or og:image+title`
                    : "no product sitemap discovered",
              });
              sitemapResult = lateResult;
            }
          } catch (err) {
            report.failed.push({
              name: "products:sitemap_fallback",
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 12.5. Persist the industry cache to Company.description so that
        //       downstream planning tools (prepare_content_plan_context,
        //       draft_content_plan) can read cached_industry on subsequent
        //       calls without re-classifying or asking the agent to write
        //       it back manually. The MCP exposes no generic update_company
        //       tool to the agent on purpose (Company has many sensitive
        //       fields); leaving the cache persistence to the agent created
        //       a structural block where draft_content_plan refused to run
        //       because cached_industry was null and the agent had no tool
        //       to fix it. We do it here, where we know exactly the right
        //       suffix and we are already paying the deep_research cost.
        const suffix = buildCacheSuffix(profile.id);
        let cachePersisted: { ok: true } | { ok: false; reason: string };
        try {
          const newDescription = applyCacheSuffixToDescription(description, suffix);
          if (newDescription !== description) {
            await client.updateCompany(company_id, { description: newDescription });
          }
          cachePersisted = { ok: true };
        } catch (err) {
          cachePersisted = {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        // 13. Build response.
        const response = buildFullResult({
          company,
          effectiveUrl,
          parsed,
          og,
          contact,
          spa,
          classification,
          profile,
          data: home_data,
          report,
          depthMode,
          startedAt,
          extraPagesCount: extraPages.length,
          platform,
          sitemapDiagnostics: sitemapResult?.diagnostics ?? null,
          cachePersisted,
          llmFallbackHints:
            productsAfterExtractors === 0 &&
            isEcommerceProfile &&
            ((home_data["products"] as unknown[] | undefined) ?? []).length === 0
              ? {
                  platform_detected: platform,
                  sitemap_urls_to_try: sitemapResult?.sitemap_urls ?? [],
                  next_steps_for_agent:
                    "MCP no pudo extraer productos automáticamente. Tres opciones para el LLM: (1) WebFetch sobre algunos sitemap_urls_to_try y buscar og:image / JSON-LD Product manualmente; (2) pedir al usuario 2-3 URLs específicas de productos y re-llamar deep_research con website_url override apuntando a una de ellas; (3) seguir con generación AI sin reference_image_url y avisar al usuario explícitamente que los assets no van a parecerse al catálogo real.",
                }
              : null,
        });

        return ok(response);
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "classify_industry",
    {
      annotations: READ_ONLY,
      title: "Classify a website or a free-text sample into a Followr industry profile",
      description: `Light classification: scores 16 industry profiles plus a fallback against the input text. Returns the top candidates with matched keywords and a recommended pick with confidence level.

USE THIS when the agent wants to disambiguate a company's industry without paying the cost of a full deep_research crawl. Useful for:
- Asking the user "is your business X or Y?" with two top candidates.
- Pre-flight before deep_research to bias the user_industry_hint.

INPUT: provide EITHER website_url (the tool fetches the home page and reads text from it, with the same 10s/2MB budget as deep_research standard) OR text_sample (skip the fetch entirely and classify against the provided text).

OUTPUT: candidates[] sorted by score, recommended { id, confidence }, reasoning. Never throws; falls back to generic_business on any error.`,
      inputSchema: {
        website_url: z.string().url().optional(),
        text_sample: z.string().min(20).optional().describe("Plain text to classify. Use when website_url is not available or for cheap testing."),
      },
    },
    async ({ website_url, text_sample }) => {
      if (!website_url && !text_sample) {
        return toolError({
          reason: "missing_input",
          user_message: "Provide either website_url or text_sample to classify.",
        });
      }

      let textToClassify = text_sample ?? "";
      let fetchedFrom: string | null = null;
      let parsedOg: OgMetaResult | null = null;

      if (!textToClassify && website_url) {
        const fetched = await fetchWithBudget(website_url, DEPTH_SETTINGS.standard);
        if (!fetched.ok) {
          return ok({
            candidates: [],
            recommended: { id: "generic_business", confidence: "low" },
            reasoning: `Could not fetch ${website_url}: ${fetched.error ?? "unknown"}. Falling back to generic_business.`,
          });
        }
        fetchedFrom = website_url;
        const parsed = parseHtml(fetched.body, website_url);
        parsedOg = extractOgMeta(parsed);
        textToClassify = [
          parsedOg.title ?? "",
          parsedOg.description ?? "",
          parsedOg.og_description ?? "",
          bodyTextExcerpt(parsed, 4000),
        ]
          .filter(Boolean)
          .join("\n");
      }

      const outcome = classifyText(textToClassify);
      return ok({
        candidates: outcome.candidates.slice(0, 5),
        recommended: { id: outcome.best.id, confidence: outcome.confidence },
        reasoning: outcome.reasoning,
        fetched_from: fetchedFrom,
        ...(parsedOg ? { signals: { title: parsedOg.title, description: parsedOg.description, og_type: parsedOg.og_type } } : {}),
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────────
  // confirm_industry
  // ────────────────────────────────────────────────────────────────────────
  //
  // Persist the user's confirmed industry choice. Writes the `:confirmed`
  // flag onto the marker so prepare_content_plan_context and
  // draft_content_plan recognise the value as user-approved (not just
  // heuristic / deep_research auto-detected) and unblock the planning path.
  //
  // Typical flow:
  //   1. prepare_content_plan_context returns industry_setup_proposal or
  //      industry_confirmation_required.
  //   2. The agent calls deep_research (when no marker existed) or just
  //      reads the auto marker (when industry_confirmation_required fired).
  //   3. The agent presents the detected industry to the user along with
  //      the available_industries catalog and asks for confirmation /
  //      override.
  //   4. The agent calls confirm_industry({ company_id, industry_id })
  //      with the user's final pick.
  //
  // industry_id must be a valid IndustryId from the catalog. Free-text user
  // answers ("es Software B2C", "soy un consultor") need to be mapped by
  // the LLM to the closest entry before calling this tool. The tool itself
  // rejects unknown ids with a structured error.
  server.registerTool(
    "confirm_industry",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Persist the user's confirmed industry pick on Company.description",
      description: `Persists the user's confirmed industry pick on Company.description by writing the marker [industry:<id>@<date>:confirmed]. Required step between deep_research (auto-detection) and draft_content_plan (which now blocks until the marker carries the :confirmed flag).

USE THIS when:
- The user explicitly confirmed the industry detected by deep_research (e.g. "sí, es SaaS").
- The user overrode the auto-detection ("no, es restaurant"). Map the user's wording to the closest industry_id from the catalog (the available_industries array returned by prepare_content_plan_context lists every valid id).
- The agent gathered the industry directly from the user without running deep_research (e.g. the user volunteered the answer up-front).

The marker is idempotent: re-calling with a different industry_id replaces the previous value and updates the date. Use this for corrections too ("ah, en realidad somos B2B service, no SaaS").

DO NOT USE THIS to silently accept the auto-detection. The whole point of this gate is the user's explicit confirmation. If the user has not yet weighed in, present the detection to them first and wait for their answer.

VALIDATION: industry_id must be one of the catalog ids in lib/industry-profiles (saas, ecommerce_fashion, ecommerce_general, restaurant, service_b2b, education, real_estate, healthcare, creative_agency, local_business, personal_brand, news_media, hotel_hospitality, fitness_wellness, events_organizer, ngo_nonprofit, generic_business). Unknown ids return a structured error and the marker is left untouched.

WRITE: PUT /api/companies/{id} with description merged. Safe to call multiple times; same-day re-confirmations are no-ops.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        industry_id: z
          .string()
          .min(1)
          .describe(
            "The industry id the user confirmed. Must be one of the catalog ids in lib/industry-profiles. Map free-text user answers ('es Software B2C', 'soy consultor', 'tengo una panadería') to the closest catalog entry before calling.",
          ),
      },
    },
    async ({ company_id, industry_id }) => {
      try {
        if (!ALL_INDUSTRY_IDS.includes(industry_id as IndustryId)) {
          return toolError({
            reason: "unknown_industry_id",
            user_message: `"${industry_id}" no es una industria válida del catálogo de Followr. Las opciones son: ${ALL_INDUSTRY_IDS.filter((id) => id !== "generic_business").join(", ")}. Generic_business existe como fallback pero no es elegible para confirmación.`,
            blocking: true,
            details: { received: industry_id, available: ALL_INDUSTRY_IDS },
          });
        }
        if (industry_id === "generic_business") {
          return toolError({
            reason: "generic_business_not_confirmable",
            user_message:
              "generic_business es un fallback interno; no es una industria que el usuario pueda elegir como suya. Pedile al usuario una industria más específica del catálogo.",
            blocking: true,
          });
        }
        const company = await client.getCompany(company_id);
        const description = company.description ?? "";
        const suffix = buildCacheSuffix(industry_id as IndustryId, true);
        const newDescription = applyCacheSuffixToDescription(description, suffix);
        let contextsEvicted = 0;
        if (newDescription !== description) {
          await client.updateCompany(company_id, { description: newDescription });
          // Drop every cached content-plan context for this company: their
          // snapshot froze cached_industry as unconfirmed and draft_content_plan
          // would still reject with industry_confirmation_required despite the
          // marker now reading :confirmed. Without this eviction, agents have
          // to manually re-call prepare_content_plan_context to refresh.
          contextsEvicted = invalidateContextsForCompany(company_id);
        }
        const profile = getProfile(industry_id as IndustryId);

        // ── Refreshed planning policy (inlined, eliminates round-trip) ─────
        //
        // Pre 2026-05-26 flow: agent calls confirm_industry, then has to
        // re-call prepare_content_plan_context to get recommended_video_strategy
        // and avatar_setup_proposal recomputed with the confirmed industry.
        // That extra round-trip is the source of latency surfaced in the
        // PipeLime session.
        //
        // Now: we compute the industry-driven defaults inline and surface them
        // here. The agent does NOT need to re-call prepare_content_plan_context
        // unless something else in the brand context changed (a network was
        // connected, brand voice was added, etc.). Those are unrelated to the
        // industry marker and the agent already has them from the earlier
        // prepare_content_plan_context call that exposed industry_setup_proposal
        // in the first place.
        const recommendedVideoStrategy = {
          industry_id: profile.id,
          display_name: profile.display_name,
          default_video_kind: profile.video_strategy.default_video_kind,
          rationale_short: profile.video_strategy.rationale_short,
          flip_concepts: profile.video_strategy.flip_concepts,
          is_ambiguous: profile.video_strategy.is_ambiguous === true,
        };

        // Best-effort avatar inventory check. When the industry recommends
        // avatar as default video kind AND the company has zero avatars,
        // the planner cannot fulfill the recommendation. Surface the gap
        // upfront so the agent resolves it BEFORE phase_2 scope questions.
        let availableAvatarsCount: number | null = null;
        let needsAvatarProposal = false;
        if (
          recommendedVideoStrategy.default_video_kind === "ai_avatar_video" &&
          !recommendedVideoStrategy.is_ambiguous
        ) {
          try {
            const avatars = await client.listAvatars(company_id, { pageSize: 10 });
            availableAvatarsCount = avatars.length;
            needsAvatarProposal = availableAvatarsCount === 0;
          } catch {
            // Non-fatal: the agent can still re-call prepare_content_plan_context
            // if it needs a deterministic avatar count.
            availableAvatarsCount = null;
          }
        }

        const avatarSetupProposal = needsAvatarProposal
          ? {
              severity: "clarification_required_before_draft",
              user_message: `La industria ${profile.display_name} recomienda usar avatar talking-head como default de video, pero esta empresa todavía no tiene ningún avatar cargado. ¿Querés crear uno ahora (con create_avatar_full_flow, ~30-60s) o avanzar con AI clips sin avatar (más genérico para esta vertical)?`,
              resolution_options: [
                {
                  id: "create_avatar_now",
                  description:
                    "Llamá create_avatar_full_flow (genera avatar a partir de una foto o prompt + voice). Después seguí con phase_2.",
                  tool: "create_avatar_full_flow",
                },
                {
                  id: "proceed_with_ai_clips",
                  description:
                    "Saltea el avatar. El plan va a usar AI clips silenciosos / con audio nativo según el modelo. Para SaaS / B2B esto reduce conversión, pero es válido si el user no quiere invertir en avatar.",
                },
              ],
            }
          : null;

        return ok({
          ok: true,
          industry_id,
          display_name: profile.display_name,
          marker_written: suffix,
          marker_already_current: newDescription === description,
          user_facing_summary: `Listo, guardé la industria de la marca como ${profile.display_name}. Ahora puedo armar el plan ajustado a este tipo de negocio (recomendación de avatar vs AI clip, formatos preferidos, etc.).`,
          refreshed_planning_policy: {
            recommended_video_strategy: recommendedVideoStrategy,
            available_avatars_count: availableAvatarsCount,
            needs_avatar_proposal: needsAvatarProposal,
            avatar_setup_proposal: avatarSetupProposal,
          },
          _assistant_guidance: {
            next_step: needsAvatarProposal
              ? "resolve_avatar_setup_proposal_then_phase_2"
              : "phase_2_scope_questions",
            instructions: needsAvatarProposal
              ? `La industria confirmada recomienda avatar como default de video pero la empresa tiene 0 avatares. PRIMERO resolvé el avatar_setup_proposal arriba (mostrar al user, elegir create_avatar_now vs proceed_with_ai_clips), DESPUÉS pasá a phase_2 scope questions (window, frequency, theme, promo) y draft_content_plan. NO necesitás re-llamar prepare_content_plan_context: los industry-driven defaults que cambiaron al confirmar la industria ya están en refreshed_planning_policy de esta misma response. Solo re-llamá prepare_content_plan_context si algo NO relacionado a la industry cambió en la sesión (e.g. el user conectó una red social nueva o cargó una brand voice nueva).`
              : `Industria confirmada y los industry-driven defaults ya están en refreshed_planning_policy de esta misma response. NO necesitás re-llamar prepare_content_plan_context salvo que algo NO relacionado a la industry haya cambiado (e.g. el user conectó una red social nueva o cargó una brand voice nueva). Pasá directo a phase_2 scope questions (window, frequency, theme, promo) y después draft_content_plan.`,
          },
        });
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}

// ── Helpers for the full deep_research response shape ──────────────────────

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function classifyWithHint(parsed: ParsedHtml, og: OgMetaResult, hint: string | undefined): ClassificationOutcome {
  const textParts: string[] = [];
  if (hint) textParts.push(hint);
  if (og.title) textParts.push(og.title);
  if (og.description) textParts.push(og.description);
  if (og.og_description) textParts.push(og.og_description);
  textParts.push(bodyTextExcerpt(parsed, 6000));
  const combined = textParts.join("\n");
  return classifyText(combined);
}

async function crawlExtraPages(
  profile: IndustryProfile,
  baseUrl: string,
  settings: DepthSettings,
): Promise<{ url: string; parsed: ParsedHtml }[]> {
  if (settings.max_extra_paths === 0) return [];

  const paths = new Set<string>();
  for (const spec of profile.extractors.primary) {
    if (spec.paths_to_crawl) {
      for (const p of spec.paths_to_crawl) paths.add(p);
    }
  }

  const out: { url: string; parsed: ParsedHtml }[] = [];
  let count = 0;
  for (const path of paths) {
    if (count >= settings.max_extra_paths) break;
    let url: string;
    try {
      url = new URL(path, baseUrl).toString();
    } catch {
      continue;
    }
    if (url === baseUrl) continue;
    const fetched = await fetchWithBudget(url, settings);
    if (!fetched.ok) continue;
    const parsed = parseHtml(fetched.body, url);
    out.push({ url, parsed });
    count += 1;
  }
  return out;
}

function mergeData(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value];
    } else if (!existing) {
      target[key] = value;
    }
  }
}

function buildNoWebsiteResult(company: Company, depth: string, startedAt: number) {
  return {
    detected_industry: {
      id: "generic_business" as IndustryId,
      display_name: "Negocio genérico / sin clasificación específica",
      confidence: "low",
      reasoning: "No website is set on the company. Falling back to generic_business with thin sufficiency.",
      detection_method: "fallback",
    },
    common: {
      company_name: company.name,
      title: null,
      description: (company as Company & { description?: string | null }).description ?? null,
      language: null,
      logo_url: null,
      contact: { emails: [], phones: [], addresses: [] },
      social_links: [],
    },
    industry_specific: { industry: "generic_business" as IndustryId, data: {} },
    content_pillars_inferred: [],
    sufficiency: {
      score: "thin" as const,
      missing_for_high_quality_plan: ["website not set"],
      recommendations: [
        "ask the user for the company website URL and update Company.website via update_company",
        "if no website exists, ask the user to upload brand assets (logo, product photos) and to describe the business in Company.description",
      ],
    },
    meta: {
      pages_crawled: [],
      duration_ms: Date.now() - startedAt,
      extractors_succeeded: [],
      extractors_failed: [],
      parser_used: "none" as const,
      requires_js_render: false,
      depth,
    },
  };
}

function buildCachedResult(
  company: Company,
  cached: CachedIndustry,
  depth: string,
  startedAt: number,
  effectiveUrl: string,
) {
  const profile = getProfile(cached.id);
  return {
    detected_industry: {
      id: cached.id,
      display_name: profile.display_name,
      confidence: "high",
      reasoning: `Cached classification from ${cached.cached_at} (${cached.age_days} days old, within ${CACHE_TTL_DAYS}-day TTL). Pass force_refresh: true to reclassify.`,
      detection_method: "cached",
    },
    common: {
      company_name: company.name,
      title: null,
      description: (company as Company & { description?: string | null }).description ?? null,
      language: null,
      logo_url: null,
      contact: { emails: [], phones: [], addresses: [] },
      social_links: [],
    },
    industry_specific: { industry: cached.id, data: {} },
    content_pillars_inferred: inferContentPillars(profile, {}),
    sufficiency: {
      score: "partial" as const,
      missing_for_high_quality_plan: ["cached result returns only the industry id; call with force_refresh to repopulate data"],
      recommendations: ["call deep_research with force_refresh: true to re-fetch website data"],
    },
    meta: {
      pages_crawled: [],
      duration_ms: Date.now() - startedAt,
      extractors_succeeded: [],
      extractors_failed: [],
      parser_used: "cache" as const,
      requires_js_render: false,
      depth,
      effective_url: effectiveUrl,
    },
  };
}

function buildFetchFailedResult(
  company: Company,
  url: string,
  error: string,
  depth: string,
  startedAt: number,
) {
  return {
    detected_industry: {
      id: "generic_business" as IndustryId,
      display_name: "Negocio genérico / sin clasificación específica",
      confidence: "low",
      reasoning: `Could not fetch ${url}: ${error}. Falling back to generic_business.`,
      detection_method: "fallback",
    },
    common: {
      company_name: company.name,
      title: null,
      description: (company as Company & { description?: string | null }).description ?? null,
      language: null,
      logo_url: null,
      contact: { emails: [], phones: [], addresses: [] },
      social_links: [],
    },
    industry_specific: { industry: "generic_business" as IndustryId, data: {} },
    content_pillars_inferred: [],
    sufficiency: {
      score: "thin" as const,
      missing_for_high_quality_plan: ["website unreachable"],
      recommendations: [
        "verify the company website URL is correct",
        "ask the user to provide brand assets directly",
        "try fetching the company sitemap.xml or robots.txt manually with WebFetch; if either is reachable, the home block may be a UA/firewall issue that the LLM can route around",
      ],
    },
    hints_for_llm_fallback: {
      attempted_url: url,
      error,
      next_steps_for_agent:
        "MCP no pudo alcanzar la home page del sitio. Opciones: (1) WebFetch desde el LLM puede tener un UA distinto y atravesar el firewall; intentá fetchear directamente la home, el sitemap.xml o un product URL conocido; (2) pedir al usuario que verifique la URL en Company.website (typo, http vs https, dominio nuevo); (3) pedirle al usuario que pase 2-3 fotos de producto directamente al chat para subirlas con upload_images_from_urls.",
    },
    meta: {
      pages_crawled: [],
      duration_ms: Date.now() - startedAt,
      extractors_succeeded: [],
      extractors_failed: [{ name: "fetch", reason: error }],
      parser_used: "none" as const,
      requires_js_render: false,
      depth,
      effective_url: url,
    },
  };
}

interface SpaHints {
  platform_detected: EcommercePlatform | null;
  platform_fast_path_error: string | null;
  sitemap_urls_found: string[];
  sitemap_diagnostics: { fetched_count: number; extracted_count: number; sitemap_url: string | null } | null;
}

function buildSpaShortCircuitResult(
  company: Company,
  url: string,
  parsed: ParsedHtml,
  og: OgMetaResult,
  spa: SpaDetectionResult,
  depth: string,
  startedAt: number,
  hints: SpaHints,
) {
  const hasSitemapUrls = hints.sitemap_urls_found.length > 0;
  const nextSteps = hints.platform_detected
    ? `Site appears to be ${hints.platform_detected} but the catalog API did not return products${hints.platform_fast_path_error ? ` (error: ${hints.platform_fast_path_error})` : ""}. ${hasSitemapUrls ? `The sitemap exposes ${hints.sitemap_urls_found.length} product URLs (see sitemap_urls_to_try). WebFetch a few of them and look for JSON-LD Product or og:image to retrieve real catalog photos.` : "Ask the user for 2-3 product URLs directly; the deep_research tool accepts a website_url override that can point at a specific product page."}`
    : hasSitemapUrls
      ? `Home requires JS render, but the sitemap exposes ${hints.sitemap_urls_found.length} product-shaped URLs. WebFetch some of those URLs from sitemap_urls_to_try and read JSON-LD Product or og:image to retrieve catalog photos.`
      : "Home requires JS render and no usable sitemap was discovered. Ask the user for 2-3 product URLs directly, or for them to drop a few photos into the chat; upload_images_from_urls can ingest them into the asset library.";
  return {
    detected_industry: {
      id: "generic_business" as IndustryId,
      display_name: "Negocio genérico / sin clasificación específica",
      confidence: "low",
      reasoning: `${spa.reason}. The current depth (${depth}) does not include JS rendering; re-run with depth: thorough to invoke a deeper crawl.`,
      detection_method: "fallback",
    },
    common: {
      company_name: og.og_site_name ?? company.name,
      title: og.title,
      description: og.description ?? og.og_description,
      language: og.html_lang,
      logo_url: og.og_image ?? og.favicon,
      contact: { emails: [], phones: [], addresses: [] },
      social_links: [],
    },
    industry_specific: { industry: "generic_business" as IndustryId, data: { value_props: [og.og_description ?? og.description].filter(Boolean) as string[] } },
    content_pillars_inferred: [],
    sufficiency: {
      score: "thin" as const,
      missing_for_high_quality_plan: ["JS-rendered content not extracted, platform fast-path and sitemap fallback also did not yield products"],
      recommendations: [
        "re-run deep_research with depth: thorough",
        "follow hints_for_llm_fallback.next_steps_for_agent below to recover catalog imagery via WebFetch or user upload",
      ],
    },
    hints_for_llm_fallback: {
      platform_detected: hints.platform_detected,
      platform_fast_path_error: hints.platform_fast_path_error,
      sitemap_urls_to_try: hints.sitemap_urls_found,
      sitemap_diagnostics: hints.sitemap_diagnostics,
      og_image: og.og_image ?? null,
      next_steps_for_agent: nextSteps,
    },
    meta: {
      pages_crawled: [url],
      duration_ms: Date.now() - startedAt,
      extractors_succeeded: ["og_meta"],
      extractors_failed: [],
      parser_used: "html" as const,
      requires_js_render: true,
      depth,
      effective_url: url,
      spa_detection: spa,
    },
  };
}

interface BuildFullResultInput {
  company: Company;
  effectiveUrl: string;
  parsed: ParsedHtml;
  og: OgMetaResult;
  contact: ContactInfo;
  spa: SpaDetectionResult;
  classification: ClassificationOutcome;
  profile: IndustryProfile;
  data: Record<string, unknown>;
  report: ExtractorRunReport;
  depthMode: "fast" | "standard" | "thorough";
  startedAt: number;
  extraPagesCount: number;
  platform: EcommercePlatform | null;
  sitemapDiagnostics: { fetched_count: number; extracted_count: number; sitemap_url: string | null } | null;
  llmFallbackHints: {
    platform_detected: EcommercePlatform | null;
    sitemap_urls_to_try: string[];
    next_steps_for_agent: string;
  } | null;
  cachePersisted: { ok: true } | { ok: false; reason: string };
}

function buildFullResult(input: BuildFullResultInput) {
  const social = extractSocialLinks(input.parsed, [
    "a[href*='instagram.com']",
    "a[href*='facebook.com']",
    "a[href*='tiktok.com']",
    "a[href*='youtube.com']",
    "a[href*='linkedin.com']",
    "a[href*='twitter.com']",
    "a[href*='x.com']",
    "a[href*='threads.net']",
    "a[href*='pinterest.com']",
  ]);

  const ambiguous = input.classification.confidence === "ambiguous";

  return {
    detected_industry: {
      id: input.profile.id,
      display_name: input.profile.display_name,
      confidence: input.classification.confidence,
      reasoning: input.classification.reasoning,
      detection_method: "heuristic" as const,
      ...(ambiguous
        ? {
            candidates: input.classification.candidates.slice(0, 3),
            signals_for_classification: {
              title: input.og.title,
              description: input.og.description ?? input.og.og_description,
              body_excerpt: bodyTextExcerpt(input.parsed, 2000),
              og_type: input.og.og_type,
              social_links_types: Array.from(new Set(social.map((s) => s.type))),
            },
          }
        : {}),
    },
    common: {
      company_name: input.og.og_site_name ?? input.company.name,
      title: input.og.title,
      description: input.og.description ?? input.og.og_description,
      language: input.og.html_lang,
      logo_url: input.og.og_image ?? input.og.favicon,
      contact: { emails: input.contact.emails, phones: input.contact.phones, addresses: [] },
      social_links: social,
    },
    industry_specific: { industry: input.profile.id, data: input.data } as IndustrySpecificData,
    content_pillars_inferred: inferContentPillars(input.profile, input.data),
    sufficiency: scoreSufficiency(input.profile, input.data, input.report),
    ...(input.llmFallbackHints
      ? {
          hints_for_llm_fallback: input.llmFallbackHints,
        }
      : {}),
    meta: {
      pages_crawled: [input.effectiveUrl],
      duration_ms: Date.now() - input.startedAt,
      extractors_succeeded: input.report.succeeded,
      extractors_failed: input.report.failed,
      parser_used: "html" as const,
      requires_js_render: input.spa.requires_js_render,
      depth: input.depthMode,
      effective_url: input.effectiveUrl,
      extra_pages_crawled: input.extraPagesCount,
      platform_detected: input.platform,
      sitemap_diagnostics: input.sitemapDiagnostics,
    },
    cache_suggestion: {
      field: "description",
      suffix_to_append: buildCacheSuffix(input.profile.id),
      note: input.cachePersisted.ok
        ? "Already applied. deep_research wrote this suffix to Company.description so prepare_content_plan_context / draft_content_plan will read cached_industry on the next call without further action from the agent. The suffix is shown here for transparency only."
        : `deep_research attempted to persist this suffix to Company.description and FAILED (${input.cachePersisted.reason}). The next planning call will re-run deep_research instead of reading the cache. Consider retrying deep_research with force_refresh: false to attempt the persistence again, or surface the failure to the user.`,
      persisted: input.cachePersisted.ok,
      persistence_error: input.cachePersisted.ok ? null : input.cachePersisted.reason,
    },
  };
}
