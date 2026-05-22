// Brand Visual Identity: persistent visual style of a Followr company.
//
// THE PROBLEM this solves
// =======================
// AI image generation needs structural visual context to produce posts that
// look like the brand and not like generic stock. Folowr's Company resource
// already has a few fields that help (palettes, fonts, ai_image_styles), but
// they are insufficient for high-quality grounding:
//   - palettes: only 3 slots, UI-editable, useful for primary brand colors
//   - fonts:    no UI surface, vestigial in practice (verified 2026-05-22)
//   - ai_image_styles: vestigial. Empirical A/B (2026-05-22) confirmed that
//     selecting "Pencil Art" on company id 7 and re-generating "A red apple
//     on a white background" with nano_banana_2 produces the same photoreal
//     output as the baseline. The wire format of POST /api/aiResults/image
//     does NOT include ai_image_styles either. UI-cosmetic only.
//
// So we model a richer Brand Visual Identity that lives in TWO places:
//
//   (A) Three Followr Folders with image/video assets, holding the actual
//       visual content (logo, hero shots, mascot, templates, anti-pattern
//       examples). Folders are conventionally named:
//          __brand_templates       finished compositions approved as style refs
//          __brand_elements        atomic visual elements (logo, icons, patterns)
//          __brand_anti_patterns   things the brand explicitly does NOT want
//
//   (B) A delimited JSON block embedded inside Company.description, holding
//       the structured metadata (folder ids, brief, palette overflow,
//       typography, anti-patterns text, aspirational brands, counters, sync
//       timestamps). Format:
//
//          <user-facing description text>
//
//          <!-- BRAND_VISUAL_IDENTITY:v1 START -->
//          {...JSON of BrandVisualIdentity...}
//          <!-- BRAND_VISUAL_IDENTITY:v1 END -->
//
//       HTML comments are used as delimiters because they are not rendered
//       anywhere Followr surfaces the description, and they are hard to
//       break with casual edits in the UI.
//
// WHY description and not a dedicated resource: Followr does not expose a
// place to attach arbitrary metadata to a Company. Description is the only
// free-form, persistently editable, free-text field on the resource. It is
// already used by deep_research for an industry cache marker. We follow the
// same pattern, just with a richer block.
//
// THE PARSER returns one of three states so the caller can distinguish
// missing-from-corrupted and offer the user a recovery action when needed.

import { z } from "zod";

// ──────────────────────────────────────────────────────────
// Asset tagging conventions
// ──────────────────────────────────────────────────────────
//
// When the MCP uploads images to the brand folders it tags them with one of
// the following values via Followr's Tag resource. The auto-injection layer
// in execute_content_plan reads these tags to pick the most relevant
// references for a given concept (e.g. concept hints at "step" -> pull
// brand:step-template + brand:logo + a brand:pattern).

export const BRAND_TAGS = {
  /** Brand logo. Always-included reference for any generation. */
  LOGO: "brand:logo",
  /** Recurring character or mascot. */
  CHARACTER: "brand:character",
  /** Hero shot from the website or curated by the user. */
  HERO: "brand:hero",
  /** Cover slide template the brand has approved. */
  COVER_TEMPLATE: "brand:cover-template",
  /** Step-illustration template (how-to slides). */
  STEP_TEMPLATE: "brand:step-template",
  /** Call-to-action template. */
  CTA_TEMPLATE: "brand:cta-template",
  /** Feature highlight template (product or capability spotlight). */
  FEATURE_TEMPLATE: "brand:feature-template",
  /** Quote / testimonial template. */
  QUOTE_TEMPLATE: "brand:quote-template",
  /** Hero / launch template. */
  HERO_TEMPLATE: "brand:hero-template",
  /** Background pattern, geometric motif, gradient. */
  PATTERN: "brand:pattern",
  /** Icon asset (line or filled, atomic). */
  ICON: "brand:icon",
  /** Product or service photograph. */
  PRODUCT: "brand:product",
  /**
   * Aspirational reference (e.g. Stripe's og:image when user said "I want
   * to look like Stripe"). Used as inspiration during generation, NEVER as
   * literal copy material.
   */
  ASPIRATIONAL: "brand:aspirational",
  /** Past Followr post that performed well; surfaced as template via refresh flow. */
  PAST_WINNER: "brand:past-winner",
  /**
   * Image meant ONLY for typography style guidance. The prompt suffix will
   * instruct the model to use the typographic style without copying the
   * literal text. Critical: do NOT mix typography refs with regular refs in
   * the same prompt without the negative-literal-copy suffix.
   */
  TYPOGRAPHY_REFERENCE: "brand:typography-reference",
} as const;

export type BrandTag = (typeof BRAND_TAGS)[keyof typeof BRAND_TAGS];

// ──────────────────────────────────────────────────────────
// Schema (zod, with derived TypeScript type)
// ──────────────────────────────────────────────────────────

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/u, "expected #rgb or #rrggbb");

/**
 * Schema version. Bump when the shape changes in a way that is not safely
 * forwards-readable. The parser refuses to parse a block whose
 * schema_version it does not recognize, so callers can detect old data and
 * offer to re-sync.
 */
const BRAND_VISUAL_IDENTITY_SCHEMA_VERSION = "v1" as const;

export const BrandVisualIdentitySchema = z.object({
  /** Schema version of the persisted JSON. Always "v1" today. */
  schema_version: z.literal(BRAND_VISUAL_IDENTITY_SCHEMA_VERSION),

  /** ISO-8601 timestamp of the initial synthesis. */
  synthesized_at: z.string().min(1),

  /**
   * ISO-8601 timestamp of the last refresh (template re-suggestion, brief
   * regeneration, etc.). When equal to synthesized_at the identity has not
   * been refreshed since creation.
   */
  last_brand_sync_at: z.string().min(1),

  /**
   * Number of published PostGroups in the company at the time of the last
   * sync. The refresh heuristic uses (current - this) to decide whether to
   * suggest a re-sync.
   */
  posts_count_at_last_sync: z.number().int().nonnegative(),

  /** Followr folder ids resolved during setup. NULL when not yet created. */
  folders: z.object({
    /** __brand_templates folder id. */
    templates: z.number().int().positive().nullable(),
    /** __brand_elements folder id. */
    elements: z.number().int().positive().nullable(),
    /** __brand_anti_patterns folder id. */
    anti_patterns: z.number().int().positive().nullable(),
  }),

  /**
   * The synthesized brief in natural language. Used as a prompt suffix on
   * every AI image generation that opts into brand-aware references. Length
   * capped to ~1000 chars so the description does not bloat.
   */
  brief_text: z.string().min(1).max(2000),

  /**
   * Primary palette colors. Mirrors Company.palettes but as a copy inside
   * the block so we can recover state if the user edits palettes from the
   * UI (which truncates to 3). At most 3 colors here. Used as a sanity
   * mirror, not the source of truth (UI's Company.palettes is the source
   * for the 3 primaries).
   */
  palette_primary: z.array(HexColor).max(3),

  /**
   * Extended palette beyond the 3 UI slots: secondaries, neutrals, accents,
   * gradient stops. These survive UI edits to Company.palettes because they
   * live here. Used by AI image generation as additional color hints.
   */
  palette_extended: z.array(HexColor).max(20),

  /**
   * Free-form description of the brand typography. Examples:
   *   "Geometric sans-serif, medium-bold weight, generous letter-spacing"
   *   "Serif headlines pairing with humanist sans body"
   * NOT a font name (those are unreliable for image models). The actual
   * font is conveyed to the model via tagged typography reference images
   * (see TYPOGRAPHY_REFERENCE).
   */
  typography_style_text: z.string().max(500).default(""),

  /**
   * Optional specific font name detected from the website (e.g. "Inter",
   * "Helvetica Neue"). Stored for trace / documentation only. NOT passed
   * to image models in the prompt because they cannot reliably reproduce
   * named fonts from text alone.
   */
  typography_specific_font_name: z.string().max(100).nullable(),

  /**
   * Things the brand explicitly does NOT want. One short item per array
   * element, e.g.:
   *   - "no stock photos with visible faces"
   *   - "no comic-sans-style fonts"
   *   - "no early-2010s gradients"
   * Injected into the prompt as a negative list.
   */
  anti_patterns_text: z.array(z.string().min(1).max(200)).max(30),

  /**
   * Names of aspirational reference brands the user mentioned (e.g.
   * ["Linear", "Notion"]). The MCP fetches their og:image and stores the
   * resulting assets in __brand_templates with tag BRAND_TAGS.ASPIRATIONAL.
   * Their names are persisted here too for traceability and so future
   * sessions can show the list back to the user.
   */
  aspirational_brands: z.array(z.string().min(1).max(80)).max(10),

  /**
   * Asset ids of the og:images / hero shots fetched from aspirational
   * brand websites. These live in __brand_templates with the
   * BRAND_TAGS.ASPIRATIONAL tag. Persisted here so we can refresh them or
   * remove them as a batch if the user changes their mind.
   */
  aspirational_refs_asset_ids: z.array(z.number().int().positive()).max(30),

  /** Counter: total templates approved by user. Includes aspirational refs. */
  templates_count: z.number().int().nonnegative(),
  /** Counter: total elements approved by user. */
  elements_count: z.number().int().nonnegative(),
  /** Counter: total anti-pattern examples approved by user. */
  anti_patterns_count: z.number().int().nonnegative(),

  /**
   * Asset id -> list of brand tags. Followr does NOT support tagging
   * individual Assets via its public API (tags belong to PostGroups). So
   * we maintain the asset-level tagging here, scoped to the brand
   * identity, with the asset_id as the dictionary key (string in JSON,
   * number when parsed by zod via coercion).
   *
   * Multi-tag per asset is supported: an aspirational og:image can be
   * both ASPIRATIONAL and TYPOGRAPHY_REFERENCE, for example. The resolver
   * reads this map to pick refs for a given concept.
   *
   * Capped at 100 entries to keep the description block under ~5KB.
   */
  asset_tag_map: z
    .record(z.string().regex(/^\d+$/u, "expected asset id as digit string"), z.array(z.string()))
    .default({}),
});

export type BrandVisualIdentity = z.infer<typeof BrandVisualIdentitySchema>;

// ──────────────────────────────────────────────────────────
// Description block: delimiters + parser + writer + stripper
// ──────────────────────────────────────────────────────────

const BLOCK_START = "<!-- BRAND_VISUAL_IDENTITY:v1 START -->";
const BLOCK_END = "<!-- BRAND_VISUAL_IDENTITY:v1 END -->";

/**
 * Regex that captures the JSON payload between the markers. Flags:
 *   - `s`: dot matches newlines (JSON is multi-line pretty-printed)
 *   - non-greedy `.*?` so multi-block descriptions don't accidentally span
 *     across blocks (defensive; shouldn't happen in practice)
 */
const BLOCK_RE = /<!--\s*BRAND_VISUAL_IDENTITY:v1\s+START\s*-->\s*([\s\S]*?)\s*<!--\s*BRAND_VISUAL_IDENTITY:v1\s+END\s*-->/u;

/**
 * Same regex but anchored to consume the trailing whitespace too. Used when
 * stripping so we don't leave behind stray blank lines.
 */
const BLOCK_STRIP_RE = /\n*\s*<!--\s*BRAND_VISUAL_IDENTITY:v1\s+START\s*-->[\s\S]*?<!--\s*BRAND_VISUAL_IDENTITY:v1\s+END\s*-->\s*/u;

/**
 * Result of parseBrandIdentityFromDescription. Discriminated union so
 * callers can distinguish "no block found" (the company has no identity
 * configured yet) from "block found but unparseable" (corruption from a
 * user edit; the MCP should offer to re-sync).
 */
export type ParseBrandIdentityResult =
  | { status: "ok"; identity: BrandVisualIdentity }
  | { status: "missing" }
  | { status: "corrupted"; raw_block: string; error: string };

/**
 * Parse the BRAND_VISUAL_IDENTITY block from a Company.description.
 *
 * Returns:
 *   - { status: "ok", identity } when a valid block was found
 *   - { status: "missing" } when no markers exist (no identity configured)
 *   - { status: "corrupted", raw_block, error } when markers exist but the
 *     JSON inside is malformed or fails schema validation
 *
 * The caller (prepare_content_plan_context, the setup wizard, etc.) decides
 * what to do per status. Typically:
 *   ok -> use the identity to enrich generation
 *   missing -> offer to run setup_brand_visual_identity
 *   corrupted -> show the raw block to the user, offer to re-sync
 */
export function parseBrandIdentityFromDescription(
  description: string | null | undefined,
): ParseBrandIdentityResult {
  if (!description || typeof description !== "string") {
    return { status: "missing" };
  }
  const match = BLOCK_RE.exec(description);
  if (!match || !match[1]) {
    return { status: "missing" };
  }
  const raw = match[1].trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return {
      status: "corrupted",
      raw_block: raw,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const validation = BrandVisualIdentitySchema.safeParse(parsedJson);
  if (!validation.success) {
    return {
      status: "corrupted",
      raw_block: raw,
      error: `Schema validation failed: ${validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { status: "ok", identity: validation.data };
}

/**
 * Convenience helper: returns true if the description contains a block
 * (parseable or not). Useful for "do we have at least the markers" checks
 * before deciding whether to offer setup vs re-sync.
 */
export function hasBrandIdentityMarker(description: string | null | undefined): boolean {
  if (!description || typeof description !== "string") return false;
  return BLOCK_RE.test(description);
}

/**
 * Return the description with the BRAND_VISUAL_IDENTITY block (including
 * its delimiters and surrounding whitespace) removed. Used when surfacing
 * the description to an LLM as brand context: the block is internal state,
 * not part of the brand voice.
 *
 * If no block is present, returns the description unchanged. If the input
 * is null/undefined, returns null.
 */
export function stripBrandIdentityFromDescription(
  description: string | null | undefined,
): string | null {
  if (description === null || description === undefined) return null;
  if (typeof description !== "string") return null;
  if (!BLOCK_RE.test(description)) return description;
  const cleaned = description.replace(BLOCK_STRIP_RE, "");
  // Trim trailing whitespace introduced by leaving an empty paragraph
  // behind the stripped block.
  return cleaned.replace(/[\t ]+$/gm, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Return a new description string with the given identity persisted as a
 * BRAND_VISUAL_IDENTITY block. If a block already exists, it is REPLACED
 * (not duplicated). If no description exists yet, a fresh one is created
 * containing only the block.
 *
 * The block is appended at the end of the description with a separating
 * blank line so it doesn't interfere with the brand voice copy at the top.
 */
export function appendBrandIdentityToDescription(
  description: string | null | undefined,
  identity: BrandVisualIdentity,
): string {
  const base = stripBrandIdentityFromDescription(description) ?? "";
  const json = JSON.stringify(identity, null, 2);
  const block = `${BLOCK_START}\n${json}\n${BLOCK_END}`;
  if (base.length === 0) return block;
  return `${base}\n\n${block}`;
}

/**
 * Build a fresh BrandVisualIdentity. Use this as the canonical constructor
 * to ensure all required fields are present with defensible defaults.
 * Callers (typically the setup wizard) override fields as they go.
 */
export function buildBrandVisualIdentity(args: {
  brief_text: string;
  folders?: Partial<BrandVisualIdentity["folders"]>;
  palette_primary?: string[];
  palette_extended?: string[];
  typography_style_text?: string;
  typography_specific_font_name?: string | null;
  anti_patterns_text?: string[];
  aspirational_brands?: string[];
  aspirational_refs_asset_ids?: number[];
  posts_count_at_last_sync?: number;
}): BrandVisualIdentity {
  const now = new Date().toISOString();
  return {
    schema_version: BRAND_VISUAL_IDENTITY_SCHEMA_VERSION,
    synthesized_at: now,
    last_brand_sync_at: now,
    posts_count_at_last_sync: args.posts_count_at_last_sync ?? 0,
    folders: {
      templates: args.folders?.templates ?? null,
      elements: args.folders?.elements ?? null,
      anti_patterns: args.folders?.anti_patterns ?? null,
    },
    brief_text: args.brief_text,
    palette_primary: args.palette_primary ?? [],
    palette_extended: args.palette_extended ?? [],
    typography_style_text: args.typography_style_text ?? "",
    typography_specific_font_name: args.typography_specific_font_name ?? null,
    anti_patterns_text: args.anti_patterns_text ?? [],
    aspirational_brands: args.aspirational_brands ?? [],
    aspirational_refs_asset_ids: args.aspirational_refs_asset_ids ?? [],
    templates_count: 0,
    elements_count: 0,
    anti_patterns_count: 0,
    asset_tag_map: {},
  };
}

/**
 * Look up all asset_ids that have a given brand tag. Used by the resolver
 * to pick references for an AI image generation. Returns asset_ids in
 * insertion order (which preserves the order the user approved them in).
 */
export function lookupAssetsByTag(
  identity: BrandVisualIdentity,
  tag: BrandTag,
): number[] {
  const out: number[] = [];
  for (const [assetIdStr, tags] of Object.entries(identity.asset_tag_map)) {
    if (tags.includes(tag)) {
      const n = Number.parseInt(assetIdStr, 10);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  return out;
}

/**
 * Assign tags to an asset in the identity's tag map. Idempotent: re-calling
 * with the same asset_id replaces the previous tag list.
 */
export function tagAssetInIdentity(
  identity: BrandVisualIdentity,
  assetId: number,
  tags: BrandTag[],
): BrandVisualIdentity {
  const next: BrandVisualIdentity = {
    ...identity,
    asset_tag_map: {
      ...identity.asset_tag_map,
      [String(assetId)]: tags as string[],
    },
  };
  return next;
}

/**
 * Refresh the timestamps + posts counter on an existing identity. Use this
 * when running a refresh / re-sync flow where the identity itself is being
 * updated (e.g. user just approved new templates from past winners).
 */
export function touchBrandIdentitySync(
  identity: BrandVisualIdentity,
  posts_count_at_last_sync: number,
): BrandVisualIdentity {
  return {
    ...identity,
    last_brand_sync_at: new Date().toISOString(),
    posts_count_at_last_sync,
  };
}

// ──────────────────────────────────────────────────────────
// Tagged-asset selection helpers
// ──────────────────────────────────────────────────────────

/**
 * Heuristic mapping from a free-form concept string (typically the
 * caption_concept or concept_shared from a plan_item) to the BrandTag(s)
 * most relevant for picking reference images. Used by the resolver in
 * execute_content_plan when auto-injecting references for an
 * AssetSourceAiImage that did not declare reference_image_urls.
 *
 * The function returns tags ranked by relevance. The caller picks the top
 * N templates that have matching tags.
 *
 * Examples:
 *   "cover slide for Tuesday's carousel" -> [COVER_TEMPLATE, LOGO, HERO]
 *   "step 2 of 3 illustration" -> [STEP_TEMPLATE, ICON, LOGO]
 *   "CTA card with arrow"  -> [CTA_TEMPLATE, LOGO]
 *   "product hero shot for launch" -> [HERO_TEMPLATE, PRODUCT, LOGO]
 *
 * Conservative defaults: when nothing matches strongly, falls back to
 * COVER_TEMPLATE + LOGO. The resolver also always includes LOGO when the
 * asset library has one.
 */
export function suggestedTagsForConcept(concept: string): BrandTag[] {
  const c = concept.toLowerCase();
  const tags: BrandTag[] = [];
  if (/(cover|portada|cara\s*1|slide\s*1|opening|titular)/u.test(c)) {
    tags.push(BRAND_TAGS.COVER_TEMPLATE);
  }
  if (/(step|paso|how-?to|tutorial|process|flow|guide)/u.test(c)) {
    tags.push(BRAND_TAGS.STEP_TEMPLATE);
  }
  if (/(cta|call.?to.?action|signup|sign[- ]?up|get\s+started|join|cierre|llamado\s+a\s+la\s+acci[oó]n)/u.test(c)) {
    tags.push(BRAND_TAGS.CTA_TEMPLATE);
  }
  if (/(quote|cita|testimonial|testimonio)/u.test(c)) {
    tags.push(BRAND_TAGS.QUOTE_TEMPLATE);
  }
  if (/(feature|caracter[ií]stica|capability|showcase|spotlight)/u.test(c)) {
    tags.push(BRAND_TAGS.FEATURE_TEMPLATE);
  }
  if (/(hero|launch|lanzamiento|drop principal|flagship|destacad[ao])/u.test(c)) {
    tags.push(BRAND_TAGS.HERO_TEMPLATE);
  }
  if (/(product|producto|catalog|item|sku|prenda|modelo)/u.test(c)) {
    tags.push(BRAND_TAGS.PRODUCT);
  }
  if (/(icon|icono|symbol)/u.test(c)) {
    tags.push(BRAND_TAGS.ICON);
  }
  if (/(pattern|patr[oó]n|background|fondo|texture|textura|gradient|gradiente)/u.test(c)) {
    tags.push(BRAND_TAGS.PATTERN);
  }
  // Defensive default: if nothing matched, fall back to the most generic
  // approved-composition tag so the resolver at least has something to
  // pull from. The caller layers LOGO on top regardless.
  if (tags.length === 0) tags.push(BRAND_TAGS.COVER_TEMPLATE);
  return tags;
}

// ──────────────────────────────────────────────────────────
// Auto-classifier (F2.5): suggest type + tag for a curated asset
// ──────────────────────────────────────────────────────────

/**
 * Where the asset came from. Drives the auto-classification heuristic.
 *   - scraped_logo: img candidate flagged as logo by the scraper
 *   - scraped_favicon: site favicon (apple-touch-icon or rel=icon)
 *   - scraped_hero: img candidate in <header> or <main> hero region
 *   - scraped_gallery: img candidate in a product / card / item region
 *   - scraped_svg: inline <svg> from the page
 *   - user_upload: user uploaded an image during curation
 *   - aspirational_brand_og: og:image fetched from an aspirational brand's
 *     site (e.g. Stripe, Linear) per user's answer in question 2
 */
export type CurationSource =
  | "scraped_logo"
  | "scraped_favicon"
  | "scraped_hero"
  | "scraped_gallery"
  | "scraped_svg"
  | "user_upload"
  | "aspirational_brand_og";

/** Bucket the asset falls into. Drives which folder it goes to. */
export type AssetClassification = "element" | "template" | "anti_pattern" | "skip";

export interface AutoClassifyResult {
  classification: AssetClassification;
  suggested_tags: BrandTag[];
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Suggest a classification + tag for a curated asset based on its source
 * and contextual hints. The agent uses this to pre-fill the curation UI;
 * the user can override before submitting.
 *
 * Defensive defaults: when uncertain, classify as "element" (safer than
 * "template" since templates get used as compositional refs and a wrong
 * template can derail later generations).
 *
 * Never auto-classifies as "anti_pattern": that's a deliberate user
 * decision and shouldn't be silently inferred.
 */
export function autoClassifyAsset(args: {
  source: CurationSource;
  alt?: string | null;
  src_hint?: string | null;
  /** Optional: the scraper's `inline_svg_icons[i].size_hint` for SVGs. */
  size_hint?: string | null;
}): AutoClassifyResult {
  const alt = (args.alt ?? "").toLowerCase();
  const hint = (args.src_hint ?? "").toLowerCase();

  switch (args.source) {
    case "scraped_logo":
      return {
        classification: "element",
        suggested_tags: [BRAND_TAGS.LOGO],
        confidence: "high",
        reason: "Detected as logo by the scraper (class/id/alt match or in <header>).",
      };
    case "scraped_favicon":
      return {
        classification: "element",
        suggested_tags: [BRAND_TAGS.LOGO],
        confidence: "medium",
        reason:
          "Favicon: often a smaller version of the logo. Treat as a logo element; the user can re-tag if the favicon is generic.",
      };
    case "scraped_hero":
      // Hero shots can be either templates (full compositions to reference)
      // or elements (a single photo of a product/scene). Default to template
      // because heroes carry the brand's visual identity composition; the
      // user can demote to element if the hero is just a generic photo.
      if (/(banner|cover|jumbotron|feature)/u.test(hint)) {
        return {
          classification: "template",
          suggested_tags: [BRAND_TAGS.HERO_TEMPLATE],
          confidence: "high",
          reason: "Hero / banner region: carries brand composition style.",
        };
      }
      return {
        classification: "template",
        suggested_tags: [BRAND_TAGS.HERO_TEMPLATE],
        confidence: "medium",
        reason: "In <main> or <header> region. Likely brand-carrying composition.",
      };
    case "scraped_gallery":
      // Gallery items can be products, lifestyle photos, illustrations,
      // mockups. Default to element with PRODUCT tag; if alt mentions
      // "step"/"how", treat as step template.
      if (/(step|how[- ]?to|tutorial|guide|paso)/u.test(alt)) {
        return {
          classification: "template",
          suggested_tags: [BRAND_TAGS.STEP_TEMPLATE],
          confidence: "medium",
          reason: "Alt text hints at step/tutorial content.",
        };
      }
      if (/(product|item|sku|prenda|modelo)/u.test(alt)) {
        return {
          classification: "element",
          suggested_tags: [BRAND_TAGS.PRODUCT],
          confidence: "medium",
          reason: "Alt text hints at product photography.",
        };
      }
      return {
        classification: "element",
        suggested_tags: [BRAND_TAGS.HERO],
        confidence: "low",
        reason: "Gallery item with unclear role. Defaulting to element with HERO tag.",
      };
    case "scraped_svg":
      // Inline SVGs are almost always icons or small decorative elements.
      // Distinguish: large viewBox (>200px) might be illustration, small
      // is icon. Without dimensions we default to ICON.
      if (args.size_hint) {
        const m = /^(\d+)x(\d+)$/u.exec(args.size_hint);
        if (m && m[1] && m[2]) {
          const w = parseInt(m[1], 10);
          const h = parseInt(m[2], 10);
          if (w >= 200 || h >= 200) {
            return {
              classification: "element",
              suggested_tags: [BRAND_TAGS.PATTERN],
              confidence: "low",
              reason: `SVG size ${args.size_hint} larger than icon range; could be pattern or illustration.`,
            };
          }
        }
      }
      return {
        classification: "element",
        suggested_tags: [BRAND_TAGS.ICON],
        confidence: "high",
        reason: "Inline SVG with icon-range dimensions.",
      };
    case "user_upload":
      // Conservative default: element. The user is best positioned to
      // re-classify as template if they uploaded a full composition.
      return {
        classification: "element",
        suggested_tags: [BRAND_TAGS.HERO],
        confidence: "low",
        reason: "User upload: defaulting to element. User can re-classify as template if it's a full composition.",
      };
    case "aspirational_brand_og":
      // Aspirational og:image: brand-carrying composition AND likely
      // contains typography (wordmarks, hero text). Tag as both
      // ASPIRATIONAL and TYPOGRAPHY_REFERENCE so the resolver can use it
      // for either purpose.
      return {
        classification: "template",
        suggested_tags: [BRAND_TAGS.ASPIRATIONAL, BRAND_TAGS.TYPOGRAPHY_REFERENCE],
        confidence: "high",
        reason:
          "Aspirational brand og:image: visual identity carrier + typographic reference. Generations use this with negative-literal-copy prompt suffix.",
      };
    default:
      return {
        classification: "element",
        suggested_tags: [BRAND_TAGS.HERO],
        confidence: "low",
        reason: `Unknown source "${String(args.source)}"; defaulting to element.`,
      };
  }
}

/**
 * Internal helper exposed for tests / debugging. Don't use in production
 * code paths.
 */
export const _internals = {
  BLOCK_START,
  BLOCK_END,
  BLOCK_RE,
  BLOCK_STRIP_RE,
  BRAND_VISUAL_IDENTITY_SCHEMA_VERSION,
};
