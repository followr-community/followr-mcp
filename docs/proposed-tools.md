# Propuestas de nuevas tools para el Followr MCP

Generado a partir de la campaña de verificación 2026-05-17 / 2026-05-18.
Inventario de tools que NO existen todavía y que tendrían valor real para
usuarios del MCP. Dividido entre tools "1:1" (wrappers directos de endpoints
REST) y tools compuestas (workflows que combinan varias llamadas y agregan
lógica de negocio).

NO implementar sin OK explícito de Marcos. Este archivo es propuesta, no plan.

---

## A. Wrappers directos (low-hanging, 1:1 con endpoint REST)

Endpoints que ya están verificados o documentados pero sin tool MCP que los
exponga. Implementación trivial. Falta solo decidir si vale la pena exponerlos.

### A1. `update_post`

- **Endpoint:** `PUT /api/posts/{id}` (Status ✅ Oficial)
- **Cuándo sirve:** editar caption, link, preferences de un Post ya creado
  dentro de un PostGroup, sin recrear todo el PostGroup. Iteración
  post-validation. Caso típico: "el LinkedIn variant quedó con hashtags pero
  no aplica al network, saquémoslos sin tocar IG/FB".
- **Inputs:** `post_id`, `description?`, `title?`, `link?`, `preferences?`,
  `assets_ids?`.
- **Riesgo:** mutación. Anotación MUTATION. La REPLACE semantics de
  assets_ids puede sorprender (mismo issue que tags_ids en update_post_group).

### A2. `delete_post`

- **Endpoint:** `DELETE /api/posts/{id}` (Status ✅ Oficial)
- **Cuándo sirve:** quitar un network de un PostGroup sin borrar el group
  entero. Caso típico: "agregué IG pero finalmente skip; sacalo".
- **Inputs:** `post_id`.
- **Riesgo:** DESTRUCTIVE. Confirmación verbatim por nombre + network.

### A3. `get_post`

- **Endpoint:** `GET /api/posts/{id}` (Status ✅ Oficial)
- **Cuándo sirve:** inspeccionar un solo Post sin pedir el PostGroup entero
  (parsing más liviano cuando el modelo solo quiere validar 1 network).
- **Inputs:** `post_id`.
- **Riesgo:** ninguno (READ_ONLY).

### A4. `list_subscription_limits`

- **Endpoint:** `GET /api/subscriptionLimits` (Status ✅ Oficial)
- **Cuándo sirve:** complementa `get_credits_balance` con detalle del plan
  (cuotas por recurso, fechas de renovación, addons). Útil para warnings
  tempranos del estilo "te quedan 3 días de words allowance".
- **Inputs:** ninguno (READ_ONLY).
- **Notas:** distinto a `GET /api/subscriptions/balance`. Este es plan-level
  metadata, no live counters.

### A5. `list_all_posts`

- **Endpoint:** `GET /api/posts` global (Status ✅ Oficial)
- **Cuándo sirve:** debugging y auditoría cross-company para usuarios admin /
  whitelabel owners. Para single-company use cases, `list_drafts` y
  `list_scheduled` son superiores.
- **Inputs:** filtros, pagination.
- **Notas:** baja prioridad. Solo si admins lo piden.

---

## B. Workflows compuestos (high value)

Tools que combinan varias llamadas, agregan validación o lógica de negocio,
y resuelven un dolor concreto del usuario en una sola call.

### B1. `audit_workspace_health`

**Para qué:** scorecard "está sano este workspace?" en una sola call.

**Cómo:** combina
- `list_drafts` filtrado por `created_at < hoy - 30d` → drafts stale
- `list_scheduled` próximos 7 días → posts a publicar pronto
- `list_rule_groups` con `active=true` → Autopilot OK o nadie
- `get_credits_balance` y `list_subscription_limits` → red flag si <X%
- `GET /api/companies/{id}/socialNetworks` → identificar `status: expired`

**Output:**
```
Workspace: Followr for MCP
✅ Credits: 92k (sobra)
✅ Active rules: 2 (Followr Suggestion, Test)
⚠️ 3 integrations expired: Instagram, LinkedIn, TikTok (reconectar)
⚠️ 12 drafts >60 días sin publicar (revisar o archivar)
✅ 4 posts próximos esta semana
```

**Por qué es valioso:** check semanal típico de social media managers. Lo
piden todos los clientes. Hoy requiere 5 calls separadas.

**Anotación:** READ_ONLY.

---

### B2. `reply_to_dm`

**Para qué:** responder un DM sin que el modelo se ahogue con el 7-day window
de Meta.

**Cómo:**
1. Lee `last_message_at` de la conversation (via `list_conversations` o cache).
2. Si está dentro del 7-day window: manda mensaje via
   `POST /api/{network}/conversations/{id}/messages` (endpoint a verificar, hoy
   inferido). Mark_conversation_read.
3. Si está fuera: devuelve toolError estructurado sugiriendo al user pedirle
   al external user que mande un mensaje fresco.

**Por qué es valioso:** hoy el modelo intenta replies y se topa con HTTP 500
inentendible. Esta tool encapsula la heurística + da next-step accionable.

**Anotación:** MUTATION. Sensitive (afecta cuenta externa).

---

### B3. `weekly_recap`

**Para qué:** digest semanal listo para mandar al cliente / al whatsapp del
boss.

**Cómo:**
- `get_best_performing_posts` con `since=hoy-7d&sort_by=impressions` top 5
- `get_post_analytics` agregado por network → total reach / engagement
- `list_comments` con `created_at > hoy-7d` → comentarios nuevos
- `list_conversations` con `only_unread=true` → DMs sin responder
- Formato output: text plano para WhatsApp o markdown para Slack

**Por qué es valioso:** unlock del PostApprove "weekly digest" feature.
También vendible standalone como "Followr Weekly Report".

**Anotación:** READ_ONLY.

---

### B4. `schedule_recurring_post`

**Para qué:** "publicá este post cada lunes 9 AM AR" sin que el modelo tenga
que entender Autopilot internals.

**Cómo:** wrapper sobre
1. `create_post_group` (con publish_at primer slot)
2. `create_post` per network
3. Agregar rule a un ruleGroup (que el ruleGroup tenga rule de "lunes 9 AM")
4. Anotar al user que cada lunes Followr va a auto-fill desde el pool tagged

**Por qué es valioso:** Autopilot es el feature menos descubierto de Followr.
Esta tool lo democratiza y baja la barrera de entrada de "qué carajo es un
rule group" a "vos decís lunes 9 AM y listo".

**Anotación:** MUTATION. Confirmar timezone explícitamente.

---

### B5. `cleanup_test_artifacts`

**Para qué:** borrar en batch tags / folders / postGroups / voices / assets
cuyo nombre matchee un pattern.

**Cómo:**
- Lista cada recurso filtrado por nombre con prefix/regex (ej: `__verification_*`)
- Muestra dry-run al user con la lista a borrar
- Tras confirmación, hace los DELETEs usando los nuevos `delete_voice`,
  `delete_asset`, más los existentes `delete_tag`, `delete_folder`,
  `delete_post_group`

**Por qué es valioso:** operacional para vos y para developers que testean el
MCP. Te ahorra ir a la UI a borrar 30 artefactos uno por uno después de cada
campaña como la nuestra.

**Anotación:** DESTRUCTIVE. Dry-run requerido + confirmación.

---

### B6. `mirror_post_across_networks`

**Para qué:** "publica el mismo post en IG, FB, LinkedIn" pero respetando
diferencias de cada network.

**Cómo:**
1. Lee post original via `get_post`
2. Para cada network objetivo:
   - Adapta caption con `generate_text` si excede el límite (Twitter 280)
   - Adapta media si necesario (vertical → square para FB)
3. Llama `create_post` per network en un nuevo PostGroup (o el mismo)
4. Devuelve `validate_against_specs` warnings de cada uno

**Por qué es valioso:** cross-posting es el use case más común. Hoy el
modelo tiene que orquestar manualmente las llamadas. Esta tool lo hace bien
y con validación.

**Anotación:** MUTATION.

---

### B7. `detect_stale_integrations`

**Para qué:** identificar qué social networks de un workspace necesitan
reconectar OAuth.

**Cómo:**
- `GET /api/companies/{id}/socialNetworks`
- Filtrar los con `status: "expired"` o `"needs_attention"`
- Devolver lista con OAuth re-connect link de cada uno (si el endpoint
  `POST /api/socialNetworks/{id}/reactivate` lo provee)

**Por qué es valioso:** la queja #1 de social media users es "por qué mi
post no se publicó". 50% de las veces es OAuth vencido. Esta tool lo
detecta proactivamente.

**Anotación:** READ_ONLY.

---

### B8. `generate_first_comment_for_hashtags`

**Para qué:** primer comentario auto-generado con hashtags relevantes para
mantener caption de IG limpia.

**Cómo:**
1. Lee post via `get_post`
2. Genera hashtags relevantes via `generate_text` con prompt específico
3. Setea `comments_to_create` del post con el comentario generado
   (usando `update_post` o creando inline al crear el post)

**Por qué es valioso:** convención IG: hashtags en primer comentario, no en
caption. Hoy el modelo no lo hace automáticamente.

**Anotación:** MUTATION + costo en credits (generate_text).

---

### B9. `copy_brand_settings`

**Para qué:** clonar palettes, ai_image_styles, ai_preferences,
social_network_prompts de un company a otro. Multi-tenant agencies.

**Cómo:**
1. `get_company(source_id)` → snapshot
2. `update_company(target_id)` con merge de los fields seleccionados

**Por qué es valioso:** typical agency onboarding: "tengo cliente nuevo,
clonate el setup del cliente anterior". Hoy requiere copy/paste manual.

**Anotación:** MUTATION. Confirmar source + target by name.

---

### B10. `get_publishing_calendar`

**Para qué:** vista calendar de qué se publica esta semana / mes.

**Cómo:** combina `list_scheduled` + `list_drafts` + rule groups → timeline
ASCII week view formateado para conversación.

**Output:**
```
Lun 2026-05-19
  09:00 [IG, FB] Pitch deck v3 (PostApprove)
  14:00 [LinkedIn] Industry insights weekly

Mar 2026-05-20
  10:30 [IG] Behind the scenes story
  ...
```

**Por qué es valioso:** lo que la UI muestra como grid, formateado para
conversación. Útil para "qué tengo programado el martes?".

**Anotación:** READ_ONLY.

---

### B11. `audit_brand_voice_coverage`

**Para qué:** verificar que todos los networks que el user usa tengan
prompts de brand voice configurados.

**Cómo:** `list_prompts` agrupado por `social_network_type`. Identifica gaps
(ej: 0 prompts custom para LinkedIn cuando el user publica en LinkedIn).
Sugiere crear defaults con `create_prompt`.

**Por qué es valioso:** problema típico de agency switching from competitor
to Followr. "Por qué mis posts de LinkedIn sonan genéricos?" Respuesta:
nadie configuró prompts custom para LinkedIn.

**Anotación:** READ_ONLY (la sugerencia se ejecuta separado).

---

## C. Ordenamiento sugerido por prioridad

Si tuvieras que implementar pocos:

1. **B1 audit_workspace_health** — vende solo, mucho valor con tools ya
   existentes.
2. **B5 cleanup_test_artifacts** — utility operacional, lo necesitamos
   nosotros para futuras campañas.
3. **B2 reply_to_dm** — cierra hueco de 7-day window que hoy el modelo no
   maneja bien.
4. **B4 schedule_recurring_post** — democratiza Autopilot, feature menos
   descubierto.
5. **A1 update_post + A2 delete_post** — completar el CRUD de Posts, cuesta
   poco.
6. **B7 detect_stale_integrations** — respuesta a la queja #1 de usuarios.

El resto son nice-to-have, pueden esperar a v0.3 o v0.4 del MCP.

---

## D. Pendientes de verificación antes de implementar

Algunas propuestas dependen de endpoints aún no testeados en producción:

- **B2 reply_to_dm**: `POST /api/{network}/conversations/{id}/messages` (send)
  está marcado como `🔍 Inferido` en el doc interno. Verificar antes.
- **B7 detect_stale_integrations**: `POST /api/socialNetworks/{id}/reactivate`
  también `🔍 Inferido`. Verificar el flow OAuth before building.
- **B6 mirror_post_across_networks**: depende de que `update_post` y
  `delete_post` (A1, A2) funcionen tal como dice la spec.
