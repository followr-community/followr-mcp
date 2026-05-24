// MCP tools for the Brand Visual Identity workflow.
//
// SHAPE (mirrors content-plan: assess -> draft -> execute)
//
//   assess_brand_visual_identity   READ_ONLY  inspect company state, scrape
//                                             website, recommend next step,
//                                             surface pre-warning and the
//                                             4 cold-start questions
//
//   (draft + execute tools land in subsequent batches: F2.4 onwards)
//
// The assess tool is the entry point. The agent calls it first to discover
// whether the company already has a Brand Visual Identity configured, and
// what raw signals the system can offer the user during setup (scraped
// website assets, candidate palette, candidate fonts, existing Followr
// assets, past performance).
//
// The output includes a structured `_assistant_guidance` block telling the
// agent exactly what to do next, including the pre-warning text and the 4
// questions to ask in the cold-start. The agent surfaces those to the user,
// collects answers, and feeds them back through `draft_brand_visual_identity`
// when that tool lands.

import type { FollowrClient } from "@followr-mcp/shared";
import type { AiPreferences, Asset, Company, Folder, PostGroup } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION, MUTATION_IDEMPOTENT, READ_ONLY } from "../lib/annotations.js";
import {
  BRAND_TAGS,
  type BrandFolderIntent,
  type BrandIdentityDrift,
  type BrandSetupStatus,
  type BrandTag,
  type BrandVisualIdentity,
  appendBrandIdentityToDescription,
  autoClassifyAsset,
  buildBrandVisualIdentity,
  computeSetupStatus,
  hasBrandIdentityMarker,
  parseBrandIdentityFromDescription,
  pickBrandReferenceAssetIds,
  reconcileBrandIdentityState,
  resolveBrandTag,
  stripBrandIdentityFromDescription,
  tagAssetInIdentity,
} from "../lib/brand-identity.js";
import { sanitizeImageModelPref } from "../lib/content-plan-catalog.js";
import { resolveDriver } from "../lib/driver-resolver.js";
import {
  type ProposedAction,
  type ProposedActionKind,
  createDraft,
  getDraft,
  updateDraft,
} from "../lib/brand-identity-state.js";
import { scrapeBrandSignalsFromWebsite } from "../lib/brand-website-scraper.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";
import { uploadFromData, uploadFromUrl } from "./assets.js";

// Conventional folder names for the brand identity system. Detection is
// case-insensitive and accepts both with and without the double-underscore
// prefix (we add the prefix when creating; the user might rename without it).
const BRAND_FOLDER_NAMES = {
  templates: ["__brand_templates", "brand_templates", "brand templates", "templates"],
  elements: ["__brand_elements", "brand_elements", "brand elements", "elements"],
  anti_patterns: [
    "__brand_anti_patterns",
    "brand_anti_patterns",
    "brand anti patterns",
    "anti_patterns",
    "anti-patterns",
  ],
};

// Phase 1 = template manufacturing. The constants here drive both the cost
// estimate surfaced before/during the call (assess_brand_visual_identity,
// draft_brand_visual_identity, execute_brand_visual_identity) AND the schema
// defaults of manufacture_brand_templates. Single source of truth prevents
// drift like the prior 13/325 vs actual 12/300 mismatch where the estimate
// quoted one number and the tool charged another.
//
// templates_per_category(2) × categories.length(6) = 12 templates.
// nano_banana_2 = 25 cr / image. The actual cost at execute time reads from
// perImageCostFor(resolvedModel) so this is a planning estimate only.
const PHASE_1_DEFAULT_TEMPLATES_PER_CATEGORY = 2;
const PHASE_1_DEFAULT_CATEGORIES_COUNT = 6;
const PHASE_1_TEMPLATE_COUNT =
  PHASE_1_DEFAULT_TEMPLATES_PER_CATEGORY * PHASE_1_DEFAULT_CATEGORIES_COUNT;
const PHASE_1_COST_PER_IMAGE_CR = 25;
const PHASE_1_ESTIMATE_CR = PHASE_1_TEMPLATE_COUNT * PHASE_1_COST_PER_IMAGE_CR;

// ──────────────────────────────────────────────────────────
// The 4 cold-start questions (industry-aware examples populated dynamically)
// ──────────────────────────────────────────────────────────

interface ColdStartQuestion {
  id: "visual_style" | "aspirational_brands" | "curation_uploads" | "anti_patterns";
  prompt_for_user: string;
  examples: string[];
  /** Hint to the agent on how to ingest the answer when it arrives. */
  answer_format: string;
}

function buildColdStartQuestions(industry: string | null): ColdStartQuestion[] {
  return [
    {
      id: "visual_style",
      prompt_for_user:
        "En 1 oración, ¿cómo se siente tu marca visualmente? Pensá en colores, estilo, sensación.",
      examples: [
        "colores cálidos tipo atardecer en el desierto",
        "blanco y negro con detalles dorados",
        "caótico, neón, estética Y2K",
        "minimalista con muchos espacios en blanco",
        "fotos de gente real, sin filtros, candid",
        "ilustraciones planas en pastel",
      ],
      answer_format: "free-form string, 5-200 chars",
    },
    {
      id: "aspirational_brands",
      prompt_for_user:
        "¿Hay marcas que admirás visualmente y querrías que tu marca se inspire en su estética? Si no, decí 'paso'.",
      examples: aspirationalExamplesForIndustry(industry),
      answer_format: "array of brand names (0-5), or 'paso' / 'skip'",
    },
    {
      id: "curation_uploads",
      prompt_for_user:
        "Te muestro las imágenes que encontré en tu sitio y elementos detectados. Marcá las que sí representan tu marca. También podés subir 1-5 imágenes propias (logo en alta, foto que te encante, post viejo que rindió).",
      examples: [],
      answer_format:
        "structured: { approved_scrape_ids: number[], uploaded_image_urls: string[], skipped_scrape_ids: number[] }",
    },
    {
      id: "anti_patterns",
      prompt_for_user:
        "¿Hay algo visualmente que NO querés ver nunca en tus posts?",
      examples: [
        "no fotos de gente con caras visibles",
        "no comic sans ni fuentes infantiles",
        "no gradientes pastel tipo años 2010",
        "no 3D renders",
        "no stock photos genéricas",
        "no logos de competencia",
      ],
      answer_format: "array of short strings, 0-10 items",
    },
  ];
}

function aspirationalExamplesForIndustry(industry: string | null): string[] {
  const globals = ["Apple", "Nike", "Stripe", "Glossier", "Patagonia"];
  if (!industry) return globals;
  const lower = industry.toLowerCase();
  if (/saas|b2b|tech|software|startup/u.test(lower)) {
    return ["Linear", "Notion", "Vercel", "Figma", "Stripe", "Loom"];
  }
  if (/fashion|retail|ropa|indumentaria|apparel/u.test(lower)) {
    return ["Aritzia", "Glossier", "Stüssy", "Zara", "Uniqlo", "Acne Studios"];
  }
  if (/food|restaurant|bar|cafe|gastrono|cocina/u.test(lower)) {
    return ["Sweetgreen", "Blue Bottle", "Chipotle", "Shake Shack"];
  }
  if (/beauty|skincare|cosmetic|belleza/u.test(lower)) {
    return ["Drunk Elephant", "The Ordinary", "Glossier", "Aesop"];
  }
  if (/fitness|gym|wellness|deporte/u.test(lower)) {
    return ["Equinox", "Peloton", "Lululemon", "Nike", "Strava"];
  }
  if (/hospitality|hotel|travel|turismo/u.test(lower)) {
    return ["Airbnb", "Hoxton Hotels", "Soho House", "Marriott"];
  }
  if (/agency|creative|design|estudio/u.test(lower)) {
    return ["Pentagram", "Linear", "Buck", "Frog Design"];
  }
  return globals;
}

// ──────────────────────────────────────────────────────────
// Tool registration
// ──────────────────────────────────────────────────────────

export function registerBrandIdentityTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "assess_brand_visual_identity",
    {
      annotations: READ_ONLY,
      title: "Inspect a company's Brand Visual Identity state and collect setup signals",
      description: `READ-ONLY assessment of a company's Brand Visual Identity. Returns the current state (configured / missing / corrupted), candidate signals from the company's website (logo, hero, palette, fonts via shallow scrape), existing brand folders if any, current Followr asset library size, recent best-performing posts, the ai_image_and_video_budget, and an estimated cost for Phase 1 template manufacturing.

USE THIS FIRST whenever the user asks to "set up brand identity", "configure brand visuals", "I want my posts to look like my brand", or similar. It is also the first step of the refresh / resync flow (output is the same shape; \`next_step\` differs).

NO MUTATION. Safe to call repeatedly. Caches nothing on the server side; the website is re-fetched each time you call.

OUTPUT shape:
- current_state: company name, language, palettes, ai_image_styles, fonts, existing identity block, detected brand folders, stripped (user-facing) description
- website_signals: scraped page metadata + image candidates + palette + fonts + inline SVG icons
- library_signals: asset counts + top performing recent posts (with their asset URLs)
- budget_signals: ai_image_and_video_remaining + Phase 1 cost estimate
- _assistant_guidance: next_step ("cold_start" | "refresh" | "all_set"), pre_warning_text (verbatim user-facing copy), cold_start_questions (the 4 questions to ask, industry-aware examples), recommended_curation_strategy

USER FLOW the agent should follow when next_step === "cold_start":
1. Surface pre_warning_text verbatim, ask for explicit confirmation to proceed.
2. If low_visual_signal.detected is true, surface low_visual_signal.message_for_user BEFORE asking the 4 cold_start_questions. This is a soft block: invite the user to upload 1-3 product / team / hero images now (logo in high resolution, screenshot of the product in use, team photo, post that performed well). If the user uploads, pick them up to feed into curation later as source=user_upload (image_data when attached to the chat, url when already public). If the user says "avanzá igual" or "no tengo", proceed but warn that the first draft may need a refresh once you can attach real product visuals.
3. If user agrees: ask the 4 cold_start_questions one at a time or in 2-3 batches (preview question 3 with the scraped thumbnails inline if your transport supports it).
4. Collect answers + curation choices.
5. Call draft_brand_visual_identity with the collected answers (lands in F2 batch 2; not exposed yet, surface a stub state until then).

USER FLOW when next_step === "refresh":
1. Surface the current identity summary + how many posts have been published since last sync.
2. Ask the user whether they want to refresh templates from past winners, re-scrape the website, or full re-setup.
3. Call the appropriate refresh action (lands in F5).

USER FLOW when next_step === "all_set":
1. Surface "tu identidad visual está cargada y al día" + summary of folders + last_brand_sync_at.
2. Offer manual actions (add template, add element, refresh from posts) but do not push the user.`,
      inputSchema: {
        company_id: z
          .number()
          .int()
          .positive()
          .describe("The Followr company id to assess."),
        skip_website_scrape: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, skip the website scrape (faster but loses og:image / palette / fonts / heroes). Use only when the user explicitly said the website is irrelevant or unreachable.",
          ),
        skip_library_scan: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, skip the existing-assets and best-performing-posts pulls (faster). Useful when only checking the configured-state and budget. Library data is the main signal for refresh; only skip on cold-start probes.",
          ),
      },
    },
    async ({ company_id, skip_website_scrape, skip_library_scan }) => {
      try {
        // 1. Load Company. Required to even start.
        let company: Company;
        try {
          company = await client.getCompany(company_id);
        } catch (err) {
          return toolErrorFromException(err);
        }

        // 2. Parse the existing brand identity block, if any.
        const parsed = parseBrandIdentityFromDescription(company.description ?? null);
        const userFacingDescription =
          stripBrandIdentityFromDescription(company.description ?? null) ?? "";

        // 3. Fan out the remaining read-only lookups in parallel.
        const [foldersR, websiteR, assetsR, postsR, budgetsR] = await Promise.allSettled([
          client.listFolders(company_id, { pageSize: 100 }),
          skip_website_scrape
            ? Promise.resolve(null)
            : scrapeBrandSignalsFromWebsite(
                (company as Company & { website?: string }).website ?? null,
              ),
          skip_library_scan
            ? Promise.resolve([] as Asset[])
            : client.listAssets(company_id, { pageSize: 30, include: "thumbnail" }),
          skip_library_scan
            ? Promise.resolve([] as PostGroup[])
            : pullBestPerformingPosts(client, company_id),
          loadBudgetsTolerant(client),
        ]);

        const folders =
          foldersR.status === "fulfilled" ? foldersR.value : ([] as Folder[]);
        const websiteSignals =
          websiteR.status === "fulfilled" ? websiteR.value : null;
        const recentAssets =
          assetsR.status === "fulfilled" ? assetsR.value : ([] as Asset[]);
        const bestPosts =
          postsR.status === "fulfilled" ? postsR.value : ([] as PostGroup[]);
        const budgets = budgetsR.status === "fulfilled" ? budgetsR.value : null;

        // 4. Reconcile the persisted brand identity against live folder /
        //    asset state when configured. This corrects drift from manual UI
        //    edits, failed uploads during execute, or external folder
        //    deletions. Persists the corrected JSON via updateCompany if
        //    drift is detected. Skipped on skip_library_scan because that
        //    mode is for fast cold-start probes where drift correction is
        //    not urgent.
        let reconciledIdentity: BrandVisualIdentity | null =
          parsed.status === "ok" ? parsed.identity : null;
        let drift: BrandIdentityDrift | null = null;
        let driftPersisted = false;
        if (parsed.status === "ok" && !skip_library_scan) {
          try {
            const result = await reconcileBrandIdentityState(
              client,
              company_id,
              company.description ?? null,
              parsed.identity,
            );
            reconciledIdentity = result.reconciled;
            drift = result.drift;
            driftPersisted = result.persisted;
          } catch {
            // Tolerant: if reconcile throws, fall back to the parsed
            // identity so the assess still returns a useful response.
          }
        }

        // 5. Detect existing brand folders. Prefer the folder ids stored
        //    in the (reconciled) identity block, since those are
        //    authoritative once setup has run. Fall back to conventional
        //    name lookup for cold-start companies and for the legacy case
        //    where someone renamed a folder in the UI.
        const resolveDetectedFolder = (intent: BrandFolderIntent): Folder | null => {
          const storedId = reconciledIdentity?.folders[intent] ?? null;
          if (storedId !== null) {
            const byId = folders.find((f) => f.id === storedId);
            if (byId) return byId;
          }
          return findFolderByConventionalName(folders, BRAND_FOLDER_NAMES[intent]);
        };
        const detectedFolders = {
          templates: resolveDetectedFolder("templates"),
          elements: resolveDetectedFolder("elements"),
          anti_patterns: resolveDetectedFolder("anti_patterns"),
        };

        // 6. Derive setup status from the reconciled identity. "broken"
        //    means setup completed but no visual assets landed (e.g.
        //    folders created, uploads failed) and downstream tools cannot
        //    rely on the brand block for generation grounding.
        const setupStatus: BrandSetupStatus | null =
          reconciledIdentity !== null ? computeSetupStatus(reconciledIdentity) : null;

        // 7. Compute next_step. Broken setups route to "refresh" with an
        //    explicit repair flag so the agent surfaces "your setup is
        //    empty, let's redo the uploads" copy rather than the standard
        //    refresh-by-staleness copy.
        const hasBlock = hasBrandIdentityMarker(company.description ?? null);
        const blockStatus: "configured" | "missing" | "corrupted" =
          parsed.status === "ok"
            ? "configured"
            : hasBlock
              ? "corrupted"
              : "missing";

        let nextStep: "cold_start" | "refresh" | "all_set";
        let repairNeeded = false;
        if (blockStatus === "missing") nextStep = "cold_start";
        else if (blockStatus === "corrupted") nextStep = "cold_start";
        else if (setupStatus === "broken") {
          nextStep = "refresh";
          repairNeeded = true;
        } else {
          const daysSince = reconciledIdentity
            ? daysBetween(reconciledIdentity.last_brand_sync_at, new Date().toISOString())
            : 0;
          const publishedCount = await countPublishedSafe(client, company_id);
          const postsDelta =
            publishedCount - (reconciledIdentity?.posts_count_at_last_sync ?? 0);
          nextStep =
            (daysSince >= 30 && postsDelta >= 10) || postsDelta >= 20
              ? "refresh"
              : "all_set";
        }

        // 7b. Manufacture recommendation: surfaced when elements have
        //     changed materially since the last manufacture, so the AI
        //     synthetic templates can be regenerated to incorporate them.
        //     Strictly a hint, never blocks the response. Suppressed if
        //     manufacture has never run (the user has not opted into AI
        //     templates yet, so re-running manufacture is not a "refresh"
        //     concept for them).
        let manufactureRecommended: {
          recommended: boolean;
          reason: string;
          last_manufacture_at: string | null;
          elements_drift_signal: number;
        } | null = null;
        if (reconciledIdentity !== null) {
          const driftAddedToElements =
            drift?.elements_count_change !== undefined
              ? Math.max(
                  0,
                  drift.elements_count_change.after - drift.elements_count_change.before,
                )
              : 0;
          const lastManufactureAt = reconciledIdentity.last_manufacture_at;
          if (
            lastManufactureAt !== null &&
            driftAddedToElements >= 3 &&
            reconciledIdentity.elements_count > 0
          ) {
            manufactureRecommended = {
              recommended: true,
              reason: `Detecté ${driftAddedToElements} element${driftAddedToElements === 1 ? "" : "s"} nuevo${driftAddedToElements === 1 ? "" : "s"} desde el último manufacture (${lastManufactureAt}). Los templates AI sintetizados de entonces no los incorporan. Re-invocar manufacture_brand_templates regeneraría usando los elements actuales (~${PHASE_1_ESTIMATE_CR} créditos).`,
              last_manufacture_at: lastManufactureAt,
              elements_drift_signal: driftAddedToElements,
            };
          } else {
            manufactureRecommended = {
              recommended: false,
              reason:
                lastManufactureAt === null
                  ? "Manufacture nunca corrió en esta company. Los templates actuales (si los hay) son uploads directos, no AI synthesis."
                  : `Sin cambios materiales en elements desde el último manufacture (${lastManufactureAt}).`,
              last_manufacture_at: lastManufactureAt,
              elements_drift_signal: driftAddedToElements,
            };
          }
        }

        // 6. Build budget signal.
        const aiImageVideoRemaining =
          budgets?.ai_image_and_video_budget?.remaining ?? null;
        const canAffordPhase1 =
          aiImageVideoRemaining !== null && aiImageVideoRemaining >= PHASE_1_ESTIMATE_CR;

        // 7. Build pre-warning text.
        const preWarning = buildPreWarningText({
          companyName: company.name,
          nextStep,
          phaseEstimate: PHASE_1_ESTIMATE_CR,
          phaseImageCount: PHASE_1_TEMPLATE_COUNT,
          aiImageVideoRemaining,
          canAfford: canAffordPhase1,
          hasWebsite: !!(company as Company & { website?: string }).website,
          aiImageStylesCount:
            (
              (company as Company & { ai_image_styles?: unknown[] }).ai_image_styles ?? []
            ).length,
        });

        // 8. Build cold-start questions, industry-aware.
        const industry = detectIndustryFromDescription(userFacingDescription);
        const questions = buildColdStartQuestions(industry);

        // 8b. Low-visual-signal detection. If the website scrape returned
        //     basically nothing usable (minimal landing à la Linear / Vercel
        //     / Stripe, dashboard SPA with a marketing wrapper, etc), the
        //     draft is going to mis-orient because we are synthesizing from
        //     only the landing's first viewport. Real failure mode: a
        //     dark-first SaaS app received a "light canvas first" draft
        //     because the landing was light and no in-product screenshots
        //     were available. The agent should explicitly invite the user
        //     to upload 1-3 product / team / hero assets BEFORE answering
        //     the 4 cold-start questions.
        const websiteWasScraped = websiteSignals !== null;
        const logoCount = websiteSignals?.logo_candidates.length ?? 0;
        const heroCount = websiteSignals?.hero_candidates.length ?? 0;
        const galleryCount = websiteSignals?.gallery_candidates.length ?? 0;
        const paletteCount = websiteSignals?.palette_candidates.length ?? 0;
        const lowVisualSignal =
          websiteWasScraped &&
          (websiteSignals?.fetch_status ?? "no_url") === "ok" &&
          logoCount <= 1 &&
          heroCount === 0 &&
          galleryCount === 0 &&
          paletteCount <= 3;
        const lowVisualSignalMessage = lowVisualSignal
          ? `Tu sitio es muy minimalista visualmente. Pude leer la landing pero no encontré screenshots del producto en uso, fotos del equipo, ni una galería. Si arranco a armar la identidad solo con eso, el primer draft suele salir mal orientado (ej. asume canvas blanco cuando el producto real es dark mode, o subestima el color de marca). Antes de las 4 preguntas, te recomiendo subir 1-3 assets propios: logo en alta, screenshot del producto / dashboard funcionando, foto del equipo o un post anterior que te haya gustado. Si no tenés nada a mano, avanzamos solo con la landing y refinamos después una vez que persistas el bloque base.`
          : null;

        // 9. Assemble response.
        const response = {
          company_id: company.id,
          company_name: company.name,
          current_state: {
            brand_identity_status: blockStatus,
            corruption_detail:
              parsed.status === "corrupted" ? parsed.error : null,
            existing_identity:
              reconciledIdentity !== null
                ? {
                    synthesized_at: reconciledIdentity.synthesized_at,
                    last_brand_sync_at: reconciledIdentity.last_brand_sync_at,
                    last_manufacture_at: reconciledIdentity.last_manufacture_at,
                    brief_text: reconciledIdentity.brief_text,
                    templates_count: reconciledIdentity.templates_count,
                    elements_count: reconciledIdentity.elements_count,
                    anti_patterns_count: reconciledIdentity.anti_patterns_count,
                    aspirational_brands: reconciledIdentity.aspirational_brands,
                    palette_extended: reconciledIdentity.palette_extended,
                    typography_style_text: reconciledIdentity.typography_style_text,
                    setup_status: setupStatus,
                  }
                : null,
            drift_repaired:
              drift !== null
                ? {
                    persisted: driftPersisted,
                    templates_count_change: drift.templates_count_change ?? null,
                    elements_count_change: drift.elements_count_change ?? null,
                    anti_patterns_count_change:
                      drift.anti_patterns_count_change ?? null,
                    folder_lost: drift.folder_lost ?? [],
                    added_asset_ids: drift.added_asset_ids,
                    removed_asset_ids: drift.removed_asset_ids,
                  }
                : null,
            manufacture_recommended: manufactureRecommended,
            detected_brand_folders: {
              templates: detectedFolders.templates
                ? { id: detectedFolders.templates.id, name: detectedFolders.templates.name }
                : null,
              elements: detectedFolders.elements
                ? { id: detectedFolders.elements.id, name: detectedFolders.elements.name }
                : null,
              anti_patterns: detectedFolders.anti_patterns
                ? {
                    id: detectedFolders.anti_patterns.id,
                    name: detectedFolders.anti_patterns.name,
                  }
                : null,
            },
            current_palettes:
              (company as Company & { palettes?: string[] }).palettes ?? [],
            current_ai_image_styles:
              (company as Company & { ai_image_styles?: unknown[] }).ai_image_styles ??
              [],
            current_fonts_field:
              (company as Company & { fonts?: unknown }).fonts ?? null,
            current_tones: (company as Company & { tones?: unknown }).tones ?? null,
            current_audience_types:
              (company as Company & { audience_types?: string[] }).audience_types ?? null,
            current_language:
              (company as Company & { language?: string }).language ?? null,
            company_description_user_facing: userFacingDescription,
            website_url:
              (company as Company & { website?: string }).website ?? null,
            ai_preferences:
              (company as Company & { ai_preferences?: AiPreferences | null })
                .ai_preferences ?? null,
          },
          website_signals: websiteSignals,
          library_signals: {
            recent_asset_count_sampled: recentAssets.length,
            recent_asset_sample: recentAssets.slice(0, 10).map((a) => ({
              id: a.id,
              type: a.type,
              name: (a as Asset & { original_name?: string }).original_name ?? a.name ?? null,
            })),
            best_performing_posts_recent: bestPosts.slice(0, 10).map((p) => ({
              id: p.id,
              title: (p as PostGroup & { title?: string }).title ?? null,
              topic: (p as PostGroup & { topic?: string }).topic ?? null,
              published_at:
                (p as PostGroup & { published_at?: string }).published_at ?? null,
            })),
          },
          budget_signals: {
            ai_image_and_video_remaining: aiImageVideoRemaining,
            phase_1_template_count: PHASE_1_TEMPLATE_COUNT,
            phase_1_cost_per_image_estimate_cr: PHASE_1_COST_PER_IMAGE_CR,
            phase_1_total_cost_estimate_cr: PHASE_1_ESTIMATE_CR,
            can_afford_phase_1: canAffordPhase1,
            insufficient_budget_message: canAffordPhase1
              ? null
              : `Necesitás ${PHASE_1_ESTIMATE_CR} créditos de ai_image_and_video_budget para Phase 1, te quedan ${aiImageVideoRemaining ?? "(no se pudo leer)"}. Podés saltar Phase 1 (el setup persiste igual con folders vacíos) o conseguir más créditos antes de avanzar.`,
          },
          low_visual_signal: {
            detected: lowVisualSignal,
            logo_candidates_count: logoCount,
            hero_candidates_count: heroCount,
            gallery_candidates_count: galleryCount,
            palette_candidates_count: paletteCount,
            message_for_user: lowVisualSignalMessage,
          },
          _assistant_guidance: {
            next_step: nextStep,
            repair_needed: repairNeeded,
            pre_warning_text: preWarning,
            cold_start_questions: questions,
            recommended_curation_strategy:
              nextStep === "cold_start"
                ? "Después de las preguntas 1, 2 y 4 (textuales), presentale al usuario los thumbnails de website_signals para curación de pregunta 3. Mostrale: logo_candidates (top 3), hero_candidates (top 5), gallery_candidates (top 10), inline_svg_icons (top 8), favicon. Por cada uno, ofrecele clasificar como [ELEMENTO / TEMPLATE / ANTI-PATTERN / SKIP]. Auto-clasificación sugerida en cada candidato: logos -> ELEMENTO, heroes -> TEMPLATE, gallery -> ELEMENTO o TEMPLATE según concepto, SVGs -> ELEMENTO. El usuario solo corrige las que disienten. NO subas nada todavía: la curación viaja al draft_brand_visual_identity en el próximo turno."
                : repairNeeded
                  ? "BROKEN SETUP detectado: existing_identity.setup_status === 'broken' (los 3 counts están en 0). Las folders existen pero quedaron vacías, típicamente porque execute_brand_visual_identity creó los folders pero los uploads fallaron, o porque alguien borró todos los assets manualmente. Surface al usuario: 'Tu Brand Identity tiene el brief cargado pero las 3 folders están vacías. ¿Re-corrémos el setup completo (cold start de nuevo) o intentás subir los assets manualmente y volvemos a chequear?' NO ejecutes nada sin confirmación explícita."
                  : nextStep === "refresh"
                    ? "Mostrale al usuario el resumen del identity existente (existing_identity) + cuántos posts publicó desde el último sync. Preguntale: (a) refresh de templates pulling top performers de los últimos 90 días, (b) re-scrape del website, (c) full re-setup (cold start de nuevo). Las 3 opciones son tools distintos (lands en F5)."
                    : "Mostrale el resumen del identity existente. No empujes refresh a menos que el usuario lo pida explícitamente. Si manufacture_recommended.recommended es true, mencionale el hint pero NO ejecutes manufacture sin aprobación explícita de costo.",
            instructions_for_pre_warning:
              "Surface pre_warning_text al usuario VERBATIM (incluyendo el desglose de costos + el aviso del ai_image_styles si aplica). Espera 'sí' / 'dale' / 'avanza' EXPLICITO antes de hacer cualquier mutación.",
            instructions_for_low_visual_signal: lowVisualSignal
              ? "BLOQUEANTE BLANDO: antes de avanzar a las 4 preguntas, surfá low_visual_signal.message_for_user al usuario y pedile activamente 1-3 assets propios (logo en alta, screenshot del producto en uso, foto del equipo, post anterior que rindió). Si el usuario los pasa, los recibís ahora y los vas a usar en curation con source=user_upload (image_data si vienen como adjunto del chat, url si ya están públicos en alguna parte). Si el usuario dice 'no tengo' o 'avanzá igual', registralo y seguí con las 4 preguntas armando la identidad solo con la landing, pero advertí que el primer draft puede salir mal orientado y vamos a refinar después."
              : "El sitio tiene suficientes señales visuales (logos, heros, paletas o galería). No hace falta pedir assets adicionales al usuario antes de las 4 preguntas; podés ofrecerle subir extras como opción, no como bloqueante.",
            instructions_for_questions:
              "Hacé las 4 preguntas conversacionalmente, en español (o el idioma del usuario). Las preguntas 1, 2, 4 son textuales; la 3 requiere mostrar thumbnails. NO inventes ejemplos: usá los provided en cada pregunta. Si el usuario dice 'paso' en pregunta 2 (aspirational), respetá y sigue. Si dice 'no tengo nada para subir' en pregunta 3, sigue con solo lo curado del scrape.",
            persist_target_after_user_approval:
              "Después de las 4 respuestas + aprobación final, los datos viajan a draft_brand_visual_identity (F2 batch 2, no expuesto todavía en esta versión). Por ahora mostrale al usuario que tenés todo recolectado y avisale que el wizard de persistencia + template manufacturing está en desarrollo.",
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // draft_brand_visual_identity (F2.4)
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "draft_brand_visual_identity",
    {
      annotations: MUTATION_IDEMPOTENT,
      title: "Synthesize a Brand Visual Identity from user answers + curated assets (in-memory draft)",
      description: `Take the 4 cold-start answers + curated asset list (output of the agent's flow following assess_brand_visual_identity) and synthesize a Brand Visual Identity proposal that the user can preview before execute commits anything to Followr.

WHAT THIS TOOL DOES:
1. Loads the Company resource to ground the synthesis (description, palette, audience, tones, language).
2. Calls Followr's text AI (generate_chat) to synthesize a 200-700 word brand visual brief, grounded in the user's visual_style answer + aspirational brands + anti-patterns + the user-approved scrape signals. Costs ai_text_budget words (small, typically <500 words).
3. For each aspirational brand the user named, fetches the brand's website og:image (best-effort, no credits, no Followr mutations).
4. Builds the BrandVisualIdentity object (folder ids remain null at draft time; filled at execute) + the list of mutations that execute_brand_visual_identity will perform.
5. Persists the draft in MCP server memory for up to 24h with a draft_id.
6. Returns the proposed_identity + proposed_actions + a markdown preview for the user.

WHAT THIS TOOL DOES NOT DO:
- Does NOT create folders.
- Does NOT upload anything to Followr.
- Does NOT modify the Company.description.
- Does NOT generate AI images. (Phase 1 template manufacturing lives in a separate tool.)

PRECONDITION: The agent has already called assess_brand_visual_identity, surfaced the pre-warning, gotten the user to confirm, asked the 4 questions and curated the scraped/uploaded assets.

INPUT FORMAT:
- company_id: the same company id used in assess.
- user_answers: { visual_style (q1), aspirational_brands (q2), anti_patterns (q4) }. Pregunta 3 (curation) viaja en curation.items.
- curation.items: array of one entry per asset to keep. Each has source + url|svg_content|aspirational_brand_name + classification (the user's decision) + optional tag_override.
- language_override: optional. Defaults to company.language for the brief synthesis.
- clear_ai_image_styles: optional. When true, execute will PUT { ai_image_styles: [] } to neutralize the vestigial field. Recommended when the company currently has styles set, because the user might find the persistent UI indicator confusing.

OUTPUT: { draft_id, proposed_identity, proposed_actions, preview_markdown, synthesis_words, synthesis_ai_result_id, aspirational_fetch_results, expires_at_iso }.

NEXT STEP: surface preview_markdown to the user verbatim, ask for explicit approval, then call execute_brand_visual_identity(draft_id, confirm: true).`,
      inputSchema: {
        company_id: z.number().int().positive(),
        user_answers: z.object({
          visual_style: z
            .string()
            .min(3)
            .max(500)
            .describe("Q1 answer: 1-sentence description of the brand visual feel."),
          aspirational_brands: z
            .array(
              z.union([
                z.string().min(1).max(80),
                z.object({
                  name: z.string().min(1).max(80),
                  url: z.string().url().optional(),
                }),
              ]),
            )
            .max(5)
            .default([])
            .describe(
              "Q2 answer: array of aspirational brand names. Each can be a bare string or {name, url}; if url is omitted the tool heuristically guesses (lowercase + .com / .app).",
            ),
          anti_patterns: z
            .array(z.string().min(1).max(200))
            .max(10)
            .default([])
            .describe("Q4 answer: short list of visual anti-patterns."),
        }),
        curation: z.object({
          items: z
            .array(
              z.object({
                source: z.enum([
                  "scraped_logo",
                  "scraped_favicon",
                  "scraped_hero",
                  "scraped_gallery",
                  "scraped_svg",
                  "user_upload",
                  "aspirational_brand_og",
                ]),
                url: z.string().url().optional(),
                image_data: z
                  .string()
                  .min(64)
                  .optional()
                  .describe(
                    "Inline base64 image data for user_upload items when the user attached the file to the chat and the MCP client surfaces it to tools as base64 (data URL or raw). Mutually exclusive with url. Picked up by upload_image_from_data internally at execute time. Prefer url when the asset already lives at a public location.",
                  ),
                svg_content: z.string().max(200_000).optional(),
                aspirational_brand_name: z.string().min(1).max(80).optional(),
                alt: z.string().nullable().optional(),
                src_hint: z.string().nullable().optional(),
                size_hint: z.string().nullable().optional(),
                classification: z.enum(["element", "template", "anti_pattern", "skip"]),
                tag_override: z
                  .array(z.string().min(1))
                  .max(3)
                  .optional()
                  .describe(
                    "User-provided tag override. Each item must be a value from BRAND_TAGS (e.g. 'brand:logo', 'brand:cover-template'). When omitted, autoClassifyAsset's suggested_tags is used.",
                  ),
                filename_hint: z
                  .string()
                  .max(150)
                  .optional()
                  .describe(
                    "Optional filename to use when uploading. Defaults to a generated name based on source + index.",
                  ),
              }),
            )
            .max(60),
        }),
        language_override: z
          .string()
          .min(2)
          .max(10)
          .optional()
          .describe(
            "ISO-ish language tag for the synthesized brief (e.g. 'en', 'es', 'es-AR'). Defaults to company.language.",
          ),
        clear_ai_image_styles: z
          .boolean()
          .default(false)
          .describe(
            "If true, execute will PUT { ai_image_styles: [] } to neutralize the company's selected styles. Defaults false (cosmetic only; styles do not affect generation with nano_banana_2 per F0.1 verification).",
          ),
      },
    },
    async (input) => {
      try {
        // 1. Load Company.
        const company = await client.getCompany(input.company_id);
        const userFacingDescription =
          stripBrandIdentityFromDescription(company.description ?? null) ?? "";

        // 2. Validate curation items: each item must have the right payload
        //    for its source. Bail with a clear error if not.
        const curationValidation = validateCurationItems(input.curation.items);
        if (!curationValidation.ok) {
          return toolError({
            reason: "curation_invalid",
            user_message: curationValidation.message,
            blocking: true,
          });
        }

        // 3. Normalize aspirational brands to {name, url} pairs.
        const aspirationalPairs = (input.user_answers.aspirational_brands ?? []).map((b) =>
          typeof b === "string" ? { name: b, url: heuristicBrandUrl(b) } : { name: b.name, url: b.url ?? heuristicBrandUrl(b.name) },
        );

        // 4. Fetch og:image for each aspirational brand (best-effort, parallel).
        const aspirationalFetches = await Promise.allSettled(
          aspirationalPairs.map(async (pair) => {
            const sig = await scrapeBrandSignalsFromWebsite(pair.url);
            return { name: pair.name, url: pair.url, signals: sig };
          }),
        );
        const aspirationalRefs: Array<{
          name: string;
          source_url: string;
          og_image_url: string | null;
          fetched_ok: boolean;
          error: string | null;
        }> = aspirationalFetches.map((r, i) => {
          const pair = aspirationalPairs[i]!;
          if (r.status === "fulfilled") {
            return {
              name: pair.name,
              source_url: pair.url,
              og_image_url: r.value.signals.og_image_url,
              fetched_ok: r.value.signals.fetch_status === "ok",
              error: r.value.signals.fetch_error_detail,
            };
          }
          return {
            name: pair.name,
            source_url: pair.url,
            og_image_url: null,
            fetched_ok: false,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          };
        });

        // 5. Synthesize the brand brief via generateChat.
        const languageForBrief =
          input.language_override ??
          (company as Company & { language?: string }).language ??
          "English";
        const synthPrompt = buildSynthesisPrompt({
          company,
          userFacingDescription,
          visualStyle: input.user_answers.visual_style,
          aspirationalRefs,
          antiPatterns: input.user_answers.anti_patterns ?? [],
          curationCount: input.curation.items.filter(
            (it) => it.classification !== "skip",
          ).length,
          languageForBrief,
        });
        let briefText = "";
        let synthAiResultId: number | null = null;
        let synthWords = 0;
        try {
          const initial = await client.generateChat({ q: synthPrompt, company_id: input.company_id });
          const final =
            initial.status === "completed" || initial.status === "failed"
              ? initial
              : await client.waitForAiResult(initial.id, { timeoutMs: 120_000 });
          if (final.status === "completed" && typeof final.response === "string" && final.response.trim().length > 0) {
            briefText = final.response.trim();
            synthAiResultId = final.id;
            synthWords = final.words ?? 0;
          } else {
            // Fall back to a deterministic brief if synthesis failed.
            briefText = buildFallbackBrief({
              company,
              visualStyle: input.user_answers.visual_style,
              antiPatterns: input.user_answers.anti_patterns ?? [],
              aspirationalRefs,
            });
          }
        } catch (err) {
          // Same fallback path: don't fail the draft just because text AI is down.
          briefText = buildFallbackBrief({
            company,
            visualStyle: input.user_answers.visual_style,
            antiPatterns: input.user_answers.anti_patterns ?? [],
            aspirationalRefs,
          });
          void err;
        }

        // Cap brief_text to the schema maximum.
        if (briefText.length > 2000) briefText = briefText.slice(0, 1997) + "...";

        // 6. Build the proposed_identity.
        // Company.palettes is typed as unknown[]; filter to strings defensively.
        const palettePrimary: string[] = (
          ((company as Company).palettes as unknown[] | undefined) ?? []
        )
          .filter((c): c is string => typeof c === "string")
          .slice(0, 3);
        const proposedIdentity = buildBrandVisualIdentity({
          brief_text: briefText || "Brand visual identity (manual override).",
          palette_primary: palettePrimary,
          palette_extended: [],
          typography_style_text: "",
          typography_specific_font_name: null,
          anti_patterns_text: input.user_answers.anti_patterns ?? [],
          aspirational_brands: aspirationalPairs.map((p) => p.name),
        });

        // 7. Build the proposed_actions list.
        const proposedActions = buildProposedActionsForDraft({
          curationItems: input.curation.items,
          aspirationalRefs,
          clearAiImageStyles: input.clear_ai_image_styles,
        });

        // 8. Persist the draft in memory.
        const draft = createDraft({
          company_id: input.company_id,
          user_answers: {
            visual_style: input.user_answers.visual_style,
            aspirational_brands: aspirationalPairs.map((p) => p.name),
            anti_patterns: input.user_answers.anti_patterns ?? [],
            language_override: input.language_override ?? null,
            clear_ai_image_styles: input.clear_ai_image_styles,
          },
          proposed_identity: proposedIdentity,
          proposed_actions: proposedActions,
          brief_synthesis_ai_result_id: synthAiResultId,
          brief_synthesis_words: synthWords,
        });

        // 9. Build the preview markdown.
        const previewMarkdown = renderDraftPreviewMarkdown({
          companyName: company.name,
          draft,
          aspirationalRefs,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  draft_id: draft.draft_id,
                  expires_at_iso: new Date(draft.expires_at_ms).toISOString(),
                  proposed_identity: proposedIdentity,
                  proposed_actions: proposedActions,
                  aspirational_fetch_results: aspirationalRefs,
                  brief_synthesis: {
                    ai_result_id: synthAiResultId,
                    words_used: synthWords,
                    used_fallback: synthAiResultId === null,
                  },
                  preview_markdown: previewMarkdown,
                  _assistant_guidance: {
                    next_step: "show_preview_then_call_execute",
                    instructions:
                      "Surface preview_markdown verbatim to the user. Wait for explicit approval ('dale', 'ejecuta', 'OK', etc.). On approval, call execute_brand_visual_identity(draft_id, confirm=true). If the user wants changes, call draft_brand_visual_identity again with updated inputs (this draft expires in 24h).",
                    blockers:
                      proposedActions.filter((a) => a.kind === "upload_url_to_folder").length === 0 &&
                      proposedActions.filter((a) => a.kind === "upload_data_to_folder").length === 0 &&
                      proposedActions.filter((a) => a.kind === "upload_svg_to_folder").length === 0 &&
                      proposedActions.filter((a) => a.kind === "fetch_og_image_then_upload").length === 0
                        ? [
                            "El draft no tiene ningún asset curado: ni del scrape del sitio, ni de imágenes adjuntas del usuario, ni de marcas aspiracionales. Si ejecutás así, las 3 folders __brand_templates / __brand_elements / __brand_anti_patterns van a quedar VACÍAS. Para evitarlo: (a) volvé a la curación y aprobá al menos 1 logo / hero / aspiracional, (b) pedile al usuario 1-2 imágenes propias (logo en alta, screenshot del producto, post viejo que rindió) y pasalas en curation con source=user_upload + image_data o url, o (c) confirmá explícitamente con el usuario que querés persistir el bloque de identidad sin assets de referencia y que las folders quedarán vacías hasta llenarlas a mano.",
                          ]
                        : [],
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // execute_brand_visual_identity (F2.6, skeleton without Phase 1)
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "execute_brand_visual_identity",
    {
      annotations: MUTATION,
      title: "Commit a Brand Visual Identity draft to Followr (folders + uploads + description block)",
      description: `Take a draft_id created by draft_brand_visual_identity and execute its proposed_actions against Followr. This is the mutation step: creates folders, uploads curated assets (URL + inline SVG + aspirational og:images), updates Company.description with the BrandVisualIdentity block, and optionally clears ai_image_styles.

DOES NOT generate AI image templates yet. That is a separate tool (manufacture_brand_templates, lands in F2.8) gated by an independent cost confirmation.

PRECONDITION: draft_id must exist in MCP server memory, status must be "draft", and the user must have given explicit approval. The MCP requires confirm: true literal to proceed.

NOT ATOMIC: actions execute in ordered batches. If folder creation fails the run aborts before any upload happens (zero Followr footprint). If folders succeeded but some uploads failed, the partial state is preserved: the description block lists the folder ids and the uploads that succeeded. Failed uploads can be retried via update_brand_visual_identity (lands in F5). The agent should surface the partial result to the user.

RETURNS a granular execution report per action (succeeded / failed + reason), the final BrandVisualIdentity persisted in Company.description, and a user_facing_summary.

After success the agent should offer Phase 1 template manufacturing as a follow-up: surface the cost, ask for explicit approval, then call manufacture_brand_templates (when that tool lands).`,
      inputSchema: {
        draft_id: z.string().min(1),
        confirm: z
          .literal(true)
          .describe(
            "Must be literally true. Refuses to execute otherwise. Defensive against accidental calls.",
          ),
      },
    },
    async ({ draft_id, confirm }) => {
      try {
        if (confirm !== true) {
          return toolError({
            reason: "missing_confirmation",
            user_message:
              "execute_brand_visual_identity requires confirm: true literal. Did the user explicitly approve the preview shown by draft_brand_visual_identity?",
            blocking: true,
          });
        }
        const draft = getDraft(draft_id);
        if (!draft) {
          return toolError({
            reason: "draft_not_found_or_expired",
            user_message:
              "No encuentro ese draft de Brand Visual Identity. Puede haber expirado (TTL de 24h) o nunca fue creado. Volvé a llamar draft_brand_visual_identity con los mismos inputs.",
            blocking: true,
          });
        }
        if (draft.status !== "draft") {
          return toolError({
            reason: "draft_already_consumed",
            user_message: `Este draft ya tiene status="${draft.status}". Solo drafts en "draft" pueden ejecutarse. Si querés re-aplicar, creá un nuevo draft.`,
            blocking: true,
          });
        }
        updateDraft(draft_id, { status: "executing", execution_started_at_ms: Date.now() });

        // 1. Resolve order groups and execute in sequence.
        const actions = [...draft.proposed_actions].sort((a, b) => a.order - b.order);
        const orderGroups = new Map<number, ProposedAction[]>();
        for (const a of actions) {
          if (!orderGroups.has(a.order)) orderGroups.set(a.order, []);
          orderGroups.get(a.order)!.push(a);
        }

        // State across groups: folder ids resolved + uploaded asset ids list.
        let folderIdTemplates: number | null = null;
        let folderIdElements: number | null = null;
        let folderIdAntiPatterns: number | null = null;
        const uploadedAssets: Array<{
          asset_id: number;
          folder_intent: "templates" | "elements" | "anti_patterns";
          tags: BrandTag[];
        }> = [];
        const actionReport: Array<{
          kind: ProposedActionKind;
          status: "succeeded" | "failed";
          error?: string;
          result?: Record<string, unknown>;
        }> = [];

        const groupOrders = [...orderGroups.keys()].sort((a, b) => a - b);
        for (const order of groupOrders) {
          const batch = orderGroups.get(order)!;
          const results = await Promise.allSettled(
            batch.map(async (action) => {
              switch (action.kind) {
                case "create_folder": {
                  const name = String(action.payload["name"] ?? "");
                  const intent = String(action.payload["intent"] ?? "") as
                    | "templates"
                    | "elements"
                    | "anti_patterns";
                  const folder = await client.createFolder(draft.company_id, { name });
                  if (intent === "templates") folderIdTemplates = folder.id;
                  else if (intent === "elements") folderIdElements = folder.id;
                  else if (intent === "anti_patterns") folderIdAntiPatterns = folder.id;
                  return { action, result: { folder_id: folder.id, name: folder.name } };
                }
                case "upload_url_to_folder": {
                  const url = String(action.payload["url"]);
                  const intent = String(action.payload["target_intent"]) as
                    | "templates"
                    | "elements"
                    | "anti_patterns";
                  const filename = String(action.payload["filename"] ?? "");
                  const tags = (action.payload["tags"] as BrandTag[]) ?? [];
                  const folderId = resolveFolderId(intent, {
                    folderIdTemplates,
                    folderIdElements,
                    folderIdAntiPatterns,
                  });
                  const asset = await uploadFromUrl(client, {
                    companyId: draft.company_id,
                    url,
                    type: "image",
                    ...(filename ? { name: filename } : {}),
                    ...(folderId !== null ? { folderId } : {}),
                  });
                  uploadedAssets.push({ asset_id: asset.id, folder_intent: intent, tags });
                  return { action, result: { asset_id: asset.id, folder_intent: intent, tags } };
                }
                case "upload_data_to_folder": {
                  const imageData = String(action.payload["image_data"]);
                  const intent = String(action.payload["target_intent"]) as
                    | "templates"
                    | "elements"
                    | "anti_patterns";
                  const filename = String(action.payload["filename"] ?? "");
                  const tags = (action.payload["tags"] as BrandTag[]) ?? [];
                  const folderId = resolveFolderId(intent, {
                    folderIdTemplates,
                    folderIdElements,
                    folderIdAntiPatterns,
                  });
                  const asset = await uploadFromData(client, {
                    companyId: draft.company_id,
                    imageData,
                    ...(filename ? { name: filename } : {}),
                    ...(folderId !== null ? { folderId } : {}),
                  });
                  uploadedAssets.push({ asset_id: asset.id, folder_intent: intent, tags });
                  return { action, result: { asset_id: asset.id, folder_intent: intent, tags } };
                }
                case "upload_svg_to_folder": {
                  const svg = String(action.payload["svg_content"]);
                  const intent = String(action.payload["target_intent"]) as
                    | "templates"
                    | "elements"
                    | "anti_patterns";
                  const filename = String(action.payload["filename"]);
                  const tags = (action.payload["tags"] as BrandTag[]) ?? [];
                  const folderId = resolveFolderId(intent, {
                    folderIdTemplates,
                    folderIdElements,
                    folderIdAntiPatterns,
                  });
                  const asset = await uploadSvgInline(
                    client,
                    draft.company_id,
                    svg,
                    filename,
                    folderId,
                  );
                  uploadedAssets.push({ asset_id: asset.id, folder_intent: intent, tags });
                  return { action, result: { asset_id: asset.id, folder_intent: intent, tags } };
                }
                case "fetch_og_image_then_upload": {
                  const ogUrl = String(action.payload["og_image_url"]);
                  const intent = String(action.payload["target_intent"]) as
                    | "templates"
                    | "elements"
                    | "anti_patterns";
                  const filename = String(action.payload["filename"]);
                  const tags = (action.payload["tags"] as BrandTag[]) ?? [];
                  const folderId = resolveFolderId(intent, {
                    folderIdTemplates,
                    folderIdElements,
                    folderIdAntiPatterns,
                  });
                  const asset = await uploadFromUrl(client, {
                    companyId: draft.company_id,
                    url: ogUrl,
                    type: "image",
                    name: filename,
                    ...(folderId !== null ? { folderId } : {}),
                  });
                  uploadedAssets.push({ asset_id: asset.id, folder_intent: intent, tags });
                  return { action, result: { asset_id: asset.id, folder_intent: intent, tags } };
                }
                case "update_company_description": {
                  // Build final identity with folder ids and counts from
                  // what actually succeeded, then persist. When all three
                  // counts end up at zero (every upload failed silently)
                  // prepend a [SETUP PARTIAL ...] marker to brief_text so
                  // future readers can tell the brief is aspirational
                  // rather than backed by real assets. The reconcile pass
                  // in assess will also surface setup_status: "broken" and
                  // route next_step to "refresh" with repair_needed.
                  const counts = countByIntent(uploadedAssets);
                  const allUploadsFailed =
                    counts.templates === 0 &&
                    counts.elements === 0 &&
                    counts.anti_patterns === 0;
                  const briefText = allUploadsFailed
                    ? `[SETUP PARTIAL: folders created ${new Date().toISOString().slice(0, 10)} but every upload failed. Brief is aspirational; no visual assets are backing it. Re-run setup or upload assets manually to recover.]\n\n${draft.proposed_identity.brief_text}`
                    : draft.proposed_identity.brief_text;
                  let finalIdentity: BrandVisualIdentity = {
                    ...draft.proposed_identity,
                    brief_text: briefText,
                    folders: {
                      templates: folderIdTemplates,
                      elements: folderIdElements,
                      anti_patterns: folderIdAntiPatterns,
                    },
                    templates_count: counts.templates,
                    elements_count: counts.elements,
                    anti_patterns_count: counts.anti_patterns,
                    aspirational_refs_asset_ids: uploadedAssets
                      .filter((u) => u.tags.includes(BRAND_TAGS.ASPIRATIONAL))
                      .map((u) => u.asset_id),
                  };
                  // Apply asset tag map for every uploaded asset.
                  for (const u of uploadedAssets) {
                    finalIdentity = tagAssetInIdentity(finalIdentity, u.asset_id, u.tags);
                  }
                  // Read current company so we don't trample fields. Followr's
                  // partial PUT pattern means we only need to send the fields
                  // we change, but description must be re-merged.
                  const current = await client.getCompany(draft.company_id);
                  const newDescription = appendBrandIdentityToDescription(
                    current.description ?? null,
                    finalIdentity,
                  );
                  await client.updateCompany(draft.company_id, { description: newDescription });
                  return {
                    action,
                    result: {
                      persisted_identity: finalIdentity,
                      setup_partial: allUploadsFailed,
                    },
                  };
                }
                case "clear_ai_image_styles": {
                  await client.updateCompany(draft.company_id, { ai_image_styles: [] });
                  return { action, result: { cleared: true } };
                }
                default:
                  throw new Error(`Unknown action kind: ${String(action.kind)}`);
              }
            }),
          );
          for (const r of results) {
            if (r.status === "fulfilled") {
              actionReport.push({
                kind: r.value.action.kind,
                status: "succeeded",
                result: r.value.result,
              });
            } else {
              const detail =
                r.reason instanceof Error ? r.reason.message : String(r.reason);
              const kind =
                (batch.find((b) => true)?.kind as ProposedActionKind | undefined) ?? "create_folder";
              actionReport.push({ kind, status: "failed", error: detail });
            }
          }
          // If folder creation batch had ANY failure, abort the rest (we
          // don't want to upload without folders).
          if (order === 10 && actionReport.some((r) => r.status === "failed")) {
            updateDraft(draft_id, {
              status: "failed",
              execution_finished_at_ms: Date.now(),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      draft_id,
                      status: "failed_at_folder_creation",
                      action_report: actionReport,
                      user_facing_summary:
                        "Falló la creación de uno o más folders. Aborté antes de subir ningún asset. Ningún cambio quedó en Followr salvo los folders que sí se crearon (los vas a ver en Media Library). Pasame el error para diagnosticar.",
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        }

        updateDraft(draft_id, { status: "executed", execution_finished_at_ms: Date.now() });

        // Compute totals for the user-facing summary.
        const succeededUploads = actionReport.filter(
          (r) =>
            r.status === "succeeded" &&
            (r.kind === "upload_url_to_folder" ||
              r.kind === "upload_data_to_folder" ||
              r.kind === "upload_svg_to_folder" ||
              r.kind === "fetch_og_image_then_upload"),
        ).length;
        const failedActions = actionReport.filter((r) => r.status === "failed");

        const userFacingSummary =
          failedActions.length === 0
            ? succeededUploads === 0
              ? `Brand Visual Identity persistida con folders creados pero CERO assets subidos. __brand_templates (${folderIdTemplates ?? "-"}), __brand_elements (${folderIdElements ?? "-"}), __brand_anti_patterns (${folderIdAntiPatterns ?? "-"}) quedan vacíos. El brief se persistió como aspirational (marcado [SETUP PARTIAL]). Antes de avanzar a Phase 1 conviene subir manualmente al menos 1 logo + 1 hero, o re-correr setup con curación que incluya assets. assess va a devolver next_step: refresh con repair_needed.`
              : `Brand Visual Identity persistida con éxito. Folders creados: __brand_templates (${folderIdTemplates ?? "-"}), __brand_elements (${folderIdElements ?? "-"}), __brand_anti_patterns (${folderIdAntiPatterns ?? "-"}). ${succeededUploads} asset${succeededUploads === 1 ? "" : "s"} subido${succeededUploads === 1 ? "" : "s"}. El bloque BRAND_VISUAL_IDENTITY queda en Company.description.\n\nPróximo paso recomendado: Phase 1 (manufactura de ${PHASE_1_TEMPLATE_COUNT} templates AI con costo ~${PHASE_1_ESTIMATE_CR} créditos). Sin templates, cualquier plan que incluya imágenes generadas con AI va a quedar hard-blocked en draft_content_plan. La única alternativa válida es subir manualmente al menos 1 cover template al folder __brand_templates desde la UI de Followr. ¿Avanzamos con Phase 1?`
            : succeededUploads === 0
              ? `Brand Visual Identity persistida pero TODOS los uploads fallaron (${failedActions.length} fallos). Folders creados quedan vacíos y el brief queda marcado [SETUP PARTIAL]. Revisá action_report para diagnosticar y reintentá el setup. assess va a devolver next_step: refresh con repair_needed.`
              : `Brand Visual Identity persistida parcialmente. ${succeededUploads} asset${succeededUploads === 1 ? "" : "s"} OK, ${failedActions.length} acción${failedActions.length === 1 ? "" : "es"} falló${failedActions.length === 1 ? "" : "ron"}. Revisá el action_report para detalles. Podés reintentar con update_brand_visual_identity (no disponible todavía en esta versión) o seguir adelante.`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  draft_id,
                  status: failedActions.length === 0 ? "succeeded" : "partial",
                  folders_created: {
                    templates: folderIdTemplates,
                    elements: folderIdElements,
                    anti_patterns: folderIdAntiPatterns,
                  },
                  uploaded_asset_count: succeededUploads,
                  uploaded_assets: uploadedAssets,
                  action_report: actionReport,
                  user_facing_summary: userFacingSummary,
                  _assistant_guidance: {
                    next_step:
                      failedActions.length === 0
                        ? "offer_phase_1_template_manufacturing"
                        : "review_failures_with_user",
                    instructions:
                      failedActions.length === 0
                        ? `Mostrá user_facing_summary al usuario y RECOMENDÁ explícitamente avanzar con Phase 1 (manufacture_brand_templates). Es el único path que llena __brand_templates con assets AI sintetizados desde el brief. Sin templates, draft_content_plan hard-bloquea con reason=brand_templates_missing cualquier plan que use ai_generate (image_source o carousel_sources). NO presentes Phase 1 como opcional ni recomendes saltarlo: si el usuario rechaza ahora, la próxima sesión de planning queda bloqueada hasta que vuelva acá o suba templates manualmente. Si el usuario insiste en no gastar créditos en AI, la ÚNICA alternativa legítima es que suba manualmente al menos 1 cover template al folder __brand_templates desde la UI de Followr (los uploads manuales se reconocen sin re-correr manufacture).`
                        : "Mostrale el resumen + lista de acciones fallidas. El identity quedó parcialmente persistido. No bloquees al usuario; sugerile revisar la lista y decidir si quiere reintentar las fallidas o avanzar igual.",
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        try {
          updateDraft(draft_id, { status: "failed", execution_finished_at_ms: Date.now() });
        } catch {
          // ignore
        }
        return toolErrorFromException(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // manufacture_brand_templates (F2.8): Phase 1 AI template generation
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "manufacture_brand_templates",
    {
      annotations: MUTATION,
      title: "Generate AI image templates for a configured Brand Visual Identity (Phase 1)",
      description: `Generate ~12 AI image templates (2 per category × 6 categories) using the company's Brand Visual Identity as grounding: synthesized brief + palette + curated assets as reference_image_urls. Each generation costs credits from ai_image_and_video_budget at the rate of the company's image_model (default nano_banana_2 = 25 cr/image; nano_banana_pro = 45 cr/image).

PRECONDITION: the company must already have a Brand Visual Identity block in Company.description (i.e. execute_brand_visual_identity must have succeeded earlier). The tool refuses if the block is missing or corrupted.

EXPLICIT COST GATING: requires confirm: true literal. The agent MUST surface the cost breakdown verbatim to the user before calling, and wait for explicit approval. Format: "Voy a generar X templates con modelo Y. Costo: X × Y_cost_per_image = Z créditos. Te quedan W de tu ai_image_and_video_budget. ¿Confirmás?".

CATEGORIES generated (default 6, configurable):
- cover (COVER_TEMPLATE): cover slide for carousels
- step (STEP_TEMPLATE): step-by-step illustration
- cta (CTA_TEMPLATE): call-to-action closing slide
- feature (FEATURE_TEMPLATE): single feature/product spotlight
- quote (QUOTE_TEMPLATE): quote / testimonial layout
- launch (LAUNCH_TEMPLATE): launch / flagship slide (renamed from "hero" on 2026-05-24 to disambiguate against the HERO asset tag; the legacy "hero" identifier is still accepted as input for backwards compatibility but the canonical name is "launch")

GENERATION FLOW per template:
1. Build a prompt that combines: brand brief (from the block) + palette hex codes + typography hint + anti-patterns + category-specific layout instructions.
2. Pick 3-5 reference_image_urls from the brand assets (always logo + category-relevant elements).
3. Apply the standard PLACEHOLDER_PROHIBITION_SUFFIX so the model does not leak placeholder text.
4. Call generate_image at the configured aspect_ratio (default 1:1 for portability across networks).
5. Wait for completion (up to 5 min per generation).
6. Upload the result URL back to the asset library so it becomes a permanent asset (uploadFromUrl pattern).
7. Tag the new asset in the BrandVisualIdentity asset_tag_map with the category's BrandTag.

CONCURRENCY: generations run in parallel groups of 4 to balance speed vs backend load. With 12 templates and average 60s/gen, total time is ~3 minutes.

PARTIAL SUCCESS: if some generations fail (the model is down, content policy violation, etc.), the rest still complete. Returns a per-template report with status + ai_result_id + asset_id.

NEXT STEP: after manufacture, call finalize_brand_templates with user's per-asset approve/reject decisions. Rejected assets get deleted and removed from the block; approved stay in the library tagged correctly.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        confirm: z
          .literal(true)
          .describe("Must be literally true. Cost is non-trivial; the agent must verify the user approved."),
        templates_per_category: z
          .number()
          .int()
          .min(1)
          .max(4)
          .default(2)
          .describe("How many variations per category. Default 2 (so 12 templates total across 6 categories)."),
        categories: z
          .array(
            z.enum([
              "cover",
              "step",
              "cta",
              "feature",
              "quote",
              "launch",
              // Legacy alias for "launch". Accepted on input and normalized to
              // "launch" internally so already-shipped agent prompts keep
              // working through the rename.
              "hero",
            ]),
          )
          .max(6)
          .default(["cover", "step", "cta", "feature", "quote", "launch"])
          .describe(
            "Subset of categories to generate. Default is all 6 (cover, step, cta, feature, quote, launch). Skip categories the brand definitely doesn't need (e.g. omit 'quote' for a product-only brand). 'hero' is accepted as a legacy alias for 'launch' and gets normalized internally.",
          ),
        model_override: z
          .string()
          .optional()
          .describe(
            "Override the company's ai_preferences.image_model for this run. Useful for one-off premium runs without changing company defaults. If omitted, uses the company default (nano_banana_2 fallback).",
          ),
        aspect_ratio: z
          .enum(["1:1", "4:3", "16:9", "3:4", "9:16"])
          .default("1:1")
          .describe(
            "Aspect ratio for all generated templates. Default 1:1 because templates are references (style guidance) and 1:1 is the most portable across feeds and carousels.",
          ),
      },
    },
    async (input) => {
      try {
        if (input.confirm !== true) {
          return toolError({
            reason: "missing_confirmation",
            user_message:
              "manufacture_brand_templates requires confirm: true literal. ¿Le mostraste al usuario el costo y obtuviste su aprobación explícita antes de llamar?",
            blocking: true,
          });
        }
        // 1. Load Company + parse block.
        const company = await client.getCompany(input.company_id);
        const parsed = parseBrandIdentityFromDescription(company.description ?? null);
        if (parsed.status !== "ok") {
          return toolError({
            reason: "brand_identity_not_configured",
            user_message:
              parsed.status === "missing"
                ? "Esta empresa todavía no tiene Brand Visual Identity configurado. Llamá assess_brand_visual_identity → draft → execute primero, y después manufacture."
                : `El bloque BRAND_VISUAL_IDENTITY está corrupto: ${parsed.error}. Re-ejecutá el setup desde assess_brand_visual_identity para regenerarlo.`,
            blocking: true,
          });
        }
        const identity = parsed.identity;

        // 2. Resolve image model + driver + cost.
        //
        // PARITY with execute_content_plan + generate_image: Followr's
        // backend cannot reliably infer the driver from `model` alone for
        // nano_banana_2 and the Veo/Wan/SeeDance/Hailuo/Imagen sets. When
        // driver is omitted, /api/aiResults/image returns HTTP 422
        // "selected model is invalid" before the request reaches the
        // provider. Verified empirically (see driver-resolver.ts header).
        // resolveDriver consults explicit input -> prefs -> catalog hints.
        const prefs = (company as Company & { ai_preferences?: AiPreferences | null }).ai_preferences;
        // sanitizeImageModelPref filters out stale ids (e.g. "dall-e-3"
        // persisted on older Followr UI versions) so the fallback to
        // nano_banana_2 actually takes over instead of leaking a value the
        // backend would reject with HTTP 422 "selected model is invalid".
        const resolvedModel =
          input.model_override ?? sanitizeImageModelPref(prefs?.image_model) ?? "nano_banana_2";
        const resolvedDriver = resolveDriver({
          prefs: prefs ?? undefined,
          modality: "image",
          model: resolvedModel,
        });
        const costPerImage = perImageCostFor(resolvedModel);
        // Normalize the input categories (which may include the legacy "hero"
        // alias) into the canonical TemplateCategory set, and dedupe in case
        // the caller passed both "hero" and "launch". The user-facing output
        // (per-category results, cost lines) is built from this normalized
        // list so the response always speaks the new vocabulary.
        const normalizedCategories: TemplateCategory[] = Array.from(
          new Set(input.categories.map((c) => normalizeTemplateCategory(c as RawTemplateCategory))),
        );
        const totalTemplates = input.templates_per_category * normalizedCategories.length;
        const totalCost = totalTemplates * costPerImage;

        // 3. Pull asset library to resolve reference_image_urls by tag.
        let allAssets: Asset[] = [];
        try {
          allAssets = await client.listAssets(input.company_id, {
            pageSize: 100,
            include: "image.thumbnail",
          });
        } catch {
          allAssets = [];
        }
        const assetIdToUrl = new Map<number, string>();
        for (const a of allAssets) {
          const url =
            (a as Asset & { image?: { url?: string } }).image?.url ??
            (a as Asset & { url?: string }).url ??
            null;
          if (url) assetIdToUrl.set(a.id, url);
        }

        // 3b. Lazy folder creation for __brand_templates. The initial
        //     setup (execute_brand_visual_identity) only creates the
        //     folders that have curated content; on a low-asset cold start
        //     __brand_templates may not exist yet. We resolve it (or
        //     create it on demand + patch the block) here so the AI
        //     templates we're about to generate end up in the right
        //     folder instead of loose at the company root.
        const templatesFolderId = await ensureBrandFolder(
          client,
          input.company_id,
          "templates",
        );

        // 4. Run the generations grouped by concurrency=4.
        type Job = {
          category: TemplateCategory;
          variation: number;
          tag: BrandTag;
          aspectRatio: "1:1" | "4:3" | "16:9" | "3:4" | "9:16";
          refUrls: string[];
        };
        const refsByCategory = new Map<TemplateCategory, string[]>();
        await Promise.all(
          normalizedCategories.map(async (category) => {
            const refUrls = await pickReferenceUrlsForCategory(
              client,
              input.company_id,
              identity,
              assetIdToUrl,
              category,
            );
            refsByCategory.set(category, refUrls);
          }),
        );
        const jobs: Job[] = [];
        for (const category of normalizedCategories) {
          const tag = templateTagForCategory(category);
          const refUrls = refsByCategory.get(category) ?? [];
          for (let v = 1; v <= input.templates_per_category; v += 1) {
            jobs.push({ category, variation: v, tag, aspectRatio: input.aspect_ratio, refUrls });
          }
        }

        interface JobResult {
          category: TemplateCategory;
          variation: number;
          status: "succeeded" | "failed";
          ai_result_id: number | null;
          asset_id: number | null;
          /** Public CDN URL of the generated template image (Followr AI result URL).
           *  Used to render thumbnails for the user via markdown_preview. */
          asset_url: string | null;
          tag: BrandTag;
          prompt_excerpt: string;
          error: string | null;
        }
        const allResults: JobResult[] = [];
        const CONCURRENCY = 4;
        for (let i = 0; i < jobs.length; i += CONCURRENCY) {
          const batch = jobs.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.allSettled(
            batch.map(async (job): Promise<JobResult> => {
              const prompt = buildTemplatePrompt({
                identity,
                category: job.category,
                variation: job.variation,
              });
              try {
                const initial = await client.generateImage({
                  q: prompt,
                  company_id: input.company_id,
                  model: resolvedModel,
                  ...(resolvedDriver ? { driver: resolvedDriver } : {}),
                  aspect_ratio: job.aspectRatio,
                  ...(job.refUrls.length > 0 ? { image_urls: job.refUrls.slice(0, 5) } : {}),
                });
                const final =
                  initial.status === "completed" || initial.status === "failed"
                    ? initial
                    : await client.waitForAiResult(initial.id, { timeoutMs: 5 * 60 * 1000 });
                if (final.status !== "completed") {
                  return {
                    category: job.category,
                    variation: job.variation,
                    status: "failed",
                    ai_result_id: final.id,
                    asset_id: null,
                    asset_url: null,
                    tag: job.tag,
                    prompt_excerpt: prompt.slice(0, 200),
                    error: final.status_message ?? `Generation status: ${final.status}`,
                  };
                }
                const imageUrl =
                  (final as unknown as { image_url?: string; response?: string }).image_url ??
                  (final as unknown as { response?: string }).response;
                if (!imageUrl) {
                  return {
                    category: job.category,
                    variation: job.variation,
                    status: "failed",
                    ai_result_id: final.id,
                    asset_id: null,
                    asset_url: null,
                    tag: job.tag,
                    prompt_excerpt: prompt.slice(0, 200),
                    error: "Generation completed but no image URL was returned.",
                  };
                }
                // Upload the AI result URL to the asset library so it
                // becomes a permanent asset the user can reference. We
                // pass folder_id directly to land it in __brand_templates
                // in one round trip (verified 2026-05-23 that the
                // create-asset POST accepts folder_id in the body). When
                // templatesFolderId is null (block was missing or the
                // create folder + patch failed earlier), we still upload
                // to root and rely on the tag_map for the resolver to
                // find the asset.
                const asset = await uploadFromUrl(client, {
                  companyId: input.company_id,
                  url: imageUrl,
                  type: "image",
                  name: `brand-${job.category}-v${job.variation}.jpg`,
                  ...(templatesFolderId !== null ? { folderId: templatesFolderId } : {}),
                });
                return {
                  category: job.category,
                  variation: job.variation,
                  status: "succeeded",
                  ai_result_id: final.id,
                  asset_id: asset.id,
                  asset_url: imageUrl,
                  tag: job.tag,
                  prompt_excerpt: prompt.slice(0, 200),
                  error: null,
                };
              } catch (err) {
                return {
                  category: job.category,
                  variation: job.variation,
                  status: "failed",
                  ai_result_id: null,
                  asset_id: null,
                  asset_url: null,
                  tag: job.tag,
                  prompt_excerpt: prompt.slice(0, 200),
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }),
          );
          for (const r of batchResults) {
            if (r.status === "fulfilled") allResults.push(r.value);
            else {
              // Should not happen (we catch inside), but defensive.
              allResults.push({
                category: "cover",
                variation: 0,
                status: "failed",
                ai_result_id: null,
                asset_id: null,
                asset_url: null,
                tag: BRAND_TAGS.COVER_TEMPLATE,
                prompt_excerpt: "",
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              });
            }
          }
        }

        // 5. Update the BrandVisualIdentity block to register the new
        //    asset_ids with their tags. We persist eagerly here so the
        //    block is consistent even if the user closes the session
        //    before calling finalize. Also stamp last_manufacture_at so
        //    assess can surface a manufacture_recommended hint when
        //    elements drift significantly after this run.
        let updatedIdentity: BrandVisualIdentity = identity;
        for (const r of allResults) {
          if (r.status === "succeeded" && r.asset_id !== null) {
            updatedIdentity = tagAssetInIdentity(updatedIdentity, r.asset_id, [r.tag]);
            updatedIdentity = {
              ...updatedIdentity,
              templates_count: updatedIdentity.templates_count + 1,
            };
          }
        }
        const anySucceeded = allResults.some(
          (r) => r.status === "succeeded" && r.asset_id !== null,
        );
        if (anySucceeded) {
          updatedIdentity = {
            ...updatedIdentity,
            last_manufacture_at: new Date().toISOString(),
          };
        }
        const currentDescription =
          (await client.getCompany(input.company_id)).description ?? null;
        const newDescription = appendBrandIdentityToDescription(
          currentDescription,
          updatedIdentity,
        );
        try {
          await client.updateCompany(input.company_id, { description: newDescription });
        } catch (err) {
          // Block update failed but the assets are uploaded and tagged in
          // memory; we surface this to the user.
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "partial_block_update_failed",
                    error: err instanceof Error ? err.message : String(err),
                    generated_assets: allResults,
                    user_facing_summary:
                      "Generación OK pero falló persistir el bloque actualizado en Company.description. Los assets quedaron en tu biblioteca pero no taggeados oficialmente. Reintentá llamando manufacture_brand_templates de nuevo o avisame para que recuperemos el estado.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const succeededCount = allResults.filter((r) => r.status === "succeeded").length;
        const failedCount = allResults.length - succeededCount;
        const actualCost = succeededCount * costPerImage;

        // Build a renderable markdown preview of every successful template
        // so the agent can paste it verbatim into the user-facing message.
        // claude.ai renders ![alt](url) inline in the agent's prose, which
        // is the most portable way to surface thumbnails today (no MCP
        // image content blocks needed; works in any client that handles
        // markdown). Grouped by category so the user sees the variations
        // side by side. The agent should literally paste markdown_preview
        // when asking the user which templates to keep.
        const successfulResults = allResults.filter(
          (r) => r.status === "succeeded" && r.asset_url !== null,
        );
        const markdownPreviewLines: string[] = [];
        if (successfulResults.length > 0) {
          markdownPreviewLines.push(
            `## Templates manufacturados (${successfulResults.length})`,
            "",
            "Mirá cada uno y avisame cuáles rechazás (los demás quedan aprobados en tu biblioteca).",
            "",
          );
          const byCategory = new Map<TemplateCategory, JobResult[]>();
          for (const r of successfulResults) {
            const arr = byCategory.get(r.category) ?? [];
            arr.push(r);
            byCategory.set(r.category, arr);
          }
          for (const [cat, items] of byCategory) {
            markdownPreviewLines.push(`### ${cat.toUpperCase()}`);
            for (const item of items) {
              markdownPreviewLines.push(
                `- Variación ${String.fromCharCode(64 + item.variation)} · asset \`${item.asset_id ?? "?"}\`  `,
                `  ![${cat}-v${item.variation}](${item.asset_url ?? ""})`,
              );
            }
            markdownPreviewLines.push("");
          }
        }
        const markdownPreview = markdownPreviewLines.join("\n");

        // Pre-built decisions array the agent can mutate to call
        // finalize_brand_templates. Starts as all-approved; the agent
        // flips entries to "reject" based on user input and passes the
        // whole array verbatim to finalize_brand_templates. Saves the
        // agent from having to reconstruct asset_ids manually.
        const decisionsTemplate = successfulResults.map((r) => ({
          asset_id: r.asset_id,
          decision: "approve" as const,
          category: r.category,
          variation: r.variation,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status:
                    failedCount === 0
                      ? "succeeded"
                      : succeededCount > 0
                        ? "partial"
                        : "failed_all",
                  templates_generated: succeededCount,
                  templates_failed: failedCount,
                  cost_per_image_credits: costPerImage,
                  total_cost_credits_actual: actualCost,
                  total_cost_credits_estimate_pre_run: totalCost,
                  model_used: resolvedModel,
                  aspect_ratio: input.aspect_ratio,
                  generated_assets: allResults,
                  updated_identity: updatedIdentity,
                  markdown_preview: markdownPreview,
                  decisions_template: decisionsTemplate,
                  user_facing_summary:
                    failedCount === 0
                      ? `Generé ${succeededCount} templates AI usando ${resolvedModel}. Costo total: ${actualCost} créditos. Te los muestro para que apruebes cuáles quedan en tu biblioteca y cuáles descarto.`
                      : `Generé ${succeededCount} de ${jobs.length} templates (${failedCount} fallaron). Costo facturado: ${actualCost} créditos (las fallidas NO cuentan). Te muestro los OK para que apruebes; las fallidas las puedo reintentar después.`,
                  _assistant_guidance: {
                    next_step: "paste_markdown_preview_then_call_finalize",
                    instructions:
                      "PEGÁ markdown_preview tal cual en tu próxima respuesta al usuario (el cliente renderiza los thumbnails inline). Pedile que mire las imágenes y te avise cuáles rechaza. Cuando responda, tomá decisions_template (todas vienen como 'approve' por default), cambiá decision a 'reject' en las que el usuario rechazó, y llamá finalize_brand_templates(company_id, decisions). El bloque ya está actualizado con los tags; finalize ajusta los counts y borra del library las rechazadas. NUNCA menciones al usuario los términos 'asset_id', 'decisions_template' ni 'tag_map'; hablale en lenguaje natural ('los 12 templates', 'las variaciones de cover', 'borrá las que no te gusten').",
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // finalize_brand_templates (F2.9 + F2.10): user approves / rejects
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "finalize_brand_templates",
    {
      annotations: MUTATION,
      title: "Finalize Phase 1 templates: keep approved ones, delete rejected ones",
      description: `After manufacture_brand_templates produces template candidates, the user reviews each and decides approve / reject. This tool applies those decisions:
- approve: no-op. The asset stays in the library, tagged in the brand block.
- reject: delete the asset from the library AND remove its entry from the brand block's asset_tag_map AND decrement templates_count.

This tool is the second step of Phase 1, run after manufacture. Idempotent: re-calling with the same decisions is safe.

PRECONDITION: the company must have a Brand Visual Identity block. asset_ids in decisions must exist in the block's asset_tag_map (otherwise they're rejected as unknown).

NEXT STEP: after finalize, Brand Visual Identity Phase 1 is complete. The agent should announce "tu identidad visual está lista" and offer next actions (start a content plan, manually add more templates, etc.). Future flows (content generation via execute_content_plan) automatically use the approved templates as references.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        decisions: z
          .array(
            z.object({
              asset_id: z.number().int().positive(),
              decision: z.enum(["approve", "reject"]),
              reason: z
                .string()
                .max(200)
                .optional()
                .describe(
                  "Optional user-provided reason for rejection. Surfaced in the response but not persisted.",
                ),
            }),
          )
          .min(1)
          .max(60),
      },
    },
    async ({ company_id, decisions }) => {
      try {
        const company = await client.getCompany(company_id);
        const parsed = parseBrandIdentityFromDescription(company.description ?? null);
        if (parsed.status !== "ok") {
          return toolError({
            reason: "brand_identity_not_configured",
            user_message:
              "No encuentro un bloque BRAND_VISUAL_IDENTITY válido para esta empresa. Llamá assess + draft + execute primero.",
            blocking: true,
          });
        }
        let identity = parsed.identity;

        const decisionReport: Array<{
          asset_id: number;
          decision: "approve" | "reject";
          applied: "kept" | "deleted" | "skipped_not_in_block" | "delete_failed";
          error: string | null;
          reason: string | null;
        }> = [];

        for (const dec of decisions) {
          const assetIdStr = String(dec.asset_id);
          const wasTagged = identity.asset_tag_map[assetIdStr] !== undefined;
          if (dec.decision === "approve") {
            decisionReport.push({
              asset_id: dec.asset_id,
              decision: "approve",
              applied: wasTagged ? "kept" : "skipped_not_in_block",
              error: wasTagged ? null : "Asset not present in brand identity asset_tag_map.",
              reason: dec.reason ?? null,
            });
            continue;
          }
          // reject branch
          if (!wasTagged) {
            decisionReport.push({
              asset_id: dec.asset_id,
              decision: "reject",
              applied: "skipped_not_in_block",
              error: "Asset not present in brand identity asset_tag_map; nothing to delete.",
              reason: dec.reason ?? null,
            });
            continue;
          }
          try {
            await client.deleteAsset(dec.asset_id);
            // Remove from tag map + decrement templates_count.
            const { [assetIdStr]: _omit, ...rest } = identity.asset_tag_map;
            void _omit;
            identity = {
              ...identity,
              asset_tag_map: rest,
              templates_count: Math.max(0, identity.templates_count - 1),
            };
            decisionReport.push({
              asset_id: dec.asset_id,
              decision: "reject",
              applied: "deleted",
              error: null,
              reason: dec.reason ?? null,
            });
          } catch (err) {
            decisionReport.push({
              asset_id: dec.asset_id,
              decision: "reject",
              applied: "delete_failed",
              error: err instanceof Error ? err.message : String(err),
              reason: dec.reason ?? null,
            });
          }
        }

        // Persist the updated block.
        const newDescription = appendBrandIdentityToDescription(
          company.description ?? null,
          identity,
        );
        try {
          await client.updateCompany(company_id, { description: newDescription });
        } catch (err) {
          return toolError({
            reason: "block_update_failed",
            user_message: `Falló persistir el bloque actualizado: ${
              err instanceof Error ? err.message : String(err)
            }. Las decisiones de delete ya se aplicaron en Followr; solo falta sincronizar el bloque. Reintentá llamando finalize_brand_templates de nuevo con los MISMOS decisions.`,
            blocking: true,
          });
        }

        const approvedCount = decisionReport.filter((r) => r.applied === "kept").length;
        const deletedCount = decisionReport.filter((r) => r.applied === "deleted").length;
        const failedCount = decisionReport.filter(
          (r) => r.applied === "delete_failed" || r.applied === "skipped_not_in_block",
        ).length;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: failedCount === 0 ? "succeeded" : "partial",
                  approved_count: approvedCount,
                  deleted_count: deletedCount,
                  failed_count: failedCount,
                  decision_report: decisionReport,
                  final_identity: identity,
                  user_facing_summary:
                    failedCount === 0
                      ? `Listo. Mantuviste ${approvedCount} templates, borraste ${deletedCount}. Tu Brand Visual Identity está completa con ${identity.templates_count} templates totales en __brand_templates. Las próximas generaciones de imagen para esta empresa van a usar estos templates automáticamente como referencia.`
                      : `Aplicado parcialmente: ${approvedCount} approved, ${deletedCount} deleted, ${failedCount} con problemas. Mirá decision_report.applied para detalles.`,
                  _assistant_guidance: {
                    next_step: "phase_1_complete",
                    instructions:
                      "Brand Visual Identity Phase 1 está completa. Avisale al usuario que las próximas generaciones AI de imagen (vía content plan o generate_image directo con el flag de brand context) van a usar estos templates como ref automáticamente. Si quiere agregar más assets manualmente, puede subir imágenes a __brand_templates desde Followr UI y después llamá refresh_brand_identity (no implementado en esta versión) para incorporarlas al tag_map.",
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // propose_brand_template_refresh (F5 part 1): surface past winners
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "propose_brand_template_refresh",
    {
      annotations: READ_ONLY,
      title: "Propose past-published assets to add as Brand Visual Identity templates (refresh flow)",
      description: `Pull recent published PostGroups from the company, extract the first image asset of each, and propose them as candidate templates that the user can add to the Brand Visual Identity. Use after the initial Brand Visual Identity setup, when the company has accumulated published posts and the user wants to enrich the template library with proven-performing visuals.

NO MUTATION. Read-only. Safe to call multiple times.

PRECONDITION: the company must have a Brand Visual Identity block in Company.description. If not, the agent should run assess_brand_visual_identity → draft → execute first.

OUTPUT: list of candidates with { post_group_id, asset_id, asset_url, published_at, post_title, suggested_tag, already_tagged_in_brand }. The agent surfaces these to the user (with thumbnails) and asks per-candidate: keep / skip / change-tag. Then calls apply_brand_template_refresh with the decisions.

LIMITATIONS v1:
- Pulls newest published PostGroups (sort=-id), not strictly "best performing" by engagement metrics. A proper analytics-based ranking lives in get_best_performing_posts; for refresh we surface recent winners because (a) recency proxies for relevance, (b) get_best_performing_posts requires explicit since/until/sort_by and returns flat-per-network metrics that need post_group reconciliation. v2 candidate: combine both.
- Only single-image and carousel cover assets (first asset of each post). Videos are skipped.
- Capped at 20 candidates per call.
- already_tagged_in_brand=true assets are still returned so the user can re-tag if they want, but the agent should typically skip them.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        lookback_days: z
          .number()
          .int()
          .min(7)
          .max(365)
          .default(90)
          .describe(
            "How far back to look for published posts. Default 90 days. Use shorter (30) for fast-moving brands; longer (180) for slow-moving.",
          ),
        max_candidates: z
          .number()
          .int()
          .min(1)
          .max(30)
          .default(15)
          .describe("Maximum candidates to surface. Default 15."),
      },
    },
    async ({ company_id, lookback_days, max_candidates }) => {
      try {
        const company = await client.getCompany(company_id);
        const parsed = parseBrandIdentityFromDescription(company.description ?? null);
        if (parsed.status !== "ok") {
          return toolError({
            reason: "brand_identity_not_configured",
            user_message:
              parsed.status === "missing"
                ? "Esta empresa todavía no tiene Brand Visual Identity. Corré assess → draft → execute primero."
                : `El bloque BRAND_VISUAL_IDENTITY está corrupto: ${parsed.error}.`,
            blocking: true,
          });
        }
        const identity = parsed.identity;
        const cutoffIso = new Date(Date.now() - lookback_days * 24 * 60 * 60 * 1000).toISOString();

        // Fetch published posts with assets hydrated.
        const groups = await client.listCompanyPostGroups(company_id, {
          pageSize: Math.min(max_candidates * 2, 50),
          sort: "-id",
          draft: false,
          status: "published",
          include: "posts,posts.assets,posts.assets.image,posts.assets.image.thumbnail",
          publishAtAfter: cutoffIso,
        });

        interface Candidate {
          post_group_id: number;
          asset_id: number;
          asset_url: string;
          asset_thumbnail_url: string | null;
          published_at: string | null;
          post_title: string | null;
          post_topic: string | null;
          suggested_tag: BrandTag;
          already_tagged_in_brand: boolean;
          existing_tags_in_brand: BrandTag[];
        }
        const candidates: Candidate[] = [];
        for (const g of groups) {
          if (candidates.length >= max_candidates) break;
          const posts = (g as PostGroup & { posts?: Array<{ assets?: Asset[] }> }).posts ?? [];
          // Take the first post's first image asset (skip videos).
          let pickedAsset: Asset | null = null;
          for (const p of posts) {
            for (const a of p.assets ?? []) {
              if (a.type !== "image") continue;
              const aWithUrl = a as Asset & { image?: { url?: string; thumbnail?: { url?: string } } };
              if (!aWithUrl.image?.url) continue;
              pickedAsset = a;
              break;
            }
            if (pickedAsset) break;
          }
          if (!pickedAsset) continue;
          const aWithUrl = pickedAsset as Asset & {
            image?: { url?: string; thumbnail?: { url?: string } };
          };
          const url = aWithUrl.image?.url;
          if (!url) continue;
          const thumb = aWithUrl.image?.thumbnail?.url ?? null;
          const existing = (identity.asset_tag_map[String(pickedAsset.id)] ?? []) as BrandTag[];
          // Suggest a tag based on heuristic: default to COVER_TEMPLATE for
          // standalone images, STEP_TEMPLATE if the post has 2+ assets
          // (likely a carousel where the first is a cover, but the user
          // might want step templates from it too).
          const totalAssetsInPost = posts.reduce(
            (acc, p) => acc + ((p as { assets?: Asset[] }).assets?.length ?? 0),
            0,
          );
          const suggested: BrandTag =
            totalAssetsInPost >= 3 ? BRAND_TAGS.STEP_TEMPLATE : BRAND_TAGS.COVER_TEMPLATE;
          candidates.push({
            post_group_id: g.id,
            asset_id: pickedAsset.id,
            asset_url: url,
            asset_thumbnail_url: thumb,
            published_at:
              (g as PostGroup & { published_at?: string }).published_at ?? null,
            post_title: (g as PostGroup & { title?: string }).title ?? null,
            post_topic: (g as PostGroup & { topic?: string }).topic ?? null,
            suggested_tag: suggested,
            already_tagged_in_brand: existing.length > 0,
            existing_tags_in_brand: existing,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  company_id,
                  lookback_days,
                  identity_summary: {
                    synthesized_at: identity.synthesized_at,
                    last_brand_sync_at: identity.last_brand_sync_at,
                    posts_count_at_last_sync: identity.posts_count_at_last_sync,
                    templates_count: identity.templates_count,
                  },
                  candidates,
                  candidates_count: candidates.length,
                  user_facing_summary:
                    candidates.length === 0
                      ? `No encontré posts publicados con assets de imagen en los últimos ${lookback_days} días. Probá un lookback más largo o asegurate de que la empresa tiene posts publicados recientes.`
                      : `Encontré ${candidates.length} posteo${candidates.length === 1 ? "" : "s"} publicado${candidates.length === 1 ? "" : "s"} en los últimos ${lookback_days} días con assets de imagen. Te los muestro con thumbnails para que decidas cuáles sumar como templates de marca.`,
                  _assistant_guidance: {
                    next_step: "show_candidates_then_call_apply",
                    instructions:
                      "Mostrale al usuario los thumbnails de cada candidato (asset_thumbnail_url si existe, sino asset_url). Por cada uno preguntá: agregar como template? Si sí, qué tag (default suggested_tag, opciones: cover-template, step-template, cta-template, feature-template, quote-template, launch-template)? Si no, skip. Recolectá decisiones en formato { asset_id, accept: bool, target_tag: BrandTag } y llamá apply_brand_template_refresh. Templates ya tagged (already_tagged_in_brand=true) los podés saltar por default; mencionalo solo si el usuario quiere re-categorizar.",
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // apply_brand_template_refresh (F5 part 2): persist user decisions
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "apply_brand_template_refresh",
    {
      annotations: MUTATION,
      title: "Apply user decisions from a brand template refresh: tag past-winner assets in the brand block",
      description: `After propose_brand_template_refresh has surfaced candidates to the user, this tool applies the user's per-asset decisions by tagging accepted assets in the BrandVisualIdentity block (asset_tag_map). It does NOT delete rejected assets (they're already published, this is purely a tag-update). Idempotent: re-applying the same decisions is safe.

This is the tag-update sister of execute_brand_visual_identity, but for already-published assets. After running, the BrandVisualIdentity has new templates available to the resolver in future content generations.

PRECONDITION: the company must have a BrandVisualIdentity block. asset_ids in decisions must exist in the company's asset library (otherwise the API call to listAssets would have not surfaced them in the first place; defensive check happens here anyway).

UPDATES posts_count_at_last_sync and last_brand_sync_at on the block, which silences the refresh trigger in prepare_content_plan_context until enough new content is published again.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        decisions: z
          .array(
            z.object({
              asset_id: z.number().int().positive(),
              accept: z
                .boolean()
                .describe("true = tag as template, false = skip (no-op for this asset)."),
              target_tag: z
                .string()
                .min(1)
                .max(60)
                .optional()
                .describe(
                  "BrandTag value to assign when accept=true. e.g. 'brand:cover-template' or 'brand:launch-template'. Defaults to BRAND_TAGS.COVER_TEMPLATE if omitted. The legacy 'brand:hero-template' slug is still accepted as an alias for 'brand:launch-template'.",
                ),
            }),
          )
          .min(1)
          .max(30),
      },
    },
    async ({ company_id, decisions }) => {
      try {
        const company = await client.getCompany(company_id);
        const parsed = parseBrandIdentityFromDescription(company.description ?? null);
        if (parsed.status !== "ok") {
          return toolError({
            reason: "brand_identity_not_configured",
            user_message:
              "No encuentro un bloque BRAND_VISUAL_IDENTITY válido. Llamá assess + draft + execute primero.",
            blocking: true,
          });
        }
        let identity = parsed.identity;

        const decisionReport: Array<{
          asset_id: number;
          accept: boolean;
          applied: "tagged" | "skipped_user_rejected" | "skipped_already_tagged" | "skipped_invalid_tag";
          tags_added: BrandTag[];
          error: string | null;
        }> = [];
        let templatesAdded = 0;

        for (const d of decisions) {
          if (!d.accept) {
            decisionReport.push({
              asset_id: d.asset_id,
              accept: false,
              applied: "skipped_user_rejected",
              tags_added: [],
              error: null,
            });
            continue;
          }
          // Validate tag via resolveBrandTag so callers can pass either a
          // current canonical slug or a legacy alias (e.g.
          // 'brand:hero-template' -> LAUNCH_TEMPLATE). The persisted tag is
          // always the canonical resolved value, so future reads do not need
          // the alias map for assets written here.
          const rawTag = d.target_tag ?? BRAND_TAGS.COVER_TEMPLATE;
          const tag: BrandTag | null = resolveBrandTag(rawTag);
          if (tag === null) {
            const validTags = Object.values(BRAND_TAGS) as string[];
            decisionReport.push({
              asset_id: d.asset_id,
              accept: true,
              applied: "skipped_invalid_tag",
              tags_added: [],
              error: `target_tag "${rawTag}" is not a recognized BrandTag value. Allowed: ${validTags.join(", ")}.`,
            });
            continue;
          }
          const existing = (identity.asset_tag_map[String(d.asset_id)] ?? []) as BrandTag[];
          if (existing.includes(tag)) {
            decisionReport.push({
              asset_id: d.asset_id,
              accept: true,
              applied: "skipped_already_tagged",
              tags_added: [],
              error: null,
            });
            continue;
          }
          const newTags = [...existing, tag];
          identity = tagAssetInIdentity(identity, d.asset_id, newTags);
          templatesAdded += 1;
          decisionReport.push({
            asset_id: d.asset_id,
            accept: true,
            applied: "tagged",
            tags_added: [tag],
            error: null,
          });
        }

        // Bump counters + timestamps. We approximate "posts published now"
        // by reading current PostGroups count via listCompanyPostGroups.
        let currentPostCount = identity.posts_count_at_last_sync;
        try {
          const recent = await client.listCompanyPostGroups(company_id, {
            pageSize: 1,
            sort: "-id",
            draft: false,
            status: "published",
          });
          // Best-effort: if the API exposes meta.total via response we'd use
          // it. Today we have only the page array. Bump by the count of
          // candidates accepted as a coarse proxy until countCompanyPostGroups
          // lands (see TODO_V2.md).
          currentPostCount += templatesAdded;
          void recent;
        } catch {
          // Leave unchanged on error.
        }
        identity = {
          ...identity,
          templates_count: identity.templates_count + templatesAdded,
          last_brand_sync_at: new Date().toISOString(),
          posts_count_at_last_sync: currentPostCount,
        };

        // Persist the block.
        const newDescription = appendBrandIdentityToDescription(
          company.description ?? null,
          identity,
        );
        await client.updateCompany(company_id, { description: newDescription });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "succeeded",
                  templates_added: templatesAdded,
                  decision_report: decisionReport,
                  final_identity_counts: {
                    templates_count: identity.templates_count,
                    elements_count: identity.elements_count,
                    anti_patterns_count: identity.anti_patterns_count,
                  },
                  user_facing_summary:
                    templatesAdded === 0
                      ? "No se agregaron templates nuevos (todas las decisiones fueron skip o ya estaban tagged)."
                      : `Listo: agregué ${templatesAdded} nuevo${templatesAdded === 1 ? "" : "s"} template${templatesAdded === 1 ? "" : "s"} a tu Brand Visual Identity. Las próximas generaciones AI de imagen para esta empresa los van a usar como referencia automáticamente.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function findFolderByConventionalName(
  folders: Folder[],
  candidates: string[],
): Folder | null {
  const lcCandidates = candidates.map((c) => c.toLowerCase());
  for (const folder of folders) {
    const name = (folder.name ?? "").toLowerCase().trim();
    if (lcCandidates.includes(name)) return folder;
  }
  return null;
}

async function pullBestPerformingPosts(
  client: FollowrClient,
  companyId: number,
): Promise<PostGroup[]> {
  try {
    // Sorted by published_at desc; agent decides what "best" means downstream.
    // We surface the latest 10 published as a proxy. A full analytics-based
    // sort lives in get_best_performing_posts (called by the refresh flow).
    return await client.listCompanyPostGroups(companyId, {
      pageSize: 10,
      sort: "-id",
      draft: false,
      status: "published",
      include: "posts",
    });
  } catch {
    return [];
  }
}

async function countPublishedSafe(client: FollowrClient, companyId: number): Promise<number> {
  // Pull a single page with pageSize 200 and return its length. This caps
  // the count at 200, which is sufficient for the refresh heuristic
  // (postsDelta thresholds are 10 / 20). For companies with > 200 published
  // posts the count saturates at 200; that still flips the threshold
  // correctly. Earlier implementation returned MAX_SAFE_INTEGER when any
  // post existed, which made every active company route to "refresh" and
  // every inactive company never refresh — heuristic was effectively a
  // disguised boolean. A future iteration can paginate exactly when
  // listCompanyPostGroups exposes meta.total.
  try {
    const page = await client.listCompanyPostGroups(companyId, {
      pageSize: 200,
      draft: false,
      status: "published",
    });
    return page.length;
  } catch {
    return 0;
  }
}

async function loadBudgetsTolerant(client: FollowrClient): Promise<{
  ai_image_and_video_budget?: { remaining: number };
} | null> {
  try {
    const sub = await client.getSubscription();
    if (!sub) return null;
    // The subscription resource exposes the modality budgets we need.
    // Shape verified empirically: subscription.ai_image_and_video.{used,allowed}.
    const subAny = sub as unknown as {
      ai_image_and_video?: { used?: number; allowed?: number; remaining?: number };
    };
    const block = subAny.ai_image_and_video;
    if (!block) return null;
    const remaining =
      typeof block.remaining === "number"
        ? block.remaining
        : (block.allowed ?? 0) - (block.used ?? 0);
    return { ai_image_and_video_budget: { remaining } };
  } catch {
    return null;
  }
}

function daysBetween(isoA: string, isoB: string): number {
  try {
    const a = new Date(isoA).getTime();
    const b = new Date(isoB).getTime();
    return Math.floor(Math.abs(b - a) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * Very light heuristic: look at the description for industry keywords and
 * return a coarse industry slug. The real industry detection lives in
 * deep_research (cached on Company.description with a separate marker).
 * Here we use the description text as a best-effort fallback for picking
 * aspirational-brand examples in the cold-start questions.
 */
function detectIndustryFromDescription(desc: string): string | null {
  if (!desc) return null;
  const lower = desc.toLowerCase();
  if (/saas|b2b|software|platform|api|sdk|automation|integration/u.test(lower)) {
    return "saas";
  }
  if (/fashion|clothing|apparel|jean|sweater|ropa|prenda|outfit/u.test(lower)) {
    return "fashion";
  }
  if (/restaurant|cafe|menu|recipe|chef|plato|gastrono/u.test(lower)) {
    return "food";
  }
  if (/beauty|skincare|makeup|cosmetic|maquillaje|belleza/u.test(lower)) {
    return "beauty";
  }
  if (/fitness|gym|workout|deporte|entrenamiento/u.test(lower)) {
    return "fitness";
  }
  if (/hotel|airbnb|travel|tourism|hospitality|viaje/u.test(lower)) {
    return "hospitality";
  }
  if (/agency|studio|design|creative|estudio|agencia/u.test(lower)) {
    return "agency";
  }
  return null;
}

interface PreWarningArgs {
  companyName: string;
  nextStep: "cold_start" | "refresh" | "all_set";
  phaseEstimate: number;
  phaseImageCount: number;
  aiImageVideoRemaining: number | null;
  canAfford: boolean;
  hasWebsite: boolean;
  aiImageStylesCount: number;
}

function buildPreWarningText(args: PreWarningArgs): string {
  if (args.nextStep === "all_set") {
    return `${args.companyName} ya tiene Brand Visual Identity cargada y al día. No es necesario hacer setup. Si querés ver el resumen o agregar templates manualmente, decímelo.`;
  }

  const lines: string[] = [];
  if (args.nextStep === "cold_start") {
    lines.push(
      `Hola. Veo que es la primera vez que armamos identidad visual para ${args.companyName}.`,
      "",
      "Para que las imágenes que generemos se sientan realmente tuyas (no genéricas), te propongo construir tu identidad visual una vez. Después queda guardado en Followr y lo uso para todas las futuras generaciones.",
      "",
      "Esto va a:",
      "1. Hacerte 4 preguntas cortas (1 oración sobre tu estilo, marcas aspiracionales, curación de imágenes, anti-patterns).",
    );
    if (args.hasWebsite) {
      lines.push("2. Escanear tu sitio web en background (gratis, sin costo de créditos) para detectar logo, hero, paleta y fuentes.");
    } else {
      lines.push("2. NO escanear sitio (no hay URL cargada en la company; podemos seguir solo con tus uploads).");
    }
    lines.push(
      `3. Generar ${args.phaseImageCount} templates iniciales como propuesta (costo: ~${args.phaseEstimate} créditos de ai_image_and_video_budget). Vas a poder rechazar los que no te gusten antes de guardarlos.`,
      "4. Crear 3 folders en Followr: __brand_templates, __brand_elements, __brand_anti_patterns.",
    );
    if (args.aiImageStylesCount > 0) {
      lines.push(
        `5. Aviso: tu cuenta tiene ${args.aiImageStylesCount} style(s) seleccionado(s) en /company-settings/ai-images. Empíricamente confirmamos que ese campo NO afecta el output de nano_banana_2, pero si querés podemos limpiarlo para evitar confusión visual.`,
      );
    }
    if (!args.canAfford) {
      lines.push(
        "",
        `⚠️ No tenés créditos suficientes para Phase 1 (necesitás ${args.phaseEstimate} cr, te quedan ${args.aiImageVideoRemaining ?? "(unknown)"}). Podés saltar Phase 1 (folders + bloque persisten igual, sin templates generados) o conseguir más créditos antes.`,
      );
    }
    lines.push("", "¿Avanzamos?");
    return lines.join("\n");
  }

  // refresh
  lines.push(
    `${args.companyName} ya tiene identidad visual cargada pero detecté que vale la pena un refresh.`,
    "",
    "Opciones:",
    "(a) refresh de templates pulling top performers de los últimos 90 días (sin costo de créditos, solo curación de tus posts).",
    "(b) re-scrape del website (sin costo) para detectar nuevos elementos o cambios visuales.",
    `(c) full re-setup (cold start de nuevo, ~${args.phaseEstimate} cr de Phase 1).`,
    "",
    "¿Cuál preferís?",
  );
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────
// Draft tool helpers
// ──────────────────────────────────────────────────────────

type CurationItem = {
  source:
    | "scraped_logo"
    | "scraped_favicon"
    | "scraped_hero"
    | "scraped_gallery"
    | "scraped_svg"
    | "user_upload"
    | "aspirational_brand_og";
  url?: string;
  image_data?: string;
  svg_content?: string;
  aspirational_brand_name?: string;
  alt?: string | null;
  src_hint?: string | null;
  size_hint?: string | null;
  classification: "element" | "template" | "anti_pattern" | "skip";
  tag_override?: string[];
  filename_hint?: string;
};

function validateCurationItems(items: CurationItem[]): { ok: true } | { ok: false; message: string } {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.source === "scraped_svg") {
      if (!it.svg_content) {
        return {
          ok: false,
          message: `curation.items[${i}] (source=scraped_svg) requiere svg_content. El agente debe pasar el contenido SVG raw desde website_signals.inline_svg_icons[].svg_content del output de assess.`,
        };
      }
    } else if (it.source === "aspirational_brand_og") {
      if (!it.aspirational_brand_name) {
        return {
          ok: false,
          message: `curation.items[${i}] (source=aspirational_brand_og) requiere aspirational_brand_name. El agente debe pasar el nombre que el usuario eligió en pregunta 2.`,
        };
      }
    } else if (it.source === "user_upload") {
      if (!it.url && !it.image_data) {
        return {
          ok: false,
          message: `curation.items[${i}] (source=user_upload) requiere url o image_data. Si el usuario adjuntó el archivo al chat y tu cliente MCP lo expone como base64, pasalo en image_data. Si el asset ya vive en una URL pública (Drive shared link, CDN, asset library de Followr), pasalo en url.`,
        };
      }
      if (it.url && it.image_data) {
        return {
          ok: false,
          message: `curation.items[${i}] (source=user_upload) recibió url Y image_data. Pasá uno solo.`,
        };
      }
    } else {
      if (!it.url) {
        return {
          ok: false,
          message: `curation.items[${i}] (source=${it.source}) requiere url.`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Heuristic to guess a brand's website URL from its name. Works for common
 * cases (Stripe -> stripe.com, Linear -> linear.app). Edge cases need the
 * agent to pass an explicit url alongside the name.
 */
function heuristicBrandUrl(name: string): string {
  const known: Record<string, string> = {
    linear: "https://linear.app",
    notion: "https://notion.so",
    stripe: "https://stripe.com",
    vercel: "https://vercel.com",
    figma: "https://figma.com",
    loom: "https://loom.com",
    apple: "https://apple.com",
    nike: "https://nike.com",
    glossier: "https://glossier.com",
    patagonia: "https://patagonia.com",
    aritzia: "https://aritzia.com",
    zara: "https://zara.com",
    uniqlo: "https://uniqlo.com",
    sweetgreen: "https://sweetgreen.com",
    "blue bottle": "https://bluebottlecoffee.com",
    "shake shack": "https://shakeshack.com",
    chipotle: "https://chipotle.com",
    "drunk elephant": "https://drunkelephant.com",
    "the ordinary": "https://theordinary.com",
    aesop: "https://aesop.com",
    equinox: "https://equinox.com",
    peloton: "https://onepeloton.com",
    lululemon: "https://lululemon.com",
    strava: "https://strava.com",
    airbnb: "https://airbnb.com",
    "hoxton hotels": "https://thehoxton.com",
    "soho house": "https://sohohouse.com",
    marriott: "https://marriott.com",
    pentagram: "https://pentagram.com",
    buck: "https://buck.co",
    "frog design": "https://frog.co",
  };
  const lower = name.toLowerCase().trim();
  if (known[lower]) return known[lower];
  // Fallback: lowercase, strip spaces and punctuation, append .com
  const slug = lower.replace(/[^a-z0-9]/g, "");
  return `https://${slug}.com`;
}

interface SynthesisArgs {
  company: Company;
  userFacingDescription: string;
  visualStyle: string;
  aspirationalRefs: Array<{ name: string; source_url: string; og_image_url: string | null; fetched_ok: boolean }>;
  antiPatterns: string[];
  curationCount: number;
  languageForBrief: string;
}

function buildSynthesisPrompt(args: SynthesisArgs): string {
  const c = args.company as Company & {
    palettes?: string[];
    audience_types?: string[];
    tones?: unknown;
    language?: string;
  };
  const palette = (c.palettes ?? []).join(", ");
  const audience = (c.audience_types ?? []).join(", ");
  const tones = c.tones ? JSON.stringify(c.tones) : "";
  const aspirationalNames = args.aspirationalRefs.map((r) => r.name).join(", ");
  const aspirationalListWithStatus = args.aspirationalRefs
    .map((r) => `${r.name} (${r.fetched_ok ? "og:image fetched" : "no og:image"})`)
    .join("; ");

  return [
    "You are a brand identity expert helping synthesize a visual brand identity brief.",
    `OUTPUT LANGUAGE: ${args.languageForBrief}.`,
    "OUTPUT LENGTH: 200-700 words. No preamble, no JSON, just the brief text.",
    "OUTPUT PURPOSE: this brief will be appended as a prompt suffix to every AI image generation for this brand. Therefore: be SPECIFIC and ACTIONABLE for a vision model. Avoid abstract marketing copy. Use concrete visual descriptors (composition, palette usage, lighting, framing, typography character, illustration style).",
    "",
    "COVER (in flowing prose, not a list):",
    "1. Overall aesthetic vibe (one sentence, e.g. 'minimalist B2B SaaS aesthetic with teal accents').",
    "2. Color palette philosophy: how the brand uses its colors. Dominant vs accent. When dark backgrounds vs light. Avoid just listing hex codes.",
    "3. Typography character (NOT specific font names): weight, slab/sans/serif, geometric vs humanist, kerning, alignment style.",
    "4. Photography style if relevant: lighting, framing, candid vs staged, subjects (people / product / abstract).",
    "5. Illustration style if relevant: flat / 3D, line / filled, isometric / realistic, monoline / weighted.",
    "6. Composition tendencies: negative space, symmetry, layering, overlays, grid usage.",
    "7. Anti-patterns: things this brand visually IS NOT.",
    "8. Aspirational references if provided: how the brand wants to feel relative to those.",
    "",
    "INPUT CONTEXT:",
    `Brand: ${args.company.name}`,
    args.userFacingDescription ? `Description: ${args.userFacingDescription}` : "",
    audience ? `Audience: ${audience}` : "",
    tones ? `Tones (declared): ${tones}` : "",
    palette ? `Primary palette: ${palette}` : "",
    "",
    `User's 1-sentence visual style answer: ${args.visualStyle}`,
    aspirationalNames ? `Aspirational brands (from user): ${aspirationalListWithStatus}` : "Aspirational brands: (none provided)",
    args.antiPatterns.length > 0
      ? `Anti-patterns (from user): ${args.antiPatterns.join("; ")}`
      : "Anti-patterns: (none provided)",
    `Curated visual assets approved by user: ${args.curationCount} item(s).`,
    "",
    "Now write the brief.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildFallbackBrief(args: {
  company: Company;
  visualStyle: string;
  antiPatterns: string[];
  aspirationalRefs: Array<{ name: string }>;
}): string {
  const c = args.company as Company & { palettes?: string[] };
  const palette = (c.palettes ?? []).join(", ") || "(palette unspecified)";
  const aspirational =
    args.aspirationalRefs.length > 0
      ? `Aspirational references: ${args.aspirationalRefs.map((r) => r.name).join(", ")}.`
      : "";
  const antis =
    args.antiPatterns.length > 0
      ? `Avoid: ${args.antiPatterns.join("; ")}.`
      : "";
  return [
    `Brand visual identity for ${args.company.name}. ${args.visualStyle}`,
    `Primary palette: ${palette}.`,
    aspirational,
    antis,
    "Use these signals consistently across all generated visuals.",
  ]
    .filter((s) => s.length > 0)
    .join(" ");
}

interface BuildActionsArgs {
  curationItems: CurationItem[];
  aspirationalRefs: Array<{ name: string; source_url: string; og_image_url: string | null; fetched_ok: boolean }>;
  clearAiImageStyles: boolean;
}

/**
 * Decide which of the 3 brand folders will receive at least one asset,
 * so we can skip creating the folders that would land empty. Aspirational
 * og:images count toward "elements" because that is where they land by
 * default (they're inspiration references, not the brand's own templates
 * nor anti-patterns).
 */
function computeIntentsWithContent(args: BuildActionsArgs): {
  templates: boolean;
  elements: boolean;
  anti_patterns: boolean;
} {
  const intents = { templates: false, elements: false, anti_patterns: false };
  for (const item of args.curationItems) {
    if (item.classification === "skip") continue;
    if (item.source === "aspirational_brand_og") {
      const ref = args.aspirationalRefs.find((r) => r.name === item.aspirational_brand_name);
      if (!ref || !ref.fetched_ok || !ref.og_image_url) continue;
    }
    if (item.classification === "template") intents.templates = true;
    else if (item.classification === "anti_pattern") intents.anti_patterns = true;
    else intents.elements = true;
  }
  return intents;
}

function buildProposedActionsForDraft(args: BuildActionsArgs): ProposedAction[] {
  const out: ProposedAction[] = [];

  // 1. Folders at order=10. ONLY create the folders that will receive at
  //    least one curated asset (counting both curation.items the user
  //    approved and aspirational og:images that successfully fetched and
  //    will be tagged as elements). Empty folders are the worst possible
  //    artifact: the user sees __brand_templates / __brand_elements /
  //    __brand_anti_patterns sitting empty in Followr after setup and
  //    legitimately thinks the tool failed. Better to omit the folder
  //    entirely; a later refresh (propose_brand_template_refresh,
  //    manufacture_brand_templates) recreates it on demand when actual
  //    content lands.
  const intentNeeded = computeIntentsWithContent(args);
  if (intentNeeded.templates) {
    out.push({
      kind: "create_folder",
      order: 10,
      human_description: "Crear folder __brand_templates (composiciones aprobadas).",
      payload: { name: "__brand_templates", intent: "templates" },
    });
  }
  if (intentNeeded.elements) {
    out.push({
      kind: "create_folder",
      order: 10,
      human_description: "Crear folder __brand_elements (logos, iconos, patrones).",
      payload: { name: "__brand_elements", intent: "elements" },
    });
  }
  if (intentNeeded.anti_patterns) {
    out.push({
      kind: "create_folder",
      order: 10,
      human_description: "Crear folder __brand_anti_patterns (lo que NO querés ver).",
      payload: { name: "__brand_anti_patterns", intent: "anti_patterns" },
    });
  }

  // 2. One upload per curated item (order=20 for url/svg, order=30 for aspirational og).
  let index = 0;
  for (const item of args.curationItems) {
    if (item.classification === "skip") continue;
    const intent: "templates" | "elements" | "anti_patterns" =
      item.classification === "template"
        ? "templates"
        : item.classification === "anti_pattern"
          ? "anti_patterns"
          : "elements";
    const auto = autoClassifyAsset({
      source: item.source,
      alt: item.alt ?? null,
      src_hint: item.src_hint ?? null,
      size_hint: item.size_hint ?? null,
    });
    const tags = (item.tag_override && item.tag_override.length > 0
      ? item.tag_override
      : auto.suggested_tags) as BrandTag[];

    if (item.source === "scraped_svg") {
      const filename = item.filename_hint ?? `brand-svg-${index}.svg`;
      out.push({
        kind: "upload_svg_to_folder",
        order: 20,
        human_description: `Subir SVG inline ${filename} a __brand_${intent}.`,
        payload: { svg_content: item.svg_content, target_intent: intent, filename, tags },
      });
    } else if (item.source === "aspirational_brand_og") {
      const ref = args.aspirationalRefs.find((r) => r.name === item.aspirational_brand_name);
      if (!ref || !ref.fetched_ok || !ref.og_image_url) {
        // Skip silently; the agent has the fetch status in aspirational_fetch_results.
        index += 1;
        continue;
      }
      const filename = item.filename_hint ?? `aspirational-${ref.name.toLowerCase().replace(/\s+/g, "-")}.jpg`;
      out.push({
        kind: "fetch_og_image_then_upload",
        order: 30,
        human_description: `Descargar og:image de ${ref.name} (${ref.source_url}) y subir a __brand_${intent}.`,
        payload: { og_image_url: ref.og_image_url, target_intent: intent, filename, tags },
      });
    } else if (item.source === "user_upload" && item.image_data) {
      const filename = item.filename_hint ?? `user-upload-${index}.png`;
      out.push({
        kind: "upload_data_to_folder",
        order: 20,
        human_description: `Subir imagen adjunta del usuario (${filename}) a __brand_${intent}.`,
        payload: { image_data: item.image_data, target_intent: intent, filename, tags },
      });
    } else {
      const filename = item.filename_hint ?? `brand-${item.source}-${index}.png`;
      out.push({
        kind: "upload_url_to_folder",
        order: 20,
        human_description: `Subir ${item.source} (${item.url}) a __brand_${intent}.`,
        payload: { url: item.url, target_intent: intent, filename, tags },
      });
    }
    index += 1;
  }

  // 3. Update company description with the block at order=90 (after all
  //    uploads succeed, so the block can reference real asset ids).
  out.push({
    kind: "update_company_description",
    order: 90,
    human_description: "Persistir bloque BRAND_VISUAL_IDENTITY en Company.description con folder ids y asset_tag_map.",
    payload: {},
  });

  // 4. Optionally clear ai_image_styles at order=95.
  if (args.clearAiImageStyles) {
    out.push({
      kind: "clear_ai_image_styles",
      order: 95,
      human_description: "Limpiar Company.ai_image_styles a [] (campo vestigial; evita confusión visual en la UI).",
      payload: {},
    });
  }

  return out;
}

function renderDraftPreviewMarkdown(args: {
  companyName: string;
  draft: { proposed_identity: BrandVisualIdentity; proposed_actions: ProposedAction[]; brief_synthesis_words: number; brief_synthesis_ai_result_id: number | null };
  aspirationalRefs: Array<{ name: string; source_url: string; fetched_ok: boolean; og_image_url: string | null }>;
}): string {
  const i = args.draft.proposed_identity;
  const lines: string[] = [];
  lines.push(`### Brand Visual Identity preview para ${args.companyName}`);
  lines.push("");
  lines.push("**Brief sintetizado:**");
  lines.push("");
  lines.push("> " + i.brief_text.replace(/\n/g, "\n> "));
  lines.push("");
  if (i.palette_primary.length > 0) {
    lines.push(`**Paleta primaria (Followr UI, max 3):** ${i.palette_primary.join(", ")}`);
  }
  if (i.anti_patterns_text.length > 0) {
    lines.push("");
    lines.push("**Anti-patterns:**");
    for (const a of i.anti_patterns_text) lines.push(`- ${a}`);
  }
  if (i.aspirational_brands.length > 0) {
    lines.push("");
    lines.push("**Marcas aspiracionales:**");
    for (const r of args.aspirationalRefs) {
      const status = r.fetched_ok && r.og_image_url ? "✅ og:image listo" : "⚠️ no se pudo obtener og:image";
      lines.push(`- ${r.name} (${r.source_url}) ${status}`);
    }
  }
  lines.push("");
  lines.push("**Qué va a quedar en cada folder de Followr:**");
  const uploadActions = args.draft.proposed_actions.filter((a) =>
    ["upload_url_to_folder", "upload_data_to_folder", "upload_svg_to_folder", "fetch_og_image_then_upload"].includes(
      a.kind,
    ),
  );
  const folderCounts = { templates: 0, elements: 0, anti_patterns: 0 };
  for (const a of uploadActions) {
    const intent = String(a.payload["target_intent"]) as keyof typeof folderCounts;
    if (intent in folderCounts) folderCounts[intent] += 1;
  }
  const folderLabel = (n: number) => (n === 0 ? "0 items (no se va a crear)" : `${n} item${n === 1 ? "" : "s"}`);
  lines.push(`- __brand_templates: ${folderLabel(folderCounts.templates)}`);
  lines.push(`- __brand_elements: ${folderLabel(folderCounts.elements)}`);
  lines.push(`- __brand_anti_patterns: ${folderLabel(folderCounts.anti_patterns)}`);
  if (folderCounts.templates === 0 && folderCounts.elements === 0 && folderCounts.anti_patterns === 0) {
    lines.push("");
    lines.push(
      "⚠️ Ninguna folder va a recibir contenido en este draft. El bloque de identidad va a quedar persistido en la descripción de la marca, pero la biblioteca queda sin assets curados. Opciones para mejorar antes de ejecutar:",
    );
    lines.push("- Subir 1-2 imágenes propias (logo en alta, screenshot del producto, foto del equipo).");
    lines.push(
      "- Aprobar al menos 1-2 candidatos del scrape (logos, heros, gallery, svgs) en el paso de curación.",
    );
    lines.push(
      "- Después de ejecutar el setup base, generar templates con AI (Phase 1, ~13 imágenes, costo en créditos a confirmar) para llenar __brand_templates.",
    );
  }
  lines.push("");
  lines.push("**Acciones que voy a ejecutar al confirmar:**");
  for (const a of args.draft.proposed_actions) {
    lines.push(`- ${a.human_description}`);
  }
  lines.push("");
  if (args.draft.brief_synthesis_ai_result_id !== null) {
    lines.push(`*Sintetización del brief: ${args.draft.brief_synthesis_words} palabras usadas del ai_text_budget (AI result #${args.draft.brief_synthesis_ai_result_id}).*`);
  } else {
    lines.push("*Brief generado con fallback determinístico (no se pudo llamar a Followr text AI; texto más corto pero usable).*");
  }
  lines.push("");
  lines.push("¿Confirmás? Decí 'dale', 'ejecutalo' o 'sí' para que ejecute. Si querés ajustar algo, decímelo y armamos un draft nuevo.");
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────
// Execute tool helpers
// ──────────────────────────────────────────────────────────

const FOLLOWR_SVG_MIME = "image/svg+xml";

/**
 * Upload an inline SVG (raw string content) to Followr via the 3-step flow.
 * Mirrors uploadFromUrl but skips the initial HTTP download step. When
 * folderId is provided, the asset is created directly under that folder
 * (single round trip, verified 2026-05-23). When omitted or null, the
 * asset lands at the company root.
 */
async function uploadSvgInline(
  client: FollowrClient,
  companyId: number,
  svgContent: string,
  filename: string,
  folderId: number | null = null,
): Promise<Asset> {
  const safeFilename = filename.endsWith(".svg") ? filename : `${filename}.svg`;
  const buffer = Buffer.from(svgContent, "utf-8");
  const asset = await client.createAsset(companyId, {
    name: safeFilename,
    type: "image",
    ...(folderId !== null ? { folder_id: folderId } : {}),
  });
  const upload = await client.requestAssetUpload(asset.id, "image", {
    filename: safeFilename,
    type: "image",
    visibility: "public",
  });
  await client.uploadToBlob(upload.presigned_url, buffer, FOLLOWR_SVG_MIME);
  return { ...asset, url: upload.url };
}

function resolveFolderId(
  intent: "templates" | "elements" | "anti_patterns",
  ctx: FolderIdContext,
): number | null {
  if (intent === "templates") return ctx.folderIdTemplates;
  if (intent === "elements") return ctx.folderIdElements;
  return ctx.folderIdAntiPatterns;
}

interface FolderIdContext {
  folderIdTemplates: number | null;
  folderIdElements: number | null;
  folderIdAntiPatterns: number | null;
}

/**
 * Resolve a brand folder id for the given intent on a company, creating
 * the folder lazily if it does not exist yet AND patching the identity
 * block on Company.description so the next read sees the new folder id.
 *
 * This is the "lazy folder creation" path that complements the selective
 * folder creation in execute_brand_visual_identity. The setup tool only
 * creates the folders that have curated content at execute time;
 * downstream tools (manufacture_brand_templates, apply_brand_template_refresh,
 * future refresh tools) call this helper when they need a destination
 * folder. Without it, those tools would dump generated assets at the
 * company root forever, and the user would never see a __brand_templates
 * folder appear in Followr's media library, even after generating dozens
 * of templates.
 *
 * Returns the resolved folder id (existing or freshly created), or null
 * if both the block read and the create call failed (caller falls back
 * to leaving the asset unfiled, which is cosmetically wrong but does not
 * block the user).
 */
async function ensureBrandFolder(
  client: FollowrClient,
  companyId: number,
  intent: "templates" | "elements" | "anti_patterns",
): Promise<number | null> {
  const folderName =
    intent === "templates"
      ? "__brand_templates"
      : intent === "elements"
        ? "__brand_elements"
        : "__brand_anti_patterns";

  try {
    const company = await client.getCompany(companyId);
    const parsed = parseBrandIdentityFromDescription(company.description ?? null);
    if (parsed.status === "ok") {
      const existing = parsed.identity.folders?.[intent] ?? null;
      if (existing) return existing;
    }

    // Block did not have a folder id for this intent. Try to detect an
    // existing folder by convention first (the user might have created
    // one manually from Followr UI between sessions).
    const folders = await client.listFolders(companyId, { pageSize: 100 });
    const conventional = findFolderByConventionalName(folders, BRAND_FOLDER_NAMES[intent]);
    if (conventional) {
      if (parsed.status === "ok") {
        await patchIdentityFolderId(client, companyId, parsed.identity, intent, conventional.id);
      }
      return conventional.id;
    }

    // Truly missing. Create it.
    const folder = await client.createFolder(companyId, { name: folderName });
    if (parsed.status === "ok") {
      await patchIdentityFolderId(client, companyId, parsed.identity, intent, folder.id);
    }
    return folder.id;
  } catch {
    return null;
  }
}

async function patchIdentityFolderId(
  client: FollowrClient,
  companyId: number,
  identity: BrandVisualIdentity,
  intent: "templates" | "elements" | "anti_patterns",
  folderId: number,
): Promise<void> {
  try {
    const updated: BrandVisualIdentity = {
      ...identity,
      folders: { ...identity.folders, [intent]: folderId },
    };
    const company = await client.getCompany(companyId);
    const newDescription = appendBrandIdentityToDescription(
      company.description ?? null,
      updated,
    );
    await client.updateCompany(companyId, { description: newDescription });
  } catch {
    // Best-effort. If the patch fails the folder still exists and the
    // next ensureBrandFolder call will pick it up via the conventional
    // name detection path.
  }
}

async function maybeMoveAssetToFolder(
  client: FollowrClient,
  assetId: number,
  intent: "templates" | "elements" | "anti_patterns",
  ctx: FolderIdContext,
): Promise<void> {
  const targetFolder =
    intent === "templates"
      ? ctx.folderIdTemplates
      : intent === "elements"
        ? ctx.folderIdElements
        : ctx.folderIdAntiPatterns;
  if (!targetFolder) return;
  // The previous version of this helper was a no-op (left assets at the
  // company root), so when the user inspected Followr the __brand_*
  // folders looked empty even after a successful execute. We now PUT the
  // folder_id explicitly via the verified endpoint (see assets.md,
  // verified 2026-05-23). Errors are still tolerated because folder
  // placement is cosmetic (the resolver picks assets by tag_map on
  // Company.description, not by folder): on the rare API failure the
  // asset still exists in the library and tagged in the brand identity
  // block, the user can move it manually from Followr's media UI.
  try {
    await client.assignAssetToFolder(assetId, targetFolder);
  } catch {
    // best-effort; asset remains at company root.
  }
}

function countByIntent(uploaded: Array<{ folder_intent: "templates" | "elements" | "anti_patterns" }>): {
  templates: number;
  elements: number;
  anti_patterns: number;
} {
  let templates = 0;
  let elements = 0;
  let anti_patterns = 0;
  for (const u of uploaded) {
    if (u.folder_intent === "templates") templates += 1;
    else if (u.folder_intent === "elements") elements += 1;
    else if (u.folder_intent === "anti_patterns") anti_patterns += 1;
  }
  return { templates, elements, anti_patterns };
}

// ──────────────────────────────────────────────────────────
// Manufacture (F2.8) helpers
// ──────────────────────────────────────────────────────────

// Canonical category names used internally. "launch" replaced "hero" on
// 2026-05-24 to remove the ambiguity with BRAND_TAGS.HERO (the asset tag for
// real hero shots from the site). RawTemplateCategory below preserves the
// legacy "hero" input so older agent prompts that pass "hero" keep working
// during the transition; we map it to "launch" before doing anything with it.
type TemplateCategory = "cover" | "step" | "cta" | "feature" | "quote" | "launch";
type RawTemplateCategory = TemplateCategory | "hero";

function normalizeTemplateCategory(raw: RawTemplateCategory): TemplateCategory {
  return raw === "hero" ? "launch" : raw;
}

function templateTagForCategory(category: TemplateCategory): BrandTag {
  switch (category) {
    case "cover":
      return BRAND_TAGS.COVER_TEMPLATE;
    case "step":
      return BRAND_TAGS.STEP_TEMPLATE;
    case "cta":
      return BRAND_TAGS.CTA_TEMPLATE;
    case "feature":
      return BRAND_TAGS.FEATURE_TEMPLATE;
    case "quote":
      return BRAND_TAGS.QUOTE_TEMPLATE;
    case "launch":
      return BRAND_TAGS.LAUNCH_TEMPLATE;
  }
}

/**
 * Per-image cost in credits, by image model. Mirrors the catalog in
 * content-plan-catalog.ts; kept in sync defensively. Falls back to 25 cr
 * (nano_banana_2 baseline) for unknown models.
 */
function perImageCostFor(modelId: string): number {
  // Mirrors IMAGE_MODELS in lib/content-plan-catalog.ts. Synced 2026-05-22
  // against the Followr frontend React state (Fix E3). All model_ids here
  // are the canonical ones the backend accepts.
  const table: Record<string, number> = {
    nano_banana_2: 25,
    nano_banana: 12,
    nano_banana_pro: 45,
    gpt_image_2: 70,
    "gpt-image-1-auto": 10,
    imagen4_preview: 12,
    imagen4_preview_fast: 6,
    ideogram_v3: 18,
    wan_25_preview: 15,
    "flux_pro_1.1": 12,
    flux_pro_kontext: 12,
    flux_dev: 8,
    seedream_v4: 10,
    recraftv3: 3,
    z_image_turbo: 2,
  };
  return table[modelId] ?? 25;
}

/**
 * Pick reference image URLs for a template category. Always includes the
 * logo if present. Adds category-specific assets:
 *   cover:  logo + hero(s)
 *   step:   logo + icon(s) + pattern
 *   cta:    logo + pattern
 *   feature: logo + product + hero
 *   quote:  logo only
 *   launch: logo + hero + aspirational
 *
 * Capped at 5 references to fit nano_banana_2's effective input limit.
 *
 * Live-read: pickBrandReferenceAssetIds hits listAssets per tag, so manual
 * uploads to __brand_elements / __brand_templates (via the Followr UI) are
 * picked up immediately. The JSON asset_tag_map is metadata only; the folder
 * is the source of truth. This mirrors the live-read picker used by the
 * content plan resolver (content-plan.ts:pickBrandReferenceUrls).
 */
async function pickReferenceUrlsForCategory(
  client: FollowrClient,
  companyId: number,
  identity: BrandVisualIdentity,
  assetIdToUrl: Map<number, string>,
  category: TemplateCategory,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const addByTag = async (tag: BrandTag, limit: number): Promise<void> => {
    let added = 0;
    const ids = await pickBrandReferenceAssetIds(client, companyId, identity, tag);
    for (const id of ids) {
      if (added >= limit) break;
      const url = assetIdToUrl.get(id);
      if (!url || seen.has(url)) continue;
      out.push(url);
      seen.add(url);
      added += 1;
    }
  };

  // Logo always (max 1).
  await addByTag(BRAND_TAGS.LOGO, 1);

  // Category-specific.
  switch (category) {
    case "cover":
      await addByTag(BRAND_TAGS.HERO, 2);
      await addByTag(BRAND_TAGS.PATTERN, 1);
      break;
    case "step":
      await addByTag(BRAND_TAGS.ICON, 2);
      await addByTag(BRAND_TAGS.PATTERN, 1);
      break;
    case "cta":
      await addByTag(BRAND_TAGS.PATTERN, 2);
      await addByTag(BRAND_TAGS.ICON, 1);
      break;
    case "feature":
      await addByTag(BRAND_TAGS.PRODUCT, 2);
      await addByTag(BRAND_TAGS.HERO, 1);
      break;
    case "quote":
      // Quote slides are typography-heavy; reference logo + character only.
      await addByTag(BRAND_TAGS.CHARACTER, 1);
      break;
    case "launch":
      // Launch / flagship pieces: pull HERO asset references (real hero
      // shots from the site) plus an aspirational reference for the
      // cinematic mood. Note: BRAND_TAGS.HERO here is the asset tag, not
      // the renamed template tag (BRAND_TAGS.LAUNCH_TEMPLATE); both are
      // intentionally referenced from this case.
      await addByTag(BRAND_TAGS.HERO, 2);
      await addByTag(BRAND_TAGS.ASPIRATIONAL, 1);
      break;
  }

  // Fallback: if we didn't reach at least 2 refs (e.g. brand has only logo),
  // pad with any aspirational refs we have to give the model SOMETHING.
  if (out.length < 2) {
    await addByTag(BRAND_TAGS.ASPIRATIONAL, 2);
  }

  return out.slice(0, 5);
}

interface TemplatePromptArgs {
  identity: BrandVisualIdentity;
  category: TemplateCategory;
  variation: number;
}

function buildTemplatePrompt(args: TemplatePromptArgs): string {
  const i = args.identity;
  const palette = i.palette_primary.concat(i.palette_extended).slice(0, 6).join(", ");
  const antis =
    i.anti_patterns_text.length > 0 ? i.anti_patterns_text.join("; ") : "";
  const typography =
    i.typography_style_text.length > 0 ? i.typography_style_text : "(typography style unspecified)";

  const categoryInstructions = TEMPLATE_CATEGORY_BRIEFS[args.category];
  const variationHint = TEMPLATE_VARIATION_HINTS[args.variation - 1] ?? "";

  const lines: string[] = [];
  lines.push(
    `Generate a SOCIAL MEDIA POST IMAGE TEMPLATE for the brand below. This image will be used as a reference template for future post generations, so it should embody the brand's visual identity strongly.`,
  );
  lines.push("");
  lines.push(`BRAND BRIEF:`);
  lines.push(i.brief_text);
  lines.push("");
  if (palette.length > 0) lines.push(`PALETTE (hex codes to use): ${palette}.`);
  lines.push(`TYPOGRAPHY CHARACTER: ${typography}.`);
  if (antis.length > 0) lines.push(`AVOID (anti-patterns): ${antis}.`);
  lines.push("");
  lines.push(`CATEGORY: ${args.category.toUpperCase()} TEMPLATE`);
  lines.push(`Composition instructions for this category:`);
  lines.push(categoryInstructions);
  if (variationHint) {
    lines.push("");
    lines.push(`Variation hint (variation #${args.variation}): ${variationHint}`);
  }
  lines.push("");
  lines.push(
    `IMPORTANT: do NOT include any placeholder text on the image. Specifically, NO 'lorem ipsum', NO 'placeholder', NO 'title preview', NO 'your text here', NO 'sample text', NO broken-image icons, NO dummy chat bubbles, NO grey image placeholders. Leave text areas blank or use abstract typography blocks for headline placement; the actual text is overlaid at publish time, not now.`,
  );
  return lines.join("\n");
}

const TEMPLATE_CATEGORY_BRIEFS: Record<TemplateCategory, string> = {
  cover:
    "Cover slide for a multi-slide carousel. Bold headline area near the top or center (LEFT BLANK; text gets overlaid later). Brand logo subtly placed in a corner. Background uses the palette's dominant color or a brand-aligned gradient. Composition: generous negative space, balanced visual weight, strong focal point. Aspect-ready to be paired with sibling slides.",
  step:
    "Step illustration slide (think 'Step 1 of 3'). Large bold number area in top-left or top-right corner (LEFT BLANK; number text gets overlaid later). Below the number, a clean visual mockup or illustration showing the step's concept (calendar, message bubble, button, etc.). Brand palette accents. Minimalist UI style consistent across siblings.",
  cta:
    "Call-to-action closing slide (final slide of a carousel). Arrow or directional cue pointing toward the action. Central headline area (LEFT BLANK; CTA text gets overlaid later). Brand logo prominent. Background simple, palette-driven, draws attention toward the center.",
  feature:
    "Single feature highlight slide. One prominent visual element (product / capability / mockup) in the focal center. Supporting space around it for caption text (LEFT BLANK). Brand palette accents. Composition draws the eye to the feature.",
  quote:
    "Quote / testimonial slide. Large quote-marks visible at top-left or as decoration. Central area for the quote text (LEFT BLANK). Subtle attribution space at the bottom. Typography-heavy aesthetic. Palette mostly neutral with one brand accent.",
  launch:
    "Launch / flagship slide. Cinematic composition. Large bold visual element (product, scene, abstract shape) center or left. Bold headline space (LEFT BLANK). Brand palette as dominant background. Should feel like a magazine cover or product launch announcement. Format-agnostic: works as a stand-alone single-image post, as the cover of a carousel, or as the poster frame for a video.",
};

const TEMPLATE_VARIATION_HINTS = [
  "Variation A: balanced composition, centered focal element, symmetric layout.",
  "Variation B: asymmetric composition, focal element offset to one side, dynamic negative space.",
  "Variation C: layered composition with overlapping elements, depth via blur or scale variance.",
];
