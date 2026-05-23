// Healthcare: clinics, medical practices, specialists. Tone is careful
// because of regulatory sensitivity.

import type { IndustryProfile } from "./types.js";

export const HEALTHCARE_PROFILE: IndustryProfile = {
  id: "healthcare",
  display_name: "Salud / clínica médica",
  keywords: {
    strong: ["clínica", "clinic", "turno", "appointment", "especialidad", "specialty", "obra social", "consulta médica", "doctor", "médico"],
    weak: ["paciente", "patient", "tratamiento", "treatment", "salud", "health", "diagnóstico", "nursing"],
  },
  extractors: {
    primary: [
      {
        field: "services",
        strategy: "css_selector",
        hint: "Medical services / specialties offered",
        selectors: ["[class*='service']", "[class*='specialty']", "[class*='treatment']", "[class*='procedure']"],
        paths_to_crawl: ["/services", "/specialties", "/especialidades", "/treatments"],
        max_items: 30,
        required: false,
      },
      {
        field: "specialists",
        strategy: "css_selector",
        hint: "Doctor / specialist profiles",
        selectors: ["[class*='doctor']", "[class*='specialist']", "[class*='physician']", "[class*='team-member']"],
        paths_to_crawl: ["/team", "/doctors", "/specialists", "/medicos"],
        max_items: 20,
        required: false,
      },
      {
        field: "locations",
        strategy: "json_ld",
        hint: "Practice locations from MedicalBusiness / Clinic schema",
        jsonld_types: ["MedicalBusiness", "Clinic", "Hospital", "LocalBusiness"],
        max_items: 5,
        required: false,
      },
    ],
    secondary: [
      {
        field: "insurance_accepted",
        strategy: "css_selector",
        hint: "Insurance / coverage notes",
        selectors: ["[class*='insurance']", "[class*='obra-social']", "[class*='coverage']"],
        max_items: 30,
        required: false,
      },
      {
        field: "hours",
        strategy: "json_ld",
        hint: "openingHours from schema",
        jsonld_types: ["MedicalBusiness", "Clinic"],
        max_items: 1,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "service_explainer",
    "doctor_intro",
    "health_tip",
    "patient_journey_FAQ",
    "prevention_post",
    "facility_tour",
  ],
  format_bias: {
    hero_video: 0.4,
    carousel: 0.7,
    single_photo: 0.5,
    promo: 0.2,
    lifestyle: 0.3,
  },
  video_strategy: {
    default_video_kind: "ai_avatar_video",
    rationale_short:
      "Confianza médica se transmite con voz humana. El avatar entra para presentar al especialista, explicar un servicio o dar un tip de salud. El AI clip queda para tours de la clínica o el equipamiento. Mantener tono conservador en cualquier claim.",
    flip_concepts: ["clinic_tour", "equipment_tour", "facility_walkthrough"],
  },
};
