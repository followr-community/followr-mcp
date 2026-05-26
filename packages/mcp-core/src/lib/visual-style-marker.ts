// Marker pattern para persistir el visual style preferido de la company.
//
// Reemplaza el flow viejo de BVI.recommended_visual_style (que vivía dentro
// del bloque JSON BrandVisualIdentity). Decisión arquitectural 2026-05-25:
// el bloque BVI fue mayormente dead data en la nueva arquitectura (Creative
// Studio no consume estructuradamente sus fields, solo el text de
// company.description). Lo único que realmente importa persistir es el
// style_key elegido, y eso cabe en un marker de ~50 caracteres.
//
// Pattern matches el marker [industry:X@date] que escribe deep_research
// para la industria (otro caso de "una key simple persistida en
// company.description como suffix"). Coexisten sin conflicto.
//
// FORMATO: [visual_style:<slug>@YYYY-MM-DD]
//   - slug: uno de los 32 del catálogo (lib/creative-studio-styles.ts) o
//     "ai_decides".
//   - date: ISO calendar date del último set (no incluye time, no necesario).
//
// EJEMPLOS:
//   [visual_style:bold_typography@2026-05-25]
//   [visual_style:ai_decides@2026-05-26]
//
// COEXISTENCIA: company.description puede tener:
//   <descripción natural>
//   [industry:saas@2026-05-25]
//   [visual_style:minimalist_clean@2026-05-25]
// Ambos markers son independientes; cada uno se persiste y se lee por separado.
//
// TTL: no aplicamos TTL al visual_style (a diferencia del industry que
// expira en 30 días). El usuario lo cambia explícitamente vía
// confirm_visual_style cuando quiere.

const MARKER_RE = /\[visual_style:([a-z0-9_]+)@(\d{4}-\d{2}-\d{2})\]/i;

// Más estricto al strippear: incluye el trailing whitespace para no dejar
// renglones vacíos cuando removemos el marker (mismo enfoque que el
// stripBrandIdentityFromDescription que existía antes).
const MARKER_STRIP_RE = /\n*\s*\[visual_style:[a-z0-9_]+@\d{4}-\d{2}-\d{2}\]\s*/i;

/** Slug y fecha persistidos del último confirm_visual_style. */
export interface ParsedVisualStyleMarker {
  /** El slug del style (uno del catálogo o "ai_decides"). */
  slug: string;
  /** ISO calendar date (YYYY-MM-DD) en que se decidió. */
  decided_at: string;
}

/**
 * Lee el marker `[visual_style:X@YYYY-MM-DD]` de la descripción de la
 * company. Devuelve null si no hay marker o si el shape es inválido.
 *
 * Tolerante a descripciones null / undefined / vacías (devuelve null sin
 * errorear).
 */
export function parseVisualStyleMarker(
  description: string | null | undefined,
): ParsedVisualStyleMarker | null {
  if (!description || typeof description !== "string") return null;
  const m = description.match(MARKER_RE);
  if (!m) return null;
  const slug = m[1];
  const date = m[2];
  if (!slug || !date) return null;
  return { slug, decided_at: date };
}

/**
 * Construye el suffix del marker para un slug dado, con la fecha de hoy.
 * Exportado por si algún consumer quiere construir el string manual sin
 * pasar por appendVisualStyleMarker.
 */
export function buildVisualStyleMarker(slug: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `[visual_style:${slug}@${today}]`;
}

/**
 * Devuelve una description NUEVA con el marker pegado al final (o
 * reemplazado in-place si ya existía uno). Maneja:
 *   - description null / undefined → devuelve solo el marker
 *   - description sin marker → appendea con doble newline separador
 *   - description con marker → reemplaza el marker existente
 *
 * NO toca otros markers (industry, BVI legacy block, etc.) que puedan
 * coexistir en la misma description.
 */
export function appendVisualStyleMarker(
  description: string | null | undefined,
  slug: string,
): string {
  const suffix = buildVisualStyleMarker(slug);
  const desc = (description ?? "").trim();
  if (MARKER_RE.test(desc)) {
    return desc.replace(MARKER_RE, suffix);
  }
  return desc.length > 0 ? `${desc.trimEnd()}\n\n${suffix}` : suffix;
}

/**
 * Devuelve una description NUEVA sin el marker visual_style. Útil para
 * casos donde queremos limpiar el preferido (ej: futuro tool unset_visual_style).
 * Hoy no se usa pero existe para simetría con appendVisualStyleMarker.
 */
export function stripVisualStyleMarker(
  description: string | null | undefined,
): string {
  const desc = description ?? "";
  return desc.replace(MARKER_STRIP_RE, "").trim();
}
