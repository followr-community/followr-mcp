# Followr MCP: TODO v2

Backlog de mejoras, verificaciones pendientes y bugs conocidos descubiertos
durante el desarrollo. Sesión de origen anotada en cada item.

Convención de prioridad:
- 🔴 critical: bloquea uso correcto, hay que arreglar pronto
- 🟡 major: mejora notable de calidad, no urgente
- 🟢 polish: nice-to-have, cero urgencia
- 🔵 verify: gap empírico, hay que confirmar comportamiento antes de actuar

---

## Scraper (`lib/brand-website-scraper.ts`)

### 🟡 SVG inline logo detection (sesión 2026-05-22)
Probamos contra postapprove.pages.dev: el logo está en `<svg>` inline (no
`<img>` con src), así que el scraper lo detecta como un icon más en
`inline_svg_icons` pero no lo clasifica como logo específicamente.

**Fix**: cuando una `<svg>` inline aparece cerca del top del `<header>` (o
es la primera `<svg>` del documento, o tiene class/id que matchea
`logo|brand|mark`), proponerla como `logo_candidate` con `src_hint:
"inline-svg-in-header"`. El usuario decide en la curación.

### 🟢 Multi-page crawl (sesión 2026-05-22)
Hoy scraper hace single-page. Para brands con product gallery distribuido
en múltiples páginas (e.g. /products, /about, /team), un crawl ligero de
2-3 páginas adicionales (home + first link from header nav) daría
significativamente más signal.

Cap: 4 páginas máximo, total 4MB acumulado, respect robots.txt.

### 🟢 External stylesheet fetch siempre que existe (sesión 2026-05-22)
Hoy fetcheamos máx 1 stylesheet linked. Para sitios modernos con CSS
modular (Next.js, Astro), las paletas reales están repartidas en varios
stylesheets. Fetch top 3 stylesheets por tamaño descendente.

### 🟡 Twitter image fallback (sesión 2026-05-22)
Si `og:image` está vacío pero `twitter:image` existe, hoy lo capturamos
pero no lo promovemos como candidato. Debería caer en `logo_candidates`
o `hero_candidates` según contexto.

### 🟢 CSS variables como source de paleta (sesión 2026-05-22)
Sitios con design systems modernos definen colores en CSS custom
properties: `--brand-primary: #02928B`. El scraper debería buscar
declaraciones `--*: #...` y darles más peso que valores hex sueltos.

### 🟢 Dimensiones reales en image candidates (sesión 2026-05-22)
Hoy no descargamos las imágenes, solo guardamos sus URLs. Para distinguir
mejor hero (>1000px wide) de icon (<128px) deberíamos hacer HEAD requests
o leer width/height attributes del `<img>` tag.

### 🟢 Brand voice signal del about page (sesión 2026-05-22)
La home tiene marketing copy. El about page tiene tone & voice signal más
puro. Crawl + grep first paragraph del about page sumaría al brief
synthesis sin mucho costo.

---

## Brand Identity tool (`tools/brand-identity.ts`)

### 🔴 `countPublishedSafe` returns MAX_SAFE_INTEGER stub (sesión 2026-05-22)
La función para contar published PostGroups hoy hace pageSize=1 y devuelve
`MAX_SAFE_INTEGER` si encontró algo, 0 si no. Eso rompe el cálculo del
delta de posts para el refresh trigger.

**Fix**: usar `meta.total` que el API devuelve en la response paginada, o
hacer un GET separado al endpoint con un filter que devuelva counter sin
data.

### 🟡 Industry detection desde `deep_research` cache (sesión 2026-05-22)
Hoy `detectIndustryFromDescription` corre regex contra la description. El
método correcto es leer el marker de deep_research cache (`[industry:...]`)
ya implementado en otra parte del MCP. Conectarlos.

### 🟡 Asset cost estimate dinámico (sesión 2026-05-22)
Hoy Phase 1 cost asume 25 cr/image (nano_banana_2). Si la company tiene
`ai_preferences.image_model = "nano_banana_pro"` (45 cr/image), el
estimate quedaría corto. Leer del catálogo `IMAGE_MODELS` y la company
para el costo real.

### 🟢 Industry-aware aspirational brands más rico (sesión 2026-05-22)
Hoy 7 industrias con 4-6 marcas cada una. Expandir a 15-20 industrias y
20-30 marcas cada una, con curaduría más cuidada (incluir marcas de
distintos market tiers).

### 🟢 Curation strategy con thumbnails inline (sesión 2026-05-22)
El `_assistant_guidance.recommended_curation_strategy` dice "mostralos
con thumbnails" pero el tool no devuelve las URLs ya listas para
renderear. Agregar campo `curation_view_data` con shape óptimo para
mostrar al usuario (URL + thumbnail + suggested_classification +
suggested_tag).

---

## Brand Identity lib (`lib/brand-identity.ts`)

### 🟢 Versionado de schema (forwards-compat) (sesión 2026-05-22)
Hoy el parser rechaza schemas que no sean "v1". Cuando lleguemos a v2,
hay que decidir: (a) parser maneja v1 + v2 (forwards compat), (b)
mantiene strict y exige re-sync. Más probable (a) con migración
automática. Estructura del migrator dependiente del shape de v2.

### 🟢 Bloque size guard (sesión 2026-05-22)
Hoy `brief_text` capped a 2000 chars, pero el bloque entero puede crecer
con muchos aspirational brands + anti_patterns. Sumar un cap total al
bloque (<5KB) y warn al usuario si lo excede.

---

## Verifications gaps

### 🔵 API behavior `palettes` > 3 colors (sesión 2026-05-22)
F0.2 capturó shape pero no probó qué pasa si PUT con 5+ colors. Pendiente:
hacer un test PUT con 5 colors y ver si la API:
- (a) acepta los 5 y devuelve los 5
- (b) acepta pero trunca a 3
- (c) rechaza con 422

Test mejor hacerlo con curl directo + token (no via SPA).

### 🔵 `ai_image_styles` en modelos premium (sesión 2026-05-22)
F0.1 confirmó que con `nano_banana_2` el campo NO se aplica. Pendiente:
verificar mismo A/B con `nano_banana_pro`, `gpt_image_2`, `imagen4_*`,
`flux_pro_1.1`, `ideogram_v3`. Si en alguno SÍ se aplica, hay que
documentarlo y manejarlo distinto.

Costo: ~6 modelos × 25-70 cr cada uno = 200-400 cr total.

### 🔵 `Prompt.social_network_type` valores no-network via raw API (sesión 2026-05-22)
El MCP enforces enum a nivel zod. Para saber si la API misma acepta
`"visual"` o `"all"`, hay que hacer curl directo. Solo importa si en el
futuro queremos un Prompt-based fallback para Brand Visual Identity.

### 🔵 AVIF + MIME types completos (sesión 2026-05-21/22)
PNG, JPEG, SVG, WebP, GIF, AVIF confirmed accepted. Pendientes:
- HEIC / HEIF (iOS export)
- BMP, TIFF (raros pero algunos brands los usan)
- Video: WebM, MOV (quicktime)

---

## Documentation pending

### 🟡 Doc interno `companies.md` actualizar (sesión 2026-05-22)
- Marcar `ai_image_styles` como Status `⚠️ Vestigial / cosmetic` con
  finding del A/B
- Documentar `palettes` UI cap de 3 + caveat de UI-truncation
- Marcar `fonts` como `Status: ⚠️ Field exists, no UI surface`

### 🟡 Doc interno `assets.md` actualizar (sesión 2026-05-22)
Lista de formatos confirmados (PNG, JPEG, SVG, WebP, GIF, AVIF) con
expectativa de Content-Type por extensión.

### 🟡 Doc interno `_changelog.md` entry (sesión 2026-05-22)
Resumir descubrimientos de la sesión 2026-05-22 (ai_image_styles
empírico, palette UI cap empírico, AVIF accepted, scraper diseñado,
brand identity lib creada).

### 🟡 Doc público `openapi.yaml` actualizar (sesión 2026-05-22)
- `Company.palettes`: agregar `maxItems: 3`
- Asset uploads: documentar MIME types aceptados
- Bump version a 0.5.0 + entry en CHANGELOG.md

### 🟡 Doc público deploy a Cloudflare Pages (sesión 2026-05-22)
Después de actualizar el openapi, correr el deploy script:
```bash
cd docs/followr-api-public && wrangler pages deploy . --project-name=followrapi-docs --branch=main
```

### 🟢 Instrucciones del MCP (`instructions.ts`) (sesión 2026-05-22)
Sumar rules sobre Brand Visual Identity workflow (assess→draft→execute
pattern, when to use, cold-start strategy).

### 🟢 Planning strategy (`content-plan-catalog.ts`) (sesión 2026-05-22)
Sumar keys:
- `brand_visual_identity_principle`: cómo y cuándo se usa
- `carousel_consistency_principle`: image-to-image chaining
- `ai_image_styles_neutralization_principle`: cosmetic-only, no need to clear
- `typography_reference_principle`: negative literal copy strategy

---

## Architecture / design debt

### 🟡 Carousel image-to-image chaining no implementado todavía (sesión 2026-05-22)
Plan original F4. Hace que cada slide N use slide N-1 como reference, en
ejecución secuencial (no paralela). Trade-off: latencia × N pero
coherencia visual real. Está en el plan general pero todavía no en código.

### 🟡 Refresh tool no implementado (sesión 2026-05-22)
Plan original F5: `update_brand_visual_identity` con modo `auto |
templates | elements | full`. Triggered también desde
`prepare_content_plan_context` cuando detecta delta > threshold.

### 🟡 Typography reference handling fino (sesión 2026-05-22)
Plan original F6: cuando el resolver detecta refs con tag
`brand:typography-reference`, append suffix de "use typography style,
don't copy literal text". Está documentado en el plan, no implementado.

### 🟢 generate_chat fallback path (Fase 1 Tier 1) ya tiene Brand context (sesión 2026-05-22)
Cuando `execute_content_plan` cae al path B (sin copy_draft), llama
`client.generateChat` con company info. Vale conectarle el Brand Identity
brief también (sumar al system prompt) para que el copy también sea
más on-brand.

### 🟢 Phase 1 template manufacturing en tool separado (sesión 2026-05-22)
F2.8 del plan: `manufacture_brand_templates` como tool aparte de
`execute_brand_visual_identity`. Permite separar la confirmación de costo
de la creación de folders. Hoy no implementado.

### 🟢 `approve_brand_templates` finalizer (sesión 2026-05-22)
F2.9 del plan: después de generar templates, el usuario aprueba cuáles
quedan. Rechazados se borran o pasan a `__brand_anti_patterns`. Hoy no
implementado.

---

## Performance / scalability

### 🟢 Brand identity draft state TTL extendido (sesión 2026-05-22)
Content-plan state usa 2h TTL. Brand identity drafts pueden tomar más
tiempo (el usuario revisa thumbnails, sube imágenes propias). Considerar
24h TTL específico para brand identity drafts.

### 🟢 Asset upload paralelización con backoff (sesión 2026-05-22)
Cuando Phase 1 sube 13 templates, mejor paralelizar con concurrency=3
para no sobrecargar el backend de Followr. Hoy execute_content_plan ya
hace algo similar.

---

## Deploy pendiente

### 🔴 Re-intentar deploy del openapi público v0.5.6 (sesión 2026-05-22)
Local listo: openapi.yaml válido (validated via Scalar CLI),
CHANGELOG.md actualizado con entries de v0.5.6, version bumped en el
yaml.

**3 intentos consecutivos de wrangler pages deploy fallaron con
HTTP 500 desde Cloudflare** (`POST /pages/assets/upload` →
"Received a malformed response from the API"). Ray IDs:
9ffce0e3bc25b007, 9ffce34bbfa08126, 9ffce578dedc7a5c. Spaced 1-2 min
apart. Issue es del lado de Cloudflare, no del archivo (yaml válido).

**Acción**: reintentar más tarde:
```bash
cd /Users/marcosplazadeayala/Documents/Claude/proyectos/Followr/docs/followr-api-public
npx --yes wrangler@latest pages deploy . --project-name=followrapi-docs --branch=main
```

Sin urgencia, los docs públicos siguen sirviendo v0.5.5 hasta que el
deploy entre. El changelog y el yaml ya son SoT en el repo.

---

## Limpieza

### 🟢 Mover el código de fetchWebsiteSummary a brand-website-scraper (sesión 2026-05-22)
content-plan.ts tiene un `fetchWebsiteSummary` que duplica parcialmente
el nuevo `scrapeBrandSignalsFromWebsite`. Refactor: el primero llama al
segundo y devuelve solo el subset que necesita (title + meta_description
+ og_*). Reduce duplicación de ~200 líneas.

---

## Discovered during implementation

### 🟡 Followr API: no asset-level tag support (sesión 2026-05-22)
Followr Tag resource es scoped a PostGroups; no hay endpoint para tagear
un Asset individual. Workaround actual: mantenemos `asset_tag_map`
adentro del BRAND_VISUAL_IDENTITY block en Company.description.

Esto funciona pero tiene limitaciones:
- El usuario no ve los tags en la UI de Followr (los assets aparecen sin
  etiquetar a sus ojos).
- Si el usuario borra un asset desde Media Library, el tag_map queda
  con un id huérfano hasta el próximo refresh.

Mejor solución: pedir a Followr que exponga `PATCH /api/assets/{id}`
con `tags_ids` (mismo patrón que PostGroup). Si lo agregan, el MCP
puede migrar a tagging nativo.

### 🟡 FollowrClient.moveAssetToFolder no existe (sesión 2026-05-22)
El client tiene `createAsset`, `requestAssetUpload`, `listAssets`,
`deleteAsset` pero no método para mover un asset entre folders. La doc
folders.md menciona la API `PATCH /api/assets/{id}` con `folder_id`
como descubierto, no implementado.

**Fix**: agregar `moveAssetToFolder(assetId, folderId)` en
packages/shared/src/followr.ts. Una vez implementado, conectar con el
helper `maybeMoveAssetToFolder` en tools/brand-identity.ts que hoy es
no-op. Permitirá organizar los uploads del Brand Identity en los 3
folders del usuario en lugar de quedar al root.

### 🟡 FollowrClient.countPublishedPostGroups no existe (sesión 2026-05-22)
Para el delta-trigger del refresh flow necesitamos contar published
posts. `client.listCompanyPostGroups` devuelve la primera página pero
no expone meta.total directamente. Hoy `countPublishedSafe` devuelve
MAX_SAFE_INTEGER stub.

**Fix**: agregar `countCompanyPostGroups(companyId, filters)` que
devuelva `meta.total` de la response paginada (page[size]=1, leer
meta.total).

### 🟡 Reevaluar el cap de 5 referencias por generación AI (sesión 2026-05-22)
Hoy `pickBrandReferenceUrls` y `mergeReferenceUrls` cappean a 5 refs
porque nano_banana_2 tiene rendimientos decrecientes después de 5
(empírico, no spec). Pero hay use cases donde 5 puede quedar corto:

- Cover + logo + 2 hero + 1 pattern + 1 typography ref = 5 lleno
  (sin chain previous slide)
- Carousel slide 3+ con chain: 1 logo + 1 hero + 1 typography +
  1 pattern + 1 previous = 5 lleno
- Usuario quiere combinar logo + 3 product photos + 1 typography +
  inspired_by_brand = uno queda afuera

Opciones a evaluar:
- (a) Subir cap a 7-8 refs y testear empíricamente que la calidad
  no se degrade (algunos modelos toleran más)
- (b) Smart prioritization: si hay typography ref Y logo Y product
  Y chain, droppear el ref menos relevante en lugar de cropear
- (c) Modelo-aware: nano_banana_2 cap 5, gpt_image_2 cap 16 (tiene
  más context), por modelo
- (d) Pasar al modelo refs como composiciones (una image con 4
  thumbnails en grid) en lugar de URLs separados

Test empírico necesario: generar la misma imagen con 5 vs 8 vs 12
refs y comparar visualmente. Cost: 3 generaciones × 25 cr = 75 cr.
Vale la pena hacerlo antes de subir el cap.

También considerar para fonts específicamente: pasar 2-3 imágenes
del mismo font en distintos contextos (banner, body text, headline)
da mejor signal que 1 imagen. Si la decisión es "max 5", limitar
typography a 1 ref obliga al modelo a inferir desde un solo
ejemplo. Subir a 7 podría darle 2 refs de typography sin sacrificar
los otros.
