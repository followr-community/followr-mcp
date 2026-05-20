// Industry profile registry. Reexports each industry profile module
// (one per industry) and assembles them into a typed registry keyed by
// IndustryId.
//
// To add a new industry:
//   1. Add the id to the IndustryId union in ./types.ts.
//   2. Create a new module ./<id>.ts that exports the profile constant.
//   3. Import the constant here and add it to the INDUSTRY_PROFILES map.

import type { IndustryId, IndustryProfile } from "./types.js";

import { CREATIVE_AGENCY_PROFILE } from "./creative_agency.js";
import { ECOMMERCE_FASHION_PROFILE } from "./ecommerce_fashion.js";
import { ECOMMERCE_GENERAL_PROFILE } from "./ecommerce_general.js";
import { EDUCATION_PROFILE } from "./education.js";
import { EVENTS_ORGANIZER_PROFILE } from "./events_organizer.js";
import { FITNESS_WELLNESS_PROFILE } from "./fitness_wellness.js";
import { GENERIC_BUSINESS_PROFILE } from "./generic_business.js";
import { HEALTHCARE_PROFILE } from "./healthcare.js";
import { HOTEL_HOSPITALITY_PROFILE } from "./hotel_hospitality.js";
import { LOCAL_BUSINESS_PROFILE } from "./local_business.js";
import { NEWS_MEDIA_PROFILE } from "./news_media.js";
import { NGO_NONPROFIT_PROFILE } from "./ngo_nonprofit.js";
import { PERSONAL_BRAND_PROFILE } from "./personal_brand.js";
import { REAL_ESTATE_PROFILE } from "./real_estate.js";
import { RESTAURANT_PROFILE } from "./restaurant.js";
import { SAAS_PROFILE } from "./saas.js";
import { SERVICE_B2B_PROFILE } from "./service_b2b.js";

export {
  CREATIVE_AGENCY_PROFILE,
  ECOMMERCE_FASHION_PROFILE,
  ECOMMERCE_GENERAL_PROFILE,
  EDUCATION_PROFILE,
  EVENTS_ORGANIZER_PROFILE,
  FITNESS_WELLNESS_PROFILE,
  GENERIC_BUSINESS_PROFILE,
  HEALTHCARE_PROFILE,
  HOTEL_HOSPITALITY_PROFILE,
  LOCAL_BUSINESS_PROFILE,
  NEWS_MEDIA_PROFILE,
  NGO_NONPROFIT_PROFILE,
  PERSONAL_BRAND_PROFILE,
  REAL_ESTATE_PROFILE,
  RESTAURANT_PROFILE,
  SAAS_PROFILE,
  SERVICE_B2B_PROFILE,
};

/**
 * Registry of every industry profile, keyed by IndustryId. Total 17
 * profiles: 16 industry-specific + generic_business fallback.
 */
export const INDUSTRY_PROFILES: Record<IndustryId, IndustryProfile> = {
  creative_agency: CREATIVE_AGENCY_PROFILE,
  ecommerce_fashion: ECOMMERCE_FASHION_PROFILE,
  ecommerce_general: ECOMMERCE_GENERAL_PROFILE,
  education: EDUCATION_PROFILE,
  events_organizer: EVENTS_ORGANIZER_PROFILE,
  fitness_wellness: FITNESS_WELLNESS_PROFILE,
  generic_business: GENERIC_BUSINESS_PROFILE,
  healthcare: HEALTHCARE_PROFILE,
  hotel_hospitality: HOTEL_HOSPITALITY_PROFILE,
  local_business: LOCAL_BUSINESS_PROFILE,
  news_media: NEWS_MEDIA_PROFILE,
  ngo_nonprofit: NGO_NONPROFIT_PROFILE,
  personal_brand: PERSONAL_BRAND_PROFILE,
  real_estate: REAL_ESTATE_PROFILE,
  restaurant: RESTAURANT_PROFILE,
  saas: SAAS_PROFILE,
  service_b2b: SERVICE_B2B_PROFILE,
};

/**
 * Returns the profile for an id, or the generic_business fallback when
 * the id is not present in the registry. Since INDUSTRY_PROFILES is a
 * full Record now, this is essentially safe-by-construction; the
 * fallback path exists for forward-compat when new ids are added to
 * IndustryId but the registry is updated in a follow-up commit.
 */
export function getProfile(id: IndustryId): IndustryProfile {
  return INDUSTRY_PROFILES[id] ?? GENERIC_BUSINESS_PROFILE;
}

/** All industry ids that the classifier may emit, in stable order. */
export const ALL_INDUSTRY_IDS: IndustryId[] = Object.keys(INDUSTRY_PROFILES) as IndustryId[];

export * from "./types.js";
