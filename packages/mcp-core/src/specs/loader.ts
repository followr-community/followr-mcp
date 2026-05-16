/**
 * Spec registry loader.
 *
 * Reads `data/social-network-specs.json` once at module load and exposes
 * helpers for accessing specs by (network, product_type) or by raw key.
 */

import specsJson from "../data/social-network-specs.json" with { type: "json" };
import type {
  NetworkSpecEntry,
  NetworkSpecsRegistry,
  NetworkType,
  ProductType,
  SpecKey,
  SpecsMeta,
} from "./types.js";

// Single cast at the import boundary. The JSON is the source of truth; the
// types are an interface over it. Excess properties (e.g. `_note` annotations)
// are deliberately ignored by the typed API.
const REGISTRY = specsJson as unknown as NetworkSpecsRegistry;

/** Get the spec entry for a (network, product_type) pair. Returns null if missing. */
export function getSpec(network: NetworkType, productType: ProductType): NetworkSpecEntry | null {
  const key = `${network}_${productType}` satisfies SpecKey;
  return REGISTRY[key] ?? null;
}

/** Get the spec by raw key. Returns null if the key isn't a known spec. */
export function getSpecByKey(key: string): NetworkSpecEntry | null {
  if (key.startsWith("_")) return null;
  const map = REGISTRY as Record<string, NetworkSpecEntry | SpecsMeta | undefined>;
  const entry = map[key];
  if (!entry || isMeta(entry)) return null;
  return entry;
}

/** Enumerate all spec keys present in the registry (excludes _meta). */
export function listSpecKeys(): SpecKey[] {
  return Object.keys(REGISTRY).filter((k) => !k.startsWith("_")) as SpecKey[];
}

/** Read spec metadata (verified_at, source, etc.). */
export function getSpecsMeta(): SpecsMeta | undefined {
  return REGISTRY._meta;
}

function isMeta(entry: NetworkSpecEntry | SpecsMeta): entry is SpecsMeta {
  return (
    "verified_at" in entry ||
    "source" in entry ||
    "extraction_method" in entry ||
    "structure_note" in entry
  );
}
