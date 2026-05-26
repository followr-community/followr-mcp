// Visual Styles catalog para Creative Studio (POST /api/companies/{id}/creative).
//
// Followr expone 32 visual styles curados por su equipo de producto, organizados
// en 3 buckets (MOST POPULAR, TRENDING, EMERGING). NO hay un endpoint público
// para listarlos, así que esta constante es la copia local que el MCP usa para:
//
//   1. list_visual_styles  → mostrar los 32 al user con name+description+preview
//   2. generate_brand_creative → validar el style_key que el agente pasa
//   3. (futuro) detect_brand_visual_style → pasar la lista al classifier LLM
//
// SINC: si Followr agrega/quita styles, este file queda desactualizado y los
// agentes pueden pasar slugs que ya no existen (o no ver los nuevos). Strategy
// de mantenimiento: re-scrapear el bundle frontend periódicamente o pedir al
// equipo de Followr un endpoint público (gap conocido).
//
// Verificación empírica original: 2026-05-25 (followr-mcp via claude-in-chrome).

export interface VisualStyle {
  /** Slug que va al campo `style_key` del POST /api/companies/{id}/creative. */
  slug: string;
  /** Display name (Ej: "Minimalist Clean"). Usar siempre al hablar con el user, nunca el slug. */
  name: string;
  /** Descripción corta para que el user entienda el feel del style. */
  description: string;
  /** Bucket en la UI de Creative Studio. Solo para ranking/orden, no afecta funcionalmente. */
  bucket: "most_popular" | "trending" | "emerging";
  /**
   * URL pública de la imagen preview hosteada en el CDN de Followr.
   * Es la misma imagen que se ve en la modal "Choose Visual Style" de la UI.
   * NO requiere auth.
   *
   * Pattern: https://followr.blob.core.windows.net/develop/creative-studio/style-previews/{slug}.png
   *
   * NOTA: la URL incluye `develop` en el path. En producción podría cambiar a
   * `prod` o similar. Si Followr cambia el host/prefix, hay que actualizar
   * PREVIEW_BASE_URL abajo (cambio en 1 lugar, no por entry).
   */
  preview_url: string;
}

export const PREVIEW_BASE_URL =
  "https://followr.blob.core.windows.net/develop/creative-studio/style-previews";

function buildPreviewUrl(slug: string): string {
  return `${PREVIEW_BASE_URL}/${slug}.png`;
}

/**
 * Catálogo completo de los 32 visual styles de Creative Studio.
 *
 * Orden: misma secuencia que la UI (MOST POPULAR primero por uso, luego
 * TRENDING, después EMERGING). Mantener ese orden ayuda al ranking default
 * de list_visual_styles.
 *
 * Descripciones: tomadas del DOM de la UI (algunas truncadas con "..."
 * por overflow CSS). Las versiones completas viven server-side en el
 * diccionario de Followr y NO están expuestas vía API. Para usos donde el
 * descriptor completo importa (ej: pasarlo al classifier LLM), pedir al
 * equipo de Followr el JSON oficial.
 */
export const VISUAL_STYLES: readonly VisualStyle[] = [
  // MOST POPULAR (8)
  {
    slug: "minimalist_clean",
    name: "Minimalist Clean",
    description: "Clean white space with thin typography and single accent color",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("minimalist_clean"),
  },
  {
    slug: "bold_typography",
    name: "Bold Typography",
    description: "Oversized bold text as the focal point with dramatic hierarchy",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("bold_typography"),
  },
  {
    slug: "gradient_vibrant",
    name: "Gradient / Vibrant",
    description: "Vivid gradient backgrounds with smooth color transitions",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("gradient_vibrant"),
  },
  {
    slug: "bold_hook_3d",
    name: "Bold Hook 3D",
    description: "High-impact 3D headline with depth and theatrical lighting",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("bold_hook_3d"),
  },
  {
    slug: "bold_statement",
    name: "Bold Statement",
    description: "Single statement headline at maximum scale, minimal surroundings",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("bold_statement"),
  },
  {
    slug: "glassmorphism",
    name: "Glassmorphism",
    description: "Frosted-glass layers with soft blurs over vibrant backgrounds",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("glassmorphism"),
  },
  {
    slug: "neo_brutalism",
    name: "Neo Brutalism",
    description: "Hard edges, raw blocks of color, intentionally rough geometric layouts",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("neo_brutalism"),
  },
  {
    slug: "photorealistic",
    name: "Photorealistic Product",
    description: "Studio-quality product photography with controlled lighting",
    bucket: "most_popular",
    preview_url: buildPreviewUrl("photorealistic"),
  },
  // TRENDING (8)
  {
    slug: "flat_material",
    name: "Flat / Material",
    description: "Solid color blocks with geometric shapes and material-design feel",
    bucket: "trending",
    preview_url: buildPreviewUrl("flat_material"),
  },
  {
    slug: "3d_claymorphism",
    name: "3D / Claymorphism",
    description: "Soft 3D clay-like elements with rounded surfaces",
    bucket: "trending",
    preview_url: buildPreviewUrl("3d_claymorphism"),
  },
  {
    slug: "photo_overlay",
    name: "Lifestyle Photo Overlay",
    description: "Full-bleed photo with gradient text zone",
    bucket: "trending",
    preview_url: buildPreviewUrl("photo_overlay"),
  },
  {
    slug: "magazine_cover",
    name: "Magazine Cover",
    description: "Hero photo with editorial masthead banner",
    bucket: "trending",
    preview_url: buildPreviewUrl("magazine_cover"),
  },
  {
    slug: "split_screen",
    name: "Split Screen Duo",
    description: "Half photo, half bold color panel with headline",
    bucket: "trending",
    preview_url: buildPreviewUrl("split_screen"),
  },
  {
    slug: "dark_luxury",
    name: "Dark Luxury",
    description: "Deep dark background with cream or gold accents",
    bucket: "trending",
    preview_url: buildPreviewUrl("dark_luxury"),
  },
  {
    slug: "text_container",
    name: "Text Container / Card",
    description: "Geometric text container on photo or gradient backdrop",
    bucket: "trending",
    preview_url: buildPreviewUrl("text_container"),
  },
  {
    slug: "retro_futurism",
    name: "Retro Futurism",
    description: "Synthwave colors with chrome elements",
    bucket: "trending",
    preview_url: buildPreviewUrl("retro_futurism"),
  },
  // EMERGING (16)
  {
    slug: "cyberpunk_neon",
    name: "Cyberpunk / Neon",
    description: "Dark backgrounds with electric neon glows",
    bucket: "emerging",
    preview_url: buildPreviewUrl("cyberpunk_neon"),
  },
  {
    slug: "watercolor_organic",
    name: "Watercolor / Organic",
    description: "Soft watercolor textures with flowing organic shapes",
    bucket: "emerging",
    preview_url: buildPreviewUrl("watercolor_organic"),
  },
  {
    slug: "pop_art",
    name: "Pop Art",
    description: "Bold halftone dots with primary colors",
    bucket: "emerging",
    preview_url: buildPreviewUrl("pop_art"),
  },
  {
    slug: "vintage_heritage",
    name: "Vintage / Heritage",
    description: "Aged textures with heritage typography",
    bucket: "emerging",
    preview_url: buildPreviewUrl("vintage_heritage"),
  },
  {
    slug: "isometric_3d",
    name: "Isometric 3D",
    description: "Isometric perspective with geometric 3D objects",
    bucket: "emerging",
    preview_url: buildPreviewUrl("isometric_3d"),
  },
  {
    slug: "mixed_media",
    name: "Mixed Media Collage",
    description: "Cut-and-paste collage with mixed sources",
    bucket: "emerging",
    preview_url: buildPreviewUrl("mixed_media"),
  },
  {
    slug: "editorial_cinematic",
    name: "Editorial / Cinematic",
    description: "Wide cinematic frame with editorial typography",
    bucket: "emerging",
    preview_url: buildPreviewUrl("editorial_cinematic"),
  },
  {
    slug: "bento_grid",
    name: "Bento Grid",
    description: "Bento box layout with asymmetric compartments",
    bucket: "emerging",
    preview_url: buildPreviewUrl("bento_grid"),
  },
  {
    slug: "lo_fi_diy",
    name: "Lo-Fi / DIY",
    description: "Handmade aesthetic with notebook sketches",
    bucket: "emerging",
    preview_url: buildPreviewUrl("lo_fi_diy"),
  },
  {
    slug: "solarpunk",
    name: "Solarpunk",
    description: "Lush greenery with technology and hopeful tone",
    bucket: "emerging",
    preview_url: buildPreviewUrl("solarpunk"),
  },
  {
    slug: "vaporwave",
    name: "Vaporwave",
    description: "Pastel gradients with retro computing aesthetic",
    bucket: "emerging",
    preview_url: buildPreviewUrl("vaporwave"),
  },
  {
    slug: "art_deco",
    name: "Art Deco",
    description: "Geometric patterns with gold accents",
    bucket: "emerging",
    preview_url: buildPreviewUrl("art_deco"),
  },
  {
    slug: "grunge_distressed",
    name: "Grunge / Distressed",
    description: "Grunge textures with scratched surfaces",
    bucket: "emerging",
    preview_url: buildPreviewUrl("grunge_distressed"),
  },
  {
    slug: "duotone",
    name: "Duotone",
    description: "Two-color gradient overlay with high contrast",
    bucket: "emerging",
    preview_url: buildPreviewUrl("duotone"),
  },
  {
    slug: "paper_cut",
    name: "Paper Cut",
    description: "Layered paper cut effect with dimensionality",
    bucket: "emerging",
    preview_url: buildPreviewUrl("paper_cut"),
  },
  {
    slug: "neon_noir",
    name: "Neon Noir",
    description: "Film noir atmosphere with neon signage",
    bucket: "emerging",
    preview_url: buildPreviewUrl("neon_noir"),
  },
] as const;

/**
 * Special slug que el backend acepta para que él mismo elija el style.
 * Cuando el user no tiene preferencia o no encontró ningún match, esta
 * es la opción safe.
 */
export const AI_DECIDES_SLUG = "ai_decides" as const;

/** Set rápido de los slugs válidos (incluye AI_DECIDES_SLUG). */
export const VALID_STYLE_SLUGS: ReadonlySet<string> = new Set([
  ...VISUAL_STYLES.map((s) => s.slug),
  AI_DECIDES_SLUG,
]);

/** True si el slug existe en el catálogo (o es el especial ai_decides). */
export function isValidStyleSlug(slug: string): boolean {
  return VALID_STYLE_SLUGS.has(slug);
}

/** Lookup de un VisualStyle por slug. Devuelve null si no existe. */
export function getStyleBySlug(slug: string): VisualStyle | null {
  return VISUAL_STYLES.find((s) => s.slug === slug) ?? null;
}

/**
 * Devuelve los styles agrupados por bucket en el orden de presentación
 * default (most_popular primero). Útil para list_visual_styles que quiere
 * mostrar al user los 32 organizados.
 */
export function getStylesByBucket(): {
  most_popular: VisualStyle[];
  trending: VisualStyle[];
  emerging: VisualStyle[];
} {
  return {
    most_popular: VISUAL_STYLES.filter((s) => s.bucket === "most_popular"),
    trending: VISUAL_STYLES.filter((s) => s.bucket === "trending"),
    emerging: VISUAL_STYLES.filter((s) => s.bucket === "emerging"),
  };
}

/**
 * Devuelve un batch de N styles para mostrar al user en una iteración del
 * flow de propuesta (propose_visual_style_options). El batch sale del orden
 * default del catálogo y excluye los slugs ya mostrados.
 *
 * @param exclude  Set de slugs ya propuestos al user (que NO querramos repetir).
 * @param batchSize  Cuántos styles devolver en este batch. Default 3.
 *
 * Devuelve también `remaining_after_batch` (cuántos quedan sin proponer
 * después de este batch) y `exhausted` (true si ya no hay más para mostrar).
 */
export function nextBatchOfStyles(
  exclude: ReadonlySet<string>,
  batchSize = 3,
): {
  batch: VisualStyle[];
  remaining_after_batch: number;
  exhausted: boolean;
} {
  const available = VISUAL_STYLES.filter((s) => !exclude.has(s.slug));
  const batch = available.slice(0, batchSize);
  const remaining_after_batch = Math.max(0, available.length - batch.length);
  return {
    batch,
    remaining_after_batch,
    exhausted: available.length === 0,
  };
}
