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

## How this landing is wired into `followr-fan-club`

Already done. The fan club hosts a product card pointing at `https://followr-mcp.pages.dev`. Quick map so future edits know where each piece lives:

- `followr-fan-club/index.html` has the `<a class="product-card">` inside `<section class="products">`. Click target is `https://followr-mcp.pages.dev`, tags are `mcp` / `claude` / `cursor`, sticker is `sticker-live`.
- `followr-fan-club/i18n.js` has `card.mcp.tagline` translated for EN and ES.
- `followr-fan-club/assets/products/mcp-mark.svg` is the icon used on the card. It is NOT a copy of `landing/assets/mcp-mark.svg` (that one is the chat bubble + Followr star, used for the favicon and the nav of this landing). The fan-club mark is a different design: the Claude starburst (the same path data as `landing/assets/claude-mark.svg`) scaled 0.34x and centered inside the dark rounded square used by the other fan-club product marks. The reason: the Claude starburst reads as "AI / Claude-y" in a product grid faster than the chat bubble, and visually differentiates from PostApprove (green gradient `P`) and Bulk Uploader (upload arrow).

If the mark needs to change (the Claude logo evolves, the design shifts):

1. Edit `followr-fan-club/assets/products/mcp-mark.svg` directly.
2. Redeploy the fan club: `zsh -ic "cd /Users/marcosplazadeayala/Documents/Claude/proyectos/Followr/followr-fan-club && npx wrangler pages deploy . --project-name=followr-fan-club --branch=main"`.

If the tagline or tags need to change, the source of truth is `followr-fan-club/i18n.js` for the tagline (the English string in `index.html` is only a fallback) and `followr-fan-club/index.html` for the tags.

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
    favicon.svg           same as mcp-mark.svg (browser tab icon)
    og-image.svg          social share card (1200x630)
    mcp-mark.svg          chat bubble + Followr star (favicon + nav)
    claude-mark.svg       11-ray coral starburst (chat bubble label, Claude
                          client badges, hero watermark, fan-club product card)
```

## Pages

- `index.html` is the marketing page. Hero, demo, capabilities, install snippets, trust, CTA.
- `install.html` is a step-by-step install article. Linked from `index.html` inside the install section. Path 1 is Claude Code (CLI, easier). Path 2 is Claude Desktop (GUI). Same nav, same footer, same JS, same translations. New keys live under `guide.*` in `app.js`.

When adding a new language, the `guide.*` keys must be translated too or the guide page will display `[key]` placeholders.
