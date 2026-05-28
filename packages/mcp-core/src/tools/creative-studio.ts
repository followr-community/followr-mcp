// MCP tools for the Creative Studio endpoint (POST /api/companies/{id}/creative).
//
// SHAPE
//
//   list_visual_styles            READ_ONLY        Devuelve los 32 visual
//                                                  styles disponibles con
//                                                  preview_url. El agente
//                                                  los muestra al user con
//                                                  thumbnails.
//
//   propose_visual_style_options  READ_ONLY        Devuelve el siguiente
//                                                  batch de N styles
//                                                  excluyendo los ya
//                                                  propuestos. Para el flow
//                                                  iterativo de "te muestro
//                                                  estos 3, si no te gusta
//                                                  te muestro otros 3".
//
//   generate_brand_creative       MUTATION_OPEN_   Wrappea POST /api/companies/
//                                 WORLD            {id}/creative + polling.
//                                                  El user-facing nombre es
//                                                  "template" (no "Creative
//                                                  Studio").
//
// FUTURE (no incluidas en esta iteración):
//
//   detect_brand_visual_style    Auto-detecta el primary style usando
//                                /api/openai/imageCaption sobre signals
//                                visuales + classifier text LLM.
//   confirm_visual_style         Persiste el primary style en el BVI block
//                                para que `generate_brand_creative` lo use
//                                como default cuando el user no pasa style_key.

import type { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import {
  AI_DECIDES_SLUG,
  VISUAL_STYLES,
  getStyleBySlug,
  getStylesByBucket,
  isValidStyleSlug,
  nextBatchOfStyles,
} from "../lib/creative-studio-styles.js";
import {
  type StandardAspectRatio,
  toCreativeStudioAspectRatio,
} from "../lib/aspect-ratio-translate.js";
import { scrapeBrandSignalsFromWebsite } from "../lib/brand-website-scraper.js";
import { patchContextsForCompany } from "../lib/content-plan-state.js";
import {
  createPipeline,
  markPipelineCompleted,
  markPipelineFailed,
  updatePipelinePhase,
} from "../lib/pipeline-state.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";
import {
  appendVisualStyleMarker,
  parseVisualStyleMarker,
} from "../lib/visual-style-marker.js";
import { uploadFromUrl } from "./assets.js";

// ──────────────────────────────────────────────────────────────────────
// Costos. Estos números son del UI a 2026-05-25 (verificados empíricamente).
// Si Followr cambia pricing, actualizar acá. El cost gate del tool usa
// estos valores para mostrarle al user antes de generar.
// ──────────────────────────────────────────────────────────────────────

const CREDITS_PER_SLIDE_DEFAULT_MODEL = 25; // nano_banana_2
const CREDITS_PER_SLIDE_PRO_MODEL = 45; // nano_banana_pro

function perSlideCostForModel(model: string): number {
  if (model === "nano_banana_pro") return CREDITS_PER_SLIDE_PRO_MODEL;
  return CREDITS_PER_SLIDE_DEFAULT_MODEL;
}

// ──────────────────────────────────────────────────────────────────────
// Default aspect ratios standard (MCP enum). El tool acepta este enum y
// traduce internamente al de Creative Studio. Documentado en
// `lib/aspect-ratio-translate.ts`.
// ──────────────────────────────────────────────────────────────────────

const StandardAspectRatioSchema = z
  .enum(["1:1", "4:3", "16:9", "3:4", "9:16"])
  .describe(
    "Aspect ratio of the generated creative. Uses the standard MCP enum (same as content_plan and generate_image). Translated internally to Creative Studio's enum (1:1/4:5/9:16/16:9/2:3): 3:4 → 4:5 (vertical), 4:3 → 16:9 (landscape fallback). Default 1:1 (most versatile across networks).",
  );

// ──────────────────────────────────────────────────────────────────────

export function registerCreativeStudioTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions = {},
): void {
  // ────────────────────────────────────────────────────────────────────
  // list_visual_styles
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_visual_styles",
    {
      annotations: READ_ONLY,
      title: "List the 32 visual style templates available in Followr",
      description: `Returns the 32 visual style templates that Creative Studio (the brand template engine) accepts. Each style has a slug, display name, short description, and a preview image URL.

USE THIS when:
- The user wants to see the available templates / styles before picking one.
- The agent needs to show options with thumbnails to the user.
- After detect (when implemented) didn't find a confident match, fallback to showing the full catalog ranked.

OUTPUT shape (per style): { slug, name, description, bucket, preview_url }.

The preview_url is a public PNG showing what the style looks like applied to a generic example. USE IT INLINE when surfacing the style to the user (the user CANNOT pick from a slug alone, they need to see the visual).

GROUPING: styles are organized in three buckets (most_popular, trending, emerging). The output groups them so the agent can present them ordered.

NEVER show the slug (e.g. "bold_typography") to the user as the primary label. Use the display name ("Bold Typography") and embed the preview_url image. The slug is only for the agent to pass to generate_brand_creative.

PRIVACY: there is no per-user customization here. All companies see the same 32 styles.`,
      inputSchema: {},
    },
    async () => {
      try {
        const grouped = getStylesByBucket();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: VISUAL_STYLES.length,
                  by_bucket: {
                    most_popular: grouped.most_popular,
                    trending: grouped.trending,
                    emerging: grouped.emerging,
                  },
                  special_slug: {
                    slug: AI_DECIDES_SLUG,
                    name: "AI Decides",
                    description: "Let Followr pick the best style based on the prompt and brand context. No preview.",
                  },
                  user_facing_summary: `Tu marca puede usar uno de ${VISUAL_STYLES.length} templates curados por el equipo de Followr. Te los muestro agrupados (8 más populares, 8 trending, 16 emerging). Cada uno con su preview visual para que veas el estilo antes de elegir.`,
                  _assistant_guidance: {
                    next_step: "show_styles_with_previews_inline",
                    instructions:
                      "When presenting these styles to the user, ALWAYS include the preview_url image inline so they see what the style looks like. NEVER reference a style by its slug alone (slugs are internal). Use the display name ('Bold Typography', 'Minimalist Clean', etc.). If the user picks one, remember its slug and pass it to generate_brand_creative on the next call. If they don't like any from the popular bucket, offer trending or emerging.",
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
  // propose_visual_style_options
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "propose_visual_style_options",
    {
      annotations: READ_ONLY,
      title: "Propose the next batch of visual style options to show the user",
      description: `Returns the next N visual styles (defaulting to 3) from the catalog, excluding any slugs already shown. Use this in an iterative "show 3, ask, show 3 more if rejected" flow.

PATTERN:
1. First call: propose_visual_style_options() → returns batch of 3 styles (the top 3 from most_popular).
2. Agent shows them to user with preview_url images inline + display names. Asks: "te gusta alguno?"
3. If user rejects: agent calls propose_visual_style_options({ exclude_slugs: [<the 3 already shown>] }) → next 3.
4. Repeat until user picks one or exhausted is true.

When exhausted is true: tell the user "probaste todos los ${VISUAL_STYLES.length} templates y ninguno te gusta. Dos opciones: (a) elegimos el más cercano de los que vimos, (b) lo dejamos así y cuando generes contenido el sistema decide por sí solo." Don't loop forever.

NEVER show a style without its preview_url image to the user. Slugs are internal.`,
      inputSchema: {
        exclude_slugs: z
          .array(z.string())
          .optional()
          .describe(
            "Slugs already shown to the user in previous batches (to exclude from this batch). Pass the running set across calls.",
          ),
        batch_size: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("How many styles to return in this batch. Default 3."),
      },
    },
    async ({ exclude_slugs, batch_size }) => {
      try {
        const exclude = new Set(exclude_slugs ?? []);
        const result = nextBatchOfStyles(exclude, batch_size ?? 3);
        const totalShownAfter = exclude.size + result.batch.length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  batch: result.batch,
                  batch_count: result.batch.length,
                  remaining_after_batch: result.remaining_after_batch,
                  exhausted: result.exhausted,
                  total_shown_after_this_batch: totalShownAfter,
                  catalog_total: VISUAL_STYLES.length,
                  user_facing_summary: result.exhausted
                    ? `Ya viste los ${VISUAL_STYLES.length} templates disponibles. No quedan más para proponer.`
                    : `Te muestro ${result.batch.length} ${result.batch.length === 1 ? "opción" : "opciones"} más (${result.remaining_after_batch} quedan después de éstas).`,
                  _assistant_guidance: result.exhausted
                    ? {
                        next_step: "user_exhausted_offer_alternatives",
                        instructions:
                          "El catálogo se agotó. NO sigas llamando propose_visual_style_options. Ofrecé al user dos paths: (a) elegir el closest match de los que ya viste y proceder con generate_brand_creative pasando ese slug, (b) dejar que el sistema decida solo (no pasar style_key explícito en generate_brand_creative, el endpoint elige). Mostrá ambas opciones en lenguaje natural.",
                      }
                    : {
                        next_step: "show_batch_with_previews_then_ask",
                        instructions:
                          "Mostrá las imágenes preview_url INLINE en tu próxima respuesta (UNA por style, no thumbnails chiquititas). Listalas con sus display names. Pregunta: '¿te gusta alguno?' Si no, llamame de nuevo con exclude_slugs actualizado (incluyendo los slugs de este batch + los anteriores). Si te elige uno, pasá ese slug a generate_brand_creative cuando el user pida generar.",
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
  // generate_brand_creative
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "generate_brand_creative",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Generate a brand-aware creative image or carousel using a visual style template",
      description: `Generates one or more brand-aware creative images (single image OR multi-slide carousel) using a visual style template. The brand's logo and colors are auto-injected. The literal copy (headline, subheadline, CTA text) is invented by an internal text AI based on the brand context + prompt.

USE THIS for: ad-hoc one-off creatives outside the content plan flow. Examples: the user asks "armame una imagen suelta para esta semana", "necesito un carrusel rápido sobre X" without going through draft_content_plan, or "regenerá esta pieza puntual del feed con otro estilo".

DO NOT USE THIS to pre-generate plan assets. execute_content_plan ALREADY routes ai_generate image sources to Creative Studio automatically when model is nano_banana_2 / nano_banana_pro (the default) and use_creative_studio is true (the default). The visual_style marker set by confirm_visual_style is read and applied as style_key automatically. Pre-generating here and referencing by asset_id duplicates work and spends credits early. If the plan was drafted with model: "ideogram_v3" (or any other CS-incompatible model) and the user fixed a visual style afterwards, the correct fix is update_content_plan to switch those plan_items to nano_banana_2, NOT pre-generate with this tool.

DO NOT USE THIS for (use generate_image instead):
- Avatar background images
- Reference images for AI video generation
- Pure product photos / lifestyle photos without copy overlay
- Generic illustrations without brand context
- Image-to-image where a real photo is the input and you want the model to riff on it (Creative Studio's image_urls is for "include literally", not style ref)

USER-FACING LANGUAGE: when speaking to the user, refer to this as "tu template" or "el template", NEVER "Creative Studio", NEVER the tool name. Examples:
  Good: "voy a generar tu template con el estilo Bold Typography"
  Good: "armando el carousel con tu template"
  Bad:  "calling generate_brand_creative with style_key=bold_typography"
  Bad:  "Creative Studio está procesando"

COST: 25 credits per slide with default model (nano_banana_2). 45 cr with nano_banana_pro. A 3-slide carousel = 75 cr. A 5-slide carousel = 125 cr. Surface the total cost to the user before confirming for multi-slide generations.

POLLING: this tool waits internally until all slides are completed (or one fails). Typical latency: 30-60s for single, 90-180s for carousel. If the wait times out the tool returns an error with the creative_id so the agent can poll manually later.

OUTPUT: each generated slide includes its CDN URL plus an asset_id for the freshly-uploaded copy in the company's asset library (we re-upload the AI Result so the user can use it in posts immediately).

PREREQUISITE: the company should have brand colors and a logo set in Followr (Company Settings → Brand). The tool reads Company.description as brand_context. Without a logo, the include_brand_logo flag is silently ignored.

REGISTERS the asset in the company's Media Library. The user can then reference these images in posts via create_post.`,
      inputSchema: {
        company_id: z
          .number()
          .int()
          .positive()
          .describe("Followr company id to generate the creative for."),
        prompt: z
          .string()
          .min(3)
          .max(2000)
          .describe(
            "User-facing description of what the creative should be about (topic, intent, audience). NOT the literal copy that will appear on the image. Example good: 'Cover slide for a B2B SaaS post about productivity tips for founders'. The internal text AI will INVENT punchy copy (e.g., 'BOOST B2B SALES FLOW') based on this + the brand context.",
          ),
        style_key: z
          .string()
          .optional()
          .describe(
            "Visual style slug from list_visual_styles. If omitted, the backend chooses ('ai_decides' equivalent). Recommended: surface options via list_visual_styles or propose_visual_style_options first and let the user pick.",
          ),
        content_type: z
          .enum(["single_creative", "carousel"])
          .default("single_creative")
          .describe(
            "single_creative = 1 image. carousel = multi-slide with narrative continuity. Backend enum confirmed empirically 2026-05-27 by intercepting the Followr UI: the value 'single' (documented earlier) is REJECTED with 'The selected content type is invalid.'; the correct value is 'single_creative'. 'auto' is also not a valid backend value; the UI label 'AI Decides' translates to one of the two concrete values internally.",
          ),
        slide_count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(1)
          .describe(
            "Number of slides. Must be 1 when content_type=single. For carousel typical values: 3 (announcement), 5 (tips/listicle), 7 (tutorial). Default 1.",
          ),
        aspect_ratio: StandardAspectRatioSchema.default("1:1"),
        model: z
          .enum(["nano_banana_2", "nano_banana_pro"])
          .default("nano_banana_2")
          .describe(
            "Image model. nano_banana_2 = 25 cr/slide (default). nano_banana_pro = 45 cr/slide (better quality, slower).",
          ),
        include_brand_logo: z
          .boolean()
          .default(true)
          .describe(
            "When true the backend passes the brand's logo as a reference image to the model with instruction to place it in the design. Requires the company to have a logo asset tagged brand:logo. Default true.",
          ),
        use_brand_colors: z
          .boolean()
          .default(true)
          .describe(
            "When true the backend injects the company palette hex values into the prompt. Default true.",
          ),
        reference_images: z
          .array(z.string().url())
          .optional()
          .describe(
            "Optional URLs of images to INCLUDE literally in the creative (image-to-image). Use when the user wants a specific product/screenshot/element shown in the design. NOT for style references (use style_key for that). Up to 4 URLs typical.",
          ),
        save_to_media_library: z
          .boolean()
          .default(true)
          .describe(
            "When true (default) we re-upload each generated slide to the company's asset library so it gets a stable asset_id usable in create_post. When false the slides only live as AI Result CDN URLs (which work but aren't yet in the library).",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Required to be true when slide_count > 1 (multi-slide carousels). Single-slide generations don't need explicit confirm (cost is bounded and predictable). Pass after the user has approved the total cost.",
          ),
        wait: z
          .boolean()
          .optional()
          .describe(
            "If omitted: smart default. Single-slide (slide_count=1) defaults to wait:true (returns the URL inline; typical 30-60s). Multi-slide carousels default to wait:false (returns a pipeline_id + ETA; carousels take 2-5+ min and risk the claude.ai transport timeout). To override: pass wait:true to always block, wait:false to always async.",
          ),
      },
    },
    async ({
      company_id,
      prompt,
      style_key,
      content_type,
      slide_count,
      aspect_ratio,
      model,
      include_brand_logo,
      use_brand_colors,
      reference_images,
      save_to_media_library,
      confirm,
      wait,
    }) => {
      try {
        // ── Validation ──────────────────────────────────────────────
        if (content_type === "single_creative" && slide_count !== 1) {
          return toolError({
            reason: "invalid_slide_count",
            user_message: `content_type='single_creative' requires slide_count=1, got ${slide_count}. Pasalo a 1, o cambia content_type a 'carousel' si querés multi-slide.`,
            blocking: true,
          });
        }
        if (style_key && !isValidStyleSlug(style_key)) {
          return toolError({
            reason: "invalid_style_key",
            user_message: `El style_key "${style_key}" no es uno de los ${VISUAL_STYLES.length} válidos. Usá list_visual_styles para ver el catálogo completo, o omití el campo para que el sistema decida.`,
            suggested_actions: [
              {
                tool: "list_visual_styles",
                rationale: "Mostrá los styles disponibles al user con sus previews y dejá que elija.",
              },
            ],
            blocking: true,
          });
        }
        const totalCost = perSlideCostForModel(model) * slide_count;
        if (slide_count > 1 && confirm !== true) {
          return toolError({
            reason: "cost_confirmation_required",
            user_message: `Esta generación es de ${slide_count} slides con costo total ${totalCost} créditos (${perSlideCostForModel(model)} cr × ${slide_count}). Pedile al usuario aprobación explícita del costo y volvé a llamar generate_brand_creative con confirm: true.`,
            blocking: true,
            details: {
              slide_count,
              cost_per_slide: perSlideCostForModel(model),
              total_cost_credits: totalCost,
              model,
            },
          });
        }

        // ── Load brand context ──────────────────────────────────────
        // El backend lee company.description automáticamente cuando le mandamos
        // brand_context: undefined? No verificado todavía. Por ahora replicamos
        // el comportamiento de la UI: fetcheamos la company y mandamos
        // description como brand_context explícito.
        const company = await client.getCompany(company_id);
        const brandContext = company.description ?? "";

        // ── Resolve style_key ───────────────────────────────────────
        // Priority: explicit arg > marker en description > AI_DECIDES_SLUG
        // (El marker lo escribe confirm_visual_style. Reemplaza el BVI
        // bloque que se eliminó 2026-05-25.)
        const cachedMarker = parseVisualStyleMarker(brandContext);
        let resolvedStyleKey: string;
        let styleSource: "explicit" | "marker_cached_default" | "ai_decides_fallback";
        if (style_key) {
          resolvedStyleKey = style_key;
          styleSource = "explicit";
        } else if (cachedMarker && isValidStyleSlug(cachedMarker.slug)) {
          resolvedStyleKey = cachedMarker.slug;
          styleSource = "marker_cached_default";
        } else {
          resolvedStyleKey = AI_DECIDES_SLUG;
          styleSource = "ai_decides_fallback";
        }
        const styleInfo = getStyleBySlug(resolvedStyleKey);
        const styleDisplay =
          styleInfo?.name ??
          (resolvedStyleKey === AI_DECIDES_SLUG ? "AI Decides (el sistema elige)" : resolvedStyleKey);

        // ── Translate aspect_ratio ──────────────────────────────────
        const csAspectRatio = toCreativeStudioAspectRatio(aspect_ratio as StandardAspectRatio);

        // Closure: extract the generation body so both sync (wait:true) and
        // async (wait:false) paths share the same code.
        interface SlideOutput {
          slide_number: number;
          ai_result_id: number;
          image_url: string;
          image_thumbnail_url: string | null;
          asset_id: number | null;
          asset_save_error: string | null;
        }
        const runCreativePipeline = async (
          opts: {
            onPhase?: (info: { sub_phase: string; progress?: { completed: number; total: number } | null }) => void;
          } = {},
        ): Promise<Record<string, unknown>> => {
          opts.onPhase?.({ sub_phase: `submitting (0/${slide_count})`, progress: { completed: 0, total: slide_count } });
          const creative = await client.createCreative(company_id, {
            content_type,
            style_key: resolvedStyleKey,
            prompt,
            aspect_ratio: csAspectRatio,
            slide_count,
            model,
            brand_context: brandContext,
            include_brand_logo,
            use_brand_colors,
            image_urls: reference_images && reference_images.length > 0 ? reference_images : null,
            carousel_format: null,
          });
          opts.onPhase?.({ sub_phase: `rendering slides (0/${slide_count})`, progress: { completed: 0, total: slide_count } });
          const final = await client.waitForCreative(creative.id, {
            expectedSlides: slide_count,
            intervalMs: 3000,
            timeoutMs: Math.max(60_000, slide_count * 60_000),
          });
          opts.onPhase?.({ sub_phase: `uploading slides (0/${final.ai_results.length})`, progress: { completed: 0, total: final.ai_results.length } });
          const slides: SlideOutput[] = [];
          for (let i = 0; i < final.ai_results.length; i++) {
            const result = final.ai_results[i];
            if (!result) continue;
            const firstImage = result.images?.[0];
            if (!firstImage?.url) {
              slides.push({
                slide_number: i + 1,
                ai_result_id: result.id,
                image_url: "",
                image_thumbnail_url: null,
                asset_id: null,
                asset_save_error: "ai_result completed but had no image URL",
              });
              continue;
            }
            let asset_id: number | null = null;
            let asset_save_error: string | null = null;
            if (save_to_media_library) {
              try {
                const asset = await uploadFromUrl(client, {
                  companyId: company_id,
                  url: firstImage.url,
                  type: "image",
                  name: `creative-${creative.id}-slide-${i + 1}.jpg`,
                });
                asset_id = asset.id;
              } catch (uploadErr) {
                asset_save_error =
                  uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
              }
            }
            slides.push({
              slide_number: i + 1,
              ai_result_id: result.id,
              image_url: firstImage.url,
              image_thumbnail_url: firstImage.thumbnail?.url ?? null,
              asset_id,
              asset_save_error,
            });
            opts.onPhase?.({ sub_phase: `uploading slides (${i + 1}/${final.ai_results.length})`, progress: { completed: i + 1, total: final.ai_results.length } });
          }
          const slidesSavedCount = slides.filter((s) => s.asset_id !== null).length;
          const slidesFailedCount = slides.filter((s) => s.asset_save_error !== null).length;
          return {
            creative_id: creative.id,
            title: creative.title,
            used_style: {
              slug: resolvedStyleKey,
              display_name: styleDisplay,
              source: styleSource,
            },
            content_type,
            slide_count,
            aspect_ratio_requested: aspect_ratio,
            aspect_ratio_sent: csAspectRatio,
            model,
            cost_credits: totalCost,
            slides,
            slides_saved_to_library: slidesSavedCount,
            slides_save_failed: slidesFailedCount,
            brand_context_warnings:
              brandContext.length > 100
                ? null
                : "La descripción de la empresa está casi vacía. La generación se hizo pero el design system puede no reflejar la marca con precisión. Pedile al user que complete description + colors + logo en Followr UI antes de hacer más generaciones.",
            user_facing_summary: `Listo. Generé ${slides.length} ${slides.length === 1 ? "imagen" : "imágenes"} con tu template ${styleDisplay}. ${slidesSavedCount > 0 ? `${slidesSavedCount} ${slidesSavedCount === 1 ? "guardada" : "guardadas"} en tu Media Library.` : ""}`,
            _assistant_guidance: {
              next_step: "show_images_inline_then_ask_user",
              instructions:
                "Mostrá las imágenes inline en tu próxima respuesta (cada slide.image_url). Pregunta al user: '¿te gustan? ¿las uso en un post o querés iterar?'. NUNCA muestres el creative_id, asset_id ni ai_result_id al user (eso es interno). Si el user dice 'usalas en un post' tenés los asset_ids para pasar a create_post. Si dice 'cambiá X' podés llamar generate_brand_creative de nuevo con un prompt ajustado (gastando otros créditos).",
            },
          };
        };

        // Smart wait default: single-slide defaults to sync (URL inline,
        // 30-60s, well below any transport limit). Multi-slide defaults to
        // async (carousels can run 2-5+ min and risk the claude.ai
        // 4-min cap). Explicit wait param overrides the default.
        const effectiveWait = wait !== undefined ? wait : slide_count <= 1;

        // === Sync mode =================================================
        if (effectiveWait) {
          const responseBody = await runCreativePipeline();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(responseBody, null, 2),
              },
            ],
          };
        }

        // === Async mode (default for multi-slide) ======================
        const estimate = Math.max(60, slide_count * 60);
        const pipeline = createPipeline({
          kind: "brand_creative",
          company_id,
          params: {
            prompt,
            style_key: resolvedStyleKey,
            content_type,
            slide_count,
            aspect_ratio,
            model,
          },
          estimated_total_seconds: estimate,
          initial_sub_phase: `queued (0/${slide_count})`,
          initial_progress: { completed: 0, total: slide_count },
        });
        const pipelineId = pipeline.pipeline_id;

        setImmediate(() => {
          void (async () => {
            try {
              updatePipelinePhase(pipelineId, {
                phase: "running",
                sub_phase: `starting (0/${slide_count})`,
              });
              const responseBody = await runCreativePipeline({
                onPhase: (info) => {
                  updatePipelinePhase(pipelineId, {
                    sub_phase: info.sub_phase,
                    ...(info.progress !== undefined ? { progress: info.progress } : {}),
                  });
                },
              });
              markPipelineCompleted(pipelineId, {
                metadata: responseBody,
              });
            } catch (err) {
              markPipelineFailed(pipelineId, {
                sub_phase: "generation",
                reason: err instanceof Error ? err.name : "Error",
                user_message: err instanceof Error ? err.message : String(err),
              });
            }
          })();
        });

        const minMinutes = Math.max(1, Math.round(estimate / 60));
        const maxMinutes = Math.max(minMinutes + 1, Math.round((estimate * 1.5) / 60));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  pipeline_id: pipelineId,
                  kind: "brand_creative",
                  company_id,
                  slide_count,
                  content_type,
                  style: { slug: resolvedStyleKey, display_name: styleDisplay, source: styleSource },
                  cost_credits: totalCost,
                  estimated_seconds: estimate,
                  user_facing_summary: `Empecé tu ${content_type === "carousel" ? "carrusel" : "imagen"} de ${slide_count} ${slide_count === 1 ? "slide" : "slides"} con template ${styleDisplay}. Va a tardar entre ${minMinutes} y ${maxMinutes} minutos. Decime "fijate" cuando quieras chequear.`,
                  _assistant_guidance: {
                    next_step: "tell_user_eta_then_wait_for_status_request",
                    conversational_flow:
                      "Mismo patrón que generate_avatar_video: get_pipeline_status (instant) cuando user pregunte, wait_for_pipeline (hasta 3 min) cuando diga 'esperá'. Cuando el pipeline complete, el field result.metadata trae el responseBody con las URLs e IDs de cada slide; mostrá las image_url inline al user.",
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
  // detect_brand_visual_style
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "detect_brand_visual_style",
    {
      annotations: READ_ONLY,
      title: "Detect a company's most fitting visual style template from its existing visual content",
      description: `Analyzes the company's existing visual evidence (website hero image, logo, screenshots of recent published posts, optional user uploads) using vision and ranks the top 3 fitting visual style templates from the 32 available.

DOES NOT PERSIST. Returns the ranked styles for the agent to present to the user with previews. After the user picks, call confirm_visual_style to persist the choice in the BVI block as the brand's default.

PIPELINE (internal):
1. Gather visual signal: website screenshot + up to 5 recent published posts with image assets + optional user upload URLs.
2. For each image URL: call /api/openai/imageCaption to get a text description (~50-150 words per image). Vision works via this dedicated endpoint, NOT via /api/aiResults/chat which is text-only.
3. Build a classifier prompt with the captions + the 32 styles + their descriptions and ask the chat AI to rank top 3.
4. Parse structured JSON response (with fallback for partial matches).

COST (estimated, surface to the user BEFORE calling): consumes ai_text_budget words for both vision captions and the classifier. Estimated total = 150 * max_signals + 250 words (default max_signals=6 → ~1150 words). Per-image credit cost adds ~1-5 cr per signal. Before calling, tell the user the estimate so they decide.

PRE-FLIGHT BUDGET CHECK. The tool now verifies ai_text_budget before spending any credits. If the plan has no text module (words_allowed === 0) it refuses with reason=feature_gated_no_text_module and suggests propose_visual_style_options / list_visual_styles as zero-cost alternatives. If the cycle budget is exhausted (remaining < estimated_words) it refuses with reason=text_budget_exhausted including the exact words required vs words remaining. Both error paths surface to the user up front, no silent HTTP 402 from the backend. Lower max_signals to fit a tighter budget (each signal removed = 150 fewer words).

LOW SIGNAL: when the company has no website OR no published posts AND no user uploads, the tool returns 'low_visual_signal: true' and a message_for_user asking for reference uploads. The agent should request 2-3 aspirational images from the user and re-call with include_uploads.

USAGE FLOW:
1. detect_brand_visual_style({ company_id }) → ranked top 3 + traits
2. Agent shows top 3 with preview_url images to the user, asks: "este es tu estilo, te gusta?"
3. If user picks one: confirm_visual_style({ company_id, primary_slug }) persists it
4. If user wants alternatives: propose_visual_style_options with exclude_slugs to iterate

INTEGRATION WITH generate_brand_creative: once confirmed, generate_brand_creative uses the cached primary_slug as default when style_key is not passed explicitly. The user no longer needs to pick a style every time.

RELATED TOOLS (named explicitly so the host's tool-search precaches them): list_visual_styles, propose_visual_style_options, confirm_visual_style, generate_brand_creative, prepare_content_plan_context, draft_content_plan.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        force_refresh: z
          .boolean()
          .optional()
          .describe(
            "If true, ignore any cached recommended_visual_style in the BVI block and re-run detection from scratch. Default false (return cached if present).",
          ),
        max_signals: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe(
            "Max number of image URLs to caption. Higher = more accurate ranking but more cost. Default 6 (1 website hero + up to 5 post assets).",
          ),
        include_uploads: z
          .array(z.string().url())
          .optional()
          .describe(
            "Optional additional reference image URLs to include in the analysis (e.g. brands the user admires, screenshots they uploaded). Useful when website/posts have low visual signal.",
          ),
      },
    },
    async ({ company_id, force_refresh, max_signals, include_uploads }) => {
      try {
        const maxSignals = max_signals ?? 6;

        // ── Load company + check cached marker ──────────────────────
        const company = await client.getCompany(company_id);
        const description = company.description ?? "";
        const cachedMarker = parseVisualStyleMarker(description);

        // Return cached if exists and not forced (zero-cost path)
        if (!force_refresh && cachedMarker && isValidStyleSlug(cachedMarker.slug)) {
          const primaryStyle = getStyleBySlug(cachedMarker.slug);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    from_cache: true,
                    cached_at: cachedMarker.decided_at,
                    ranked_styles: [
                      {
                        slug: cachedMarker.slug,
                        confidence: 1.0,
                        evidence: "Previously confirmed by user",
                        style_info: primaryStyle,
                      },
                    ],
                    user_facing_summary: `Tu estilo ya estaba guardado: ${primaryStyle?.name ?? cachedMarker.slug}. Si querés re-detectar (por ejemplo si cambió tu identidad), pasá force_refresh: true.`,
                    _assistant_guidance: {
                      next_step: "use_cached_or_offer_refresh",
                      instructions:
                        "Mostrale al user el style cacheado con su preview_url inline. Si parece OK, podés proceder a generate_brand_creative sin más prompt. Si el user dice 'cambió mi marca' o 'no me gusta', llamá detect_brand_visual_style con force_refresh: true.",
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // ── Pre-flight budget check ─────────────────────────────────
        // Vision (imageCaption) + chat (style ranker) both consume
        // ai_text_budget. Estimate ~150 words/caption + ~250 words for
        // the classifier = ~150 * maxSignals + 250 words total. Refuse
        // early with cost preview so the agent can fall back to
        // propose_visual_style_options / list_visual_styles without
        // burning credits on an HTTP 402 round-trip.
        const estimatedWords = Math.round(150 * maxSignals + 250);
        try {
          const balance = await client.getSubscriptionBalance();
          const wordsTotal = balance.words_allowed ?? 0;
          const wordsRemaining = wordsTotal - (balance.words_spent ?? 0);
          if (wordsTotal === 0) {
            return toolError({
              reason: "feature_gated_no_text_module",
              user_message: `This tool needs the AI text module (your plan doesn't include it). It would have consumed ~${estimatedWords} words for vision captions + the style classifier. Free alternatives: propose_visual_style_options (curated 3-4 for your industry) or list_visual_styles (full 32-style catalog).`,
              suggested_actions: [
                { tool: "propose_visual_style_options", rationale: "Curated 3-4 styles per industry, zero text-budget cost." },
                { tool: "list_visual_styles", rationale: "Full catalog (32 styles). User picks manually, zero cost." },
              ],
              details: {
                estimated_words_required: estimatedWords,
                words_total_on_plan: wordsTotal,
                max_signals: maxSignals,
              },
            });
          }
          if (wordsRemaining < estimatedWords) {
            return toolError({
              reason: "text_budget_exhausted",
              user_message: `This tool needs ~${estimatedWords} words but you have ${wordsRemaining} left this cycle. Either wait for the next cycle reset, or use propose_visual_style_options / list_visual_styles as zero-cost alternatives. You can also lower max_signals (current ${maxSignals}, down to 1) to fit in budget; estimated cost = 150 * max_signals + 250.`,
              suggested_actions: [
                { tool: "propose_visual_style_options", rationale: "Curated 3-4 styles, zero cost." },
                { tool: "list_visual_styles", rationale: "Full catalog, zero cost." },
              ],
              details: {
                estimated_words_required: estimatedWords,
                words_remaining: wordsRemaining,
                max_signals: maxSignals,
              },
            });
          }
        } catch {
          // If budget endpoint fails, fall through and let the AI calls
          // surface the 402 themselves. Don't block on a budget probe.
        }

        // ── Gather visual signals ───────────────────────────────────
        const signalUrls: Array<{ url: string; source: string }> = [];

        // 1. Website scrape
        if (company.website) {
          try {
            const scraped = await scrapeBrandSignalsFromWebsite(company.website);
            // Pick hero image first, then first gallery image, then logo as visual signal
            const heroUrl = scraped.hero_candidates?.[0]?.url;
            const galleryUrl = scraped.gallery_candidates?.[0]?.url;
            const logoUrl = scraped.logo_candidates?.[0]?.url;
            if (heroUrl) signalUrls.push({ url: heroUrl, source: "website_hero" });
            if (galleryUrl) signalUrls.push({ url: galleryUrl, source: "website_gallery" });
            if (logoUrl && signalUrls.length < 2) signalUrls.push({ url: logoUrl, source: "website_logo" });
          } catch {
            // Scrape failure is non-blocking; we can still use posts/uploads
          }
        }

        // 2. Recent published posts
        try {
          const groups = await client.listCompanyPostGroups(company_id, {
            sort: "-id",
            pageSize: Math.min(20, maxSignals * 2),
            draft: false,
            include: "posts,posts.assets,posts.assets.image",
            status: "published",
          });
          for (const g of groups) {
            if (signalUrls.length >= maxSignals) break;
            const posts = (g as { posts?: Array<{ assets?: Array<{ type?: string; image?: { url?: string } }> }> }).posts ?? [];
            for (const p of posts) {
              if (signalUrls.length >= maxSignals) break;
              for (const a of p.assets ?? []) {
                if (a.type !== "image") continue;
                const url = a.image?.url;
                if (!url) continue;
                signalUrls.push({ url, source: `post_group_${g.id}` });
                break;
              }
            }
          }
        } catch {
          // Posts listing failure is non-blocking
        }

        // 3. User uploads (passed explicitly)
        if (include_uploads) {
          for (const url of include_uploads) {
            if (signalUrls.length >= maxSignals) break;
            signalUrls.push({ url, source: "user_upload" });
          }
        }

        // Dedupe by URL (just in case)
        const seen = new Set<string>();
        const dedupedSignals = signalUrls.filter((s) => {
          if (seen.has(s.url)) return false;
          seen.add(s.url);
          return true;
        });

        // ── Low signal escape hatch ─────────────────────────────────
        if (dedupedSignals.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    low_visual_signal: true,
                    signals_found: 0,
                    user_facing_summary:
                      "No encontré suficiente material visual de tu marca para detectar el estilo. Necesito que me pases 2-3 imágenes de referencia (marcas que te gusten estéticamente, screenshots de landings que admires, posts de Instagram con look que querés emular).",
                    _assistant_guidance: {
                      next_step: "request_user_uploads_and_retry",
                      instructions:
                        "Pedile al user que comparta 2-3 URLs de imágenes aspiracionales (no tienen que ser de su marca, pueden ser referencias de marcas que les gustan). Cuando te las pase, llamá detect_brand_visual_style de nuevo con include_uploads: [<URLs>].",
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // ── Caption each signal via vision endpoint ─────────────────
        const captions: Array<{ url: string; source: string; caption: string }> = [];
        for (const signal of dedupedSignals.slice(0, maxSignals)) {
          try {
            const caption = await client.captionImage(signal.url);
            captions.push({ url: signal.url, source: signal.source, caption });
          } catch {
            // Individual caption failure is non-blocking
          }
        }

        if (captions.length === 0) {
          return toolError({
            reason: "vision_endpoint_unavailable",
            user_message:
              "No pude obtener descripciones visuales de ningún signal de la marca. El endpoint de vision puede estar caído o las URLs no son accesibles. Reintentá en unos minutos o pasá include_uploads con URLs públicas explícitamente.",
            blocking: true,
            details: { signals_attempted: dedupedSignals.length },
          });
        }

        // ── Build classifier prompt ─────────────────────────────────
        const stylesCatalog = VISUAL_STYLES.map(
          (s) => `- ${s.slug}: ${s.description}`,
        ).join("\n");

        const captionsList = captions
          .map((c, i) => `${i + 1}. [${c.source}] ${c.caption}`)
          .join("\n");

        // Brand description from company.description (sin markers, solo el texto
        // natural). Cap a 800 chars para no inflar el prompt.
        const briefText = (company.description ?? "")
          .replace(/\[industry:[^\]]+\]/gi, "")
          .replace(/\[visual_style:[^\]]+\]/gi, "")
          .trim()
          .slice(0, 800);

        const classifierPrompt = `Brand name: ${company.name ?? "(unknown)"}.
${briefText ? `Brand description: ${briefText}` : ""}

Visual evidence (captions of the brand's existing content):
${captionsList}

Available visual styles (32 options):
${stylesCatalog}

TASK: Rank the top 3 styles that BEST match the visual evidence above. Base the ranking on the actual visual content described, NOT on stylistic guesses or brand category alone.

OUTPUT FORMAT: respond with VALID JSON ONLY. No prose, no markdown fences, no other text. Schema:
{
  "ranked": [
    {"slug": "<one of the 32 slugs above>", "confidence": <0.0-1.0>, "evidence": "<one short sentence pointing to specific visual elements in the captions>"},
    {"slug": "...", "confidence": ..., "evidence": "..."},
    {"slug": "...", "confidence": ..., "evidence": "..."}
  ],
  "detected_traits": {
    "mood": "<one or two words>",
    "imagery_style": "<one short phrase>",
    "palette_observation": "<one short phrase>",
    "typography_observation": "<one short phrase>"
  }
}`;

        // ── Call chat classifier ────────────────────────────────────
        const chatResult = await client.generateChat({
          q: classifierPrompt,
          q_system:
            "You are a brand visual style classifier. Respond ONLY with valid JSON matching the requested schema. No prose, no markdown fences, no surrounding text. The slugs MUST be exact matches to the catalog provided.",
          company_id,
          chargeable: 1,
        });

        const responseText = chatResult.response ?? "";

        // ── Parse response ──────────────────────────────────────────
        let parsedClassifier: {
          ranked?: Array<{ slug?: string; confidence?: number; evidence?: string }>;
          detected_traits?: {
            mood?: string;
            imagery_style?: string;
            palette_observation?: string;
            typography_observation?: string;
          };
        } = {};
        try {
          // Try direct parse first
          parsedClassifier = JSON.parse(responseText);
        } catch {
          // Try to extract a JSON block from a possibly fence-wrapped or surrounded response
          const fenceMatch = responseText.match(/\{[\s\S]*\}/u);
          if (fenceMatch) {
            try {
              parsedClassifier = JSON.parse(fenceMatch[0]);
            } catch {
              // Give up; we'll fallback below
            }
          }
        }

        const rankedRaw = Array.isArray(parsedClassifier.ranked)
          ? parsedClassifier.ranked
          : [];
        const ranked = rankedRaw
          .filter((r): r is { slug: string; confidence: number; evidence: string } =>
            typeof r?.slug === "string" &&
            isValidStyleSlug(r.slug) &&
            typeof r?.confidence === "number" &&
            typeof r?.evidence === "string",
          )
          .slice(0, 5)
          .map((r) => ({
            slug: r.slug,
            confidence: Math.max(0, Math.min(1, r.confidence)),
            evidence: r.evidence.slice(0, 300),
            style_info: getStyleBySlug(r.slug),
          }));

        if (ranked.length === 0) {
          return toolError({
            reason: "classifier_returned_no_valid_styles",
            user_message:
              "El clasificador devolvió una respuesta que no pude parsear o no contenía slugs válidos del catálogo. Probá force_refresh: true, o pedile al user que elija manualmente vía list_visual_styles.",
            blocking: false,
            details: {
              raw_response_preview: responseText.slice(0, 500),
              captions_count: captions.length,
            },
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  from_cache: false,
                  signals_captioned: captions.length,
                  signal_sources: captions.map((c) => c.source),
                  ranked_styles: ranked,
                  detected_traits: parsedClassifier.detected_traits ?? null,
                  user_facing_summary: `Detecté tu estilo. El que más se acerca: ${ranked[0]?.style_info?.name ?? ranked[0]?.slug} (confidence ${Math.round((ranked[0]?.confidence ?? 0) * 100)}%). Tenés ${ranked.length - 1} alternativas también.`,
                  _assistant_guidance: {
                    next_step: "show_top_ranked_with_previews_then_confirm_or_iterate",
                    instructions:
                      "Mostrale al user TOP 1-3 styles con sus preview_url images inline (no slugs). Pregunta: '¿te gusta el primero? Si no, te muestro las alternativas o vamos a otros del catálogo'. Cuando confirme uno, llamá confirm_visual_style con su slug. Si no le gusta ninguno de los 3, llamá propose_visual_style_options con exclude_slugs incluyendo los 3 mostrados.",
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
  // confirm_visual_style
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "confirm_visual_style",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Persist the user's chosen visual style template as the brand's default",
      description: `After the agent has shown style options to the user (via list_visual_styles, propose_visual_style_options, or detect_brand_visual_style) and the user picked one, this tool persists that choice in the Brand Visual Identity block as the company's default visual style. Future calls to generate_brand_creative without an explicit style_key will use this as the default.

PRECONDITION: the company must have a Brand Visual Identity block already configured (i.e. execute_brand_visual_identity has run). If missing, the tool returns an error blocking and instructs the agent to run assess → draft → execute first.

The persistence uses PUT /api/companies/{id} with the company description merged (replaces the BVI block in place). Idempotent: re-calling with a different slug just updates the field.

USE THIS when:
- detect_brand_visual_style returned a ranking and the user confirmed the top result
- propose_visual_style_options surfaced N batches and the user picked one
- The user explicitly said "usá X de ahora en más" / "mi estilo es Bold Typography"

DO NOT USE THIS for one-off overrides. If the user just wants this particular creative in a different style, pass style_key directly to generate_brand_creative without confirming. Confirm only when the user is committing to a default for future generations.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        primary_slug: z
          .string()
          .min(1)
          .describe(
            "The chosen visual style slug. Must be one of the 32 in the catalog OR 'ai_decides'.",
          ),
        ranked_alternatives: z
          .array(
            z.object({
              slug: z.string().min(1),
              confidence: z.number().min(0).max(1),
            }),
          )
          .max(5)
          .optional()
          .describe(
            "Top alternative styles (from detect_brand_visual_style output) to remember alongside the primary. Useful so the agent can offer 'el segundo más cercano fue X' without re-detecting. Max 5.",
          ),
        evidence_summary: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Human-readable rationale for why this style matches the brand (from detection output or user input). Optional. Surfaced when the agent explains the choice in future sessions.",
          ),
        source: z
          .enum(["detection", "user_choice", "manual"])
          .default("user_choice")
          .describe(
            "How the choice was made. 'detection' = pure auto-detection result. 'user_choice' = user picked from a proposed list (default). 'manual' = user typed/specified the slug directly.",
          ),
      },
    },
    async ({ company_id, primary_slug, ranked_alternatives, evidence_summary, source }) => {
      try {
        if (!isValidStyleSlug(primary_slug)) {
          return toolError({
            reason: "invalid_style_key",
            user_message: `El slug "${primary_slug}" no es uno de los ${VISUAL_STYLES.length} válidos ni el especial 'ai_decides'. Usá list_visual_styles para ver el catálogo.`,
            blocking: true,
          });
        }
        // Validate alternatives too
        if (ranked_alternatives) {
          for (const alt of ranked_alternatives) {
            if (!isValidStyleSlug(alt.slug)) {
              return toolError({
                reason: "invalid_style_key_in_alternatives",
                user_message: `Una de las alternativas ("${alt.slug}") no es un slug válido. Quitala o reemplazala por uno del catálogo.`,
                blocking: true,
              });
            }
          }
        }

        const company = await client.getCompany(company_id);
        const description = company.description ?? "";

        // Persistencia simple via marker [visual_style:slug@date] en
        // company.description. Reemplaza el bloque BVI viejo. Ver
        // lib/visual-style-marker.ts para el formato.
        //
        // NOTA: el campo `source`, `ranked_alternatives` y `evidence_summary`
        // del input ya no se persisten (el marker es minimal). El agent puede
        // pasarlos para tracking pero solo el primary_slug + fecha quedan en el
        // marker. Si en el futuro necesitamos persistir más metadata,
        // extendemos el marker o agregamos otro pattern.
        void source;
        void ranked_alternatives;
        void evidence_summary;

        const newDescription = appendVisualStyleMarker(description, primary_slug);
        await client.updateCompany(company_id, { description: newDescription });
        // Patch cached content-plan contexts in place instead of evicting
        // them. The only field that changes is has_visual_style_marker;
        // brief, budget, networks, etc. did not. Evicting would force the
        // agent to re-call prepare_content_plan_context just to flip this
        // single bool, which is exactly the round-trip the PipeLime
        // 2026-05-28 session paid (draft_content_plan failed with
        // context_id_invalid_or_expired). See patchContextsForCompany.
        patchContextsForCompany(company_id, { has_visual_style_marker: true });

        const styleInfo = getStyleBySlug(primary_slug);
        const displayName =
          styleInfo?.name ??
          (primary_slug === AI_DECIDES_SLUG ? "AI Decides" : primary_slug);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: true,
                  primary_style: {
                    slug: primary_slug,
                    display_name: displayName,
                    preview_url: styleInfo?.preview_url ?? null,
                  },
                  alternatives_saved: 0,
                  decided_at: new Date().toISOString().slice(0, 10),
                  user_facing_summary: `Listo. Guardé tu template como ${displayName}. De ahora en más, cada vez que generes contenido con generate_brand_creative voy a usar ese estilo por default (a menos que pidas otro específicamente).`,
                  _assistant_guidance: {
                    next_step: "confirm_to_user_and_optionally_test",
                    instructions:
                      "Avisale al user que el template quedó guardado, con su preview_url image inline. Ofrecé probarlo generando 1 creative de prueba (25 cr) si quiere validar el look antes de usarlo en serio.",
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
}
