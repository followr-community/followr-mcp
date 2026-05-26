// Translation layer entre dos enums de aspect ratio que conviven en el sistema.
//
// HISTORIA: cuando descubrimos `POST /api/companies/{id}/creative` (Creative
// Studio) el 2026-05-25 vimos que el enum de aspect_ratio del endpoint es
// distinto del enum que usamos en `/api/aiResults/image` y en
// `content-plan-state.ts`. Específicamente:
//
//   MCP content_plan / aiResults/image: "1:1" | "4:3" | "16:9" | "3:4" | "9:16"
//   Creative Studio API:                 "1:1" | "4:5" | "9:16" | "16:9" | "2:3"
//
// Tres ratios son comunes (1:1, 9:16, 16:9). Los otros dos son distintos:
// MCP tiene 4:3 / 3:4 (clásicos), Creative Studio tiene 4:5 / 2:3 (social
// media moderno). Para no forzar al agente a aprender DOS enums según el
// destino, este helper traduce el enum standard (MCP) al de Creative Studio.

/** Aspect ratio del enum estándar del MCP (content_plan, aiResults/image). */
export type StandardAspectRatio = "1:1" | "4:3" | "16:9" | "3:4" | "9:16";

/** Aspect ratio del enum específico de Creative Studio API. */
export type CreativeStudioAspectRatio = "1:1" | "4:5" | "9:16" | "16:9" | "2:3";

/**
 * Traduce un aspect_ratio standard al equivalente más cercano del enum de
 * Creative Studio. Mappings:
 *
 *   1:1  → 1:1  (exacto)
 *   9:16 → 9:16 (exacto)
 *   16:9 → 16:9 (exacto)
 *   3:4  → 4:5  (vertical, closest match. 4:5 es ligeramente menos vertical
 *                que 3:4 pero es el único vertical-ish disponible en Creative
 *                Studio salvo 9:16 que es full-portrait)
 *   4:3  → 16:9 (landscape, fallback. Creative Studio NO tiene 4:3 ni nada
 *                close-landscape salvo 16:9; aceptamos el ligero estiramiento
 *                horizontal vs forzar 1:1 que cambiaría drasticamente la
 *                composición)
 */
export function toCreativeStudioAspectRatio(
  standard: StandardAspectRatio,
): CreativeStudioAspectRatio {
  switch (standard) {
    case "1:1":
      return "1:1";
    case "9:16":
      return "9:16";
    case "16:9":
      return "16:9";
    case "3:4":
      return "4:5";
    case "4:3":
      return "16:9";
  }
}

/**
 * Traduce un aspect_ratio de Creative Studio al equivalente más cercano del
 * enum standard. Inverso del helper anterior. Útil cuando el agent recibe un
 * aspect_ratio en formato Creative Studio (ej: del POST body capturado de la
 * UI) y quiere persistirlo en content-plan-state.
 *
 *   1:1  → 1:1  (exacto)
 *   9:16 → 9:16 (exacto)
 *   16:9 → 16:9 (exacto)
 *   4:5  → 3:4  (vertical, closest)
 *   2:3  → 3:4  (vertical más alto, también closest a 3:4 vs 9:16)
 */
export function fromCreativeStudioAspectRatio(
  creativeStudio: CreativeStudioAspectRatio,
): StandardAspectRatio {
  switch (creativeStudio) {
    case "1:1":
      return "1:1";
    case "9:16":
      return "9:16";
    case "16:9":
      return "16:9";
    case "4:5":
      return "3:4";
    case "2:3":
      return "3:4";
  }
}

/**
 * Sugerencia de aspect_ratio standard según el social network target.
 * Refleja la tabla en `content-plan.ts:1638`. Cuando el agent sabe a qué
 * red va el creative, esto le ahorra preguntar al user.
 *
 * Si el post va a múltiples redes, el caller debería elegir el "lowest
 * common denominator". 1:1 funciona para casi todas las plataformas.
 */
export function suggestedAspectRatioForNetwork(
  network: string,
): StandardAspectRatio {
  const n = network.toLowerCase();
  // Stories / Reels / TikTok / YouTube Shorts → full vertical
  if (
    n.includes("story") ||
    n.includes("reel") ||
    n === "tiktok" ||
    n.includes("short")
  ) {
    return "9:16";
  }
  // LinkedIn / Facebook / Instagram post → 1:1 (square, más versátil)
  if (
    n.includes("linkedin") ||
    n.includes("facebook") ||
    n.includes("instagram")
  ) {
    return "1:1";
  }
  // X / Twitter / YouTube long → 16:9
  if (n.includes("twitter") || n.includes("x_") || n === "x" || n.includes("youtube")) {
    return "16:9";
  }
  // Pinterest → vertical 3:4 (Creative Studio usará 4:5 más cercano)
  if (n.includes("pinterest")) {
    return "3:4";
  }
  // Default safe: 1:1 funciona en todas las plataformas mainstream
  return "1:1";
}
