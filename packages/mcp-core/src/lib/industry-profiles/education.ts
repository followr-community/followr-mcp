// Education: schools, online courses, training programs, certifications.

import type { IndustryProfile } from "./types.js";

export const EDUCATION_PROFILE: IndustryProfile = {
  id: "education",
  display_name: "Educación / cursos / capacitación",
  keywords: {
    strong: ["curso", "course", "matricularse", "instructor", "syllabus", "certificación", "diploma", "alumno", "enroll", "programa académico"],
    weak: ["estudiante", "student", "clase", "class", "aprender", "learn", "lecture", "module", "career"],
  },
  extractors: {
    primary: [
      {
        field: "programs",
        strategy: "css_selector",
        hint: "Course / program cards",
        selectors: ["[class*='course']", "[class*='program']", "[class*='curriculum']", "article[class*='class']"],
        paths_to_crawl: ["/courses", "/programs", "/cursos", "/catalog"],
        max_items: 30,
        required: false,
      },
      {
        field: "instructors",
        strategy: "css_selector",
        hint: "Instructor profiles",
        selectors: ["[class*='instructor']", "[class*='professor']", "[class*='teacher']", "[class*='faculty']"],
        paths_to_crawl: ["/instructors", "/faculty", "/profesores"],
        max_items: 15,
        required: false,
      },
    ],
    secondary: [
      {
        field: "schedule",
        strategy: "css_selector",
        hint: "Calendar / upcoming start dates",
        selectors: ["[class*='schedule']", "[class*='calendar']", "[class*='dates']"],
        max_items: 10,
        required: false,
      },
      {
        field: "certifications",
        strategy: "css_selector",
        hint: "Certifications and accreditations offered",
        selectors: ["[class*='certification']", "[class*='accredit']", "[class*='diploma']"],
        max_items: 10,
        required: false,
      },
    ],
  },
  content_pillars_suggested: [
    "program_launch",
    "instructor_spotlight",
    "student_success",
    "lesson_preview",
    "certification_value",
    "alumni_story",
  ],
  format_bias: {
    hero_video: 0.6,
    carousel: 0.7,
    single_photo: 0.5,
    promo: 0.5,
    lifestyle: 0.4,
  },
  video_strategy: {
    default_video_kind: "ai_avatar_video",
    rationale_short:
      "La educación se compra al instructor y al método. El avatar entra para presentar al docente, anticipar un programa, mostrar un fragmento de clase o narrar un éxito de alumno. El AI clip queda para tours del campus o aulas.",
    flip_concepts: ["campus_tour", "facility_tour", "classroom_environment"],
  },
};
