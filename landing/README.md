# Followr MCP landing

Static landing page for Followr MCP. Same family as `followr-fan-club`: one `index.html`, one `styles.css`, one `app.js`. No build step, no framework, no `node_modules`.

**Suggested live URL:** `https://followr-mcp.pages.dev`

Once deployed, this page becomes one more product card in `followr-fan-club`.

---

## Local preview

```
cd /Users/marcosplazadeayala/Documents/Claude/proyectos/Followr/followr-mcp/landing
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Deploy (Cloudflare Pages)

First time only, create the project:

```
zsh -ic "npx wrangler pages project create followr-mcp --production-branch=main"
```

Subsequent deploys:

```
zsh -ic "cd /Users/marcosplazadeayala/Documents/Claude/proyectos/Followr/followr-mcp/landing && npx wrangler pages deploy . --project-name=followr-mcp --branch=main"
```

The `zsh -ic` wrapper sources `~/.zshrc` so `CLOUDFLARE_API_TOKEN` is available.

## How to add this landing to `followr-fan-club`

Once `followr-mcp.pages.dev` is live, drop a new product card in the fan club:

1. Copy `assets/mcp-mark.svg` to `followr-fan-club/assets/products/mcp-mark.svg`.
2. Open `followr-fan-club/index.html`, find `<section class="products">`, append a new `<a class="product-card">` between the existing two. Use the existing cards as a template:

   ```html
   <a class="product-card" href="https://followr-mcp.pages.dev" target="_blank" rel="noopener noreferrer">
     <div class="card-top">
       <img class="product-mark" src="assets/products/mcp-mark.svg" alt="" width="48" height="48" />
       <span class="sticker sticker-live" data-i18n="sticker.live">live</span>
     </div>
     <h3>Followr MCP</h3>
     <p class="product-tagline" data-i18n="card.mcp.tagline">Run Followr from Claude, Cursor and any MCP client.</p>
     <div class="card-tags">
       <span class="tag">mcp</span>
       <span class="tag">claude</span>
       <span class="tag">cursor</span>
     </div>
     <div class="card-cta">
       <span data-i18n="card.cta">Visit</span>
       <span class="card-cta-arrow" aria-hidden="true">&rarr;</span>
     </div>
   </a>
   ```

3. Open `followr-fan-club/i18n.js`, add the tagline key to both EN and ES blocks:
   ```js
   "card.mcp.tagline": "Run Followr from Claude, Cursor and any MCP client.",
   ```
   ES:
   ```js
   "card.mcp.tagline": "Manejá Followr desde Claude, Cursor y cualquier cliente MCP.",
   ```

4. Redeploy the fan club.

## Editing copy

All user-facing strings live in `app.js` under `translations.en` and `translations.es`. The English values in `index.html` are fallbacks only. The JS overwrites them on load. If you edit copy in `index.html` and forget `app.js`, the JS will revert your change.

Some `data-i18n` strings include limited inline HTML (`<code>`, `<strong>`, `<a>`, `<em>`). The applyLocale function uses `innerHTML` only for those values (detected by the presence of `<`). Anything else stays as `textContent`. Keep that constraint in mind when editing.

## Adding a language

1. Open `app.js`.
2. Add to the `locales` array:
   ```js
   { code: "pt", label: "Português", short: "PT" }
   ```
3. Add the translated keys to `translations`. Copy the EN block, translate every value. No HTML change needed.

## Rules of the road

- **No em dashes anywhere.** Run `grep -RnP '[\x{2014}\x{2013}]' .` from this folder before committing. Expected output: zero matches. Use ASCII hyphen, period, comma, colon, or parens. The non-breaking hyphen `‑` (U+2011) is allowed and used for compound words like `time‑blocking` so they don't break across lines.
- **Stay platform-aware in tone**: this is community / unofficial. Don't write copy that implies endorsement, support, or affiliation with Followr Inc.
- **Keep the "unofficial" sticker visible** in the nav and the disclaimer line in the footer. Both are load-bearing for the positioning.
- **Don't break the install snippets**. The exact JSON shape and the `claude mcp add` command must match what `packages/stdio/README.md` documents in the parent repo. If those change, update both.

## File map

```
landing/
  index.html              home / marketing page
  install.html            step-by-step install guide (linked from index)
  styles.css              design tokens + layout + components (shared)
  app.js                  translations + dropdown + demo/install tabs (shared)
  _headers                Cloudflare Pages headers (cache + CSP)
  README.md               this file
  assets/
    favicon.svg
    og-image.svg
    mcp-mark.svg          the product mark (chat bubble + Followr star)
```

## Pages

- `index.html` is the marketing page. Hero, demo, capabilities, install snippets, trust, CTA.
- `install.html` is a step-by-step install article. Linked from `index.html` inside the install section. Path 1 is Claude Code (CLI, easier). Path 2 is Claude Desktop (GUI). Same nav, same footer, same JS, same translations. New keys live under `guide.*` in `app.js`.

When adding a new language, the `guide.*` keys must be translated too or the guide page will display `[key]` placeholders.
