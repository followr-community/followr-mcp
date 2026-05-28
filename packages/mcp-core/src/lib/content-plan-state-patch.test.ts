import { afterEach, describe, expect, it } from "vitest";

import {
  _debugClearAll,
  createContext,
  getContext,
  invalidateContextsForCompany,
  patchContextsForCompany,
} from "./content-plan-state.js";

afterEach(() => {
  _debugClearAll();
});

describe("patchContextsForCompany", () => {
  it("mutates the snapshot in place and preserves the same context_id", () => {
    const ctx = createContext({
      company_id: 42,
      networks_connected: ["instagram"],
      brand_has_voice_prompt: true,
      cached_industry_id: null,
      cached_industry_confirmed: false,
      has_visual_style_marker: false,
    });

    const patched = patchContextsForCompany(42, { has_visual_style_marker: true });
    expect(patched).toBe(1);

    const fetched = getContext(ctx.context_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.has_visual_style_marker).toBe(true);
    // Same context_id, same other fields preserved.
    expect(fetched!.context_id).toBe(ctx.context_id);
    expect(fetched!.brand_has_voice_prompt).toBe(true);
    expect(fetched!.networks_connected).toEqual(["instagram"]);
  });

  it("patches multiple contexts for the same company", () => {
    const a = createContext({
      company_id: 7,
      networks_connected: [],
      brand_has_voice_prompt: false,
      cached_industry_id: null,
      cached_industry_confirmed: false,
      has_visual_style_marker: false,
    });
    const b = createContext({
      company_id: 7,
      networks_connected: [],
      brand_has_voice_prompt: false,
      cached_industry_id: null,
      cached_industry_confirmed: false,
      has_visual_style_marker: false,
    });

    const patched = patchContextsForCompany(7, {
      cached_industry_id: "saas",
      cached_industry_confirmed: true,
    });
    expect(patched).toBe(2);
    expect(getContext(a.context_id)!.cached_industry_id).toBe("saas");
    expect(getContext(b.context_id)!.cached_industry_confirmed).toBe(true);
  });

  it("does not touch contexts of other companies", () => {
    const mine = createContext({
      company_id: 7,
      networks_connected: [],
      brand_has_voice_prompt: false,
      cached_industry_id: null,
      cached_industry_confirmed: false,
      has_visual_style_marker: false,
    });
    const other = createContext({
      company_id: 99,
      networks_connected: [],
      brand_has_voice_prompt: false,
      cached_industry_id: null,
      cached_industry_confirmed: false,
      has_visual_style_marker: false,
    });

    patchContextsForCompany(7, { has_visual_style_marker: true });
    expect(getContext(mine.context_id)!.has_visual_style_marker).toBe(true);
    expect(getContext(other.context_id)!.has_visual_style_marker).toBe(false);
  });

  it("returns 0 when no contexts match", () => {
    expect(patchContextsForCompany(12345, { has_visual_style_marker: true })).toBe(0);
  });
});

describe("invalidateContextsForCompany still works (kept for deep_research)", () => {
  it("removes all contexts for the company", () => {
    const ctx = createContext({
      company_id: 7,
      networks_connected: [],
      brand_has_voice_prompt: false,
      cached_industry_id: null,
      cached_industry_confirmed: false,
      has_visual_style_marker: false,
    });
    const evicted = invalidateContextsForCompany(7);
    expect(evicted).toBe(1);
    expect(getContext(ctx.context_id)).toBeNull();
  });
});
