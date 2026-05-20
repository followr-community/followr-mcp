(function () {
  "use strict";

  var STORAGE_KEY = "followrmcp-locale";

  var locales = [
    { code: "en", label: "English", short: "EN" },
    { code: "es", label: "Español", short: "ES" }
  ];

  var translations = {
    en: {
      "nav.unofficial": "unofficial",
      "nav.github": "GitHub",
      "nav.install": "Install",
      "nav.home": "Home",

      "code.copy": "Copy",
      "code.copied": "Copied",
      "code.error": "Error",

      "hero.eyebrow": "MODEL CONTEXT PROTOCOL",
      "hero.titleLine1": "Don’t open Followr.",
      "hero.titleLine2": "Just ask.",
      "hero.subtitle": "An MCP server that lets Claude, Cursor and any MCP client run your Followr workspace by prompt. Schedule posts, generate avatar videos, triage DMs, launch full campaigns. No tab‑switching.",
      "hero.ctaInstall": "Install in 1 minute",
      "hero.ctaDemo": "See it in action",
      "hero.stat1": "tools",
      "hero.stat2": "resources",
      "hero.stat3": "workflows",
      "hero.stat4": "npm install",

      "demo.eyebrow": "DEMO",
      "demo.title": "It looks like this in your chat.",
      "demo.sub": "Three real conversations. Click a tab to switch.",
      "demo.tab1": "Campaign launch",
      "demo.tab2": "Avatar reels",
      "demo.tab3": "DM triage",
      "demo.you": "you",
      "demo.c0.user": "Spin up a 7‑day campaign for our March cardigan drop. Launch March 15 at 10 AM Buenos Aires. Instagram, X and LinkedIn.",
      "demo.c0.a1": "Done. Queued in your Acme workspace:",
      "demo.c0.l1": "3 teasers between March 12 and 14",
      "demo.c0.l2": "1 launch post March 15 at 10 AM Buenos Aires",
      "demo.c0.l3": "3 follow‑ups across March 17 to 20",
      "demo.c0.l4": "tag “cardigan‑drop‑march” applied to all 7",
      "demo.c0.a2": "Hero image generated in your brand palette. Approve, or want to review first?",
      "demo.c0.chip1": "read brand voice",
      "demo.c0.chip2": "generated hero",
      "demo.c0.chip3": "created 7 drafts",
      "demo.c0.chip4": "scheduled across 3 networks",
      "demo.c1.user": "Make 5 short avatar reels about productivity for next week. Use Sofia. Schedule one per day at 8 AM.",
      "demo.c1.a1": "Picked Sofia from your library. Here’s the slate:",
      "demo.c1.l1": "Mon: the two‑minute rule",
      "demo.c1.l2": "Tue: protect your first hour",
      "demo.c1.l3": "Wed: time‑blocking without guilt",
      "demo.c1.l4": "Thu: when to say no",
      "demo.c1.l5": "Fri: a 10‑minute weekly review",
      "demo.c1.a2": "Each reel runs about 700 credits. Your balance is fine. Green‑light all 5?",
      "demo.c1.chip1": "listed avatars",
      "demo.c1.chip2": "checked credits",
      "demo.c1.chip3": "drafted 5 scripts",
      "demo.c2.user": "Any unread DMs? Show me everything and draft replies in my voice.",
      "demo.c2.a1": "4 unread across networks:",
      "demo.c2.l1": "Instagram: 2 (stock question + collab pitch)",
      "demo.c2.l2": "Facebook: 1 (shipping complaint, order #4421)",
      "demo.c2.l3": "X: 1 (podcast mention)",
      "demo.c2.a2": "Drafts ready in your voice. Want me to send them, or do you want to edit first?",
      "demo.c2.chip1": "scanned 4 inboxes",
      "demo.c2.chip2": "drafted 4 replies",
      "demo.disclaimer": "Mocked for illustration. Wording and tools are real. Your AI client decides the exact phrasing.",

      "cap.eyebrow": "WHAT YOU CAN DO",
      "cap.title": "Six surfaces. One conversation.",
      "cap.c1.title": "Schedule",
      "cap.c1.body": "Post groups, drafts, multi‑network schedules, calendars, time‑zones honored automatically.",
      "cap.c1.prompt": "“Schedule this carousel for Tuesday at 9 AM in IG and FB.”",
      "cap.c2.title": "Generate",
      "cap.c2.body": "Text, images, audio, lipsync clips, multi‑scene avatar reels with subtitles. All from natural prompts.",
      "cap.c2.prompt": "“Generate 3 image variants in our brand palette.”",
      "cap.c3.title": "Avatars & voices",
      "cap.c3.body": "Pick or create avatars, pull ElevenLabs voices, render reels with burned‑in subtitles and outfit consistency.",
      "cap.c3.prompt": "“Create an avatar from this photo. Warm Argentine voice.”",
      "cap.c4.title": "Social inbox",
      "cap.c4.body": "DMs, comments, contacts, conversations across every connected network. Triage and draft replies in one pass.",
      "cap.c4.prompt": "“Reply to every unread DM. Soft tone, no emoji.”",
      "cap.c5.title": "Validate",
      "cap.c5.body": "Per‑network spec checks before you publish: caption length, asset count, video duration, aspect ratio, account tier.",
      "cap.c5.prompt": "“Will this run on Twitter Basic? Validate first.”",
      "cap.c6.title": "Workspaces",
      "cap.c6.body": "Multi‑company brand voice, tags, folders, Autopilot rules, Canva imports, analytics. One API key, every workspace.",
      "cap.c6.prompt": "“In Acme: what posts ran best last month?”",

      "wf.eyebrow": "PRESETS",
      "wf.title": "Five workflows that ship in the box.",
      "wf.sub": "Multi‑step orchestrations exposed as MCP prompts. Pick one and your AI runs the whole sequence.",
      "wf.w1.title": "Weekly Brief",
      "wf.w1.body": "Hand it a brief. Get a full week of posts drafted in brand voice, balanced across networks, scheduled day by day.",
      "wf.w2.title": "Campaign Launch",
      "wf.w2.body": "Tag taxonomy, hero asset, teasers, launch post, follow‑ups. All scheduled, all tagged, all in one prompt.",
      "wf.w3.title": "Video Series",
      "wf.w3.body": "N avatar reels on one topic. Distinct angles, lipsync renders, scheduled at your chosen cadence.",
      "wf.w4.title": "Crisis Response",
      "wf.w4.body": "Three response variants (apology / clarification / deflection) staged as drafts. A human picks one and publishes.",
      "wf.w5.title": "URL Repurpose",
      "wf.w5.body": "Drop a blog or article URL. Get a thread, a carousel, a LinkedIn post and a video script. Tailored per network.",
      "wf.w6.title": "Your own.",
      "wf.w6.body": "Compose any of the 72 tools into a custom workflow. Or fork the repo and add a preset.",
      "wf.w6.link": "Open the repo →",

      "per.eyebrow": "USE CASES",
      "per.title": "For everyone who lives in a chat window.",
      "per.p1.tag": "AGENCY",
      "per.p1.title": "Twelve clients. One prompt.",
      "per.p1.body": "Switch workspaces with a sentence. Compare calendars. Push the same campaign across all of them.",
      "per.p1.quote": "“In every workspace: list posts scheduled for next week.”",
      "per.p2.tag": "SOLO CREATOR",
      "per.p2.title": "Stop tab‑hopping. Ship.",
      "per.p2.body": "Write the post, generate the visual, schedule it, walk away. The dashboard is a chat.",
      "per.p2.quote": "“Turn this newsletter into a carousel and a Reel.”",
      "per.p3.tag": "CAMPAIGN PLANNER",
      "per.p3.title": "Three days of prep. One paragraph.",
      "per.p3.body": "Brief the AI like you’d brief a junior planner. Get a full campaign back, tagged and scheduled.",
      "per.p3.quote": "“Build the March 15 launch. Teasers, launch, follow‑ups.”",
      "per.p4.tag": "COMMUNITY MANAGER",
      "per.p4.title": "Every inbox. One window.",
      "per.p4.body": "Triage DMs and comments across every network. Draft replies in brand voice. Approve, edit, send.",
      "per.p4.quote": "“Show me everything unread. Draft replies.”",

      "cli.eyebrow": "COMPATIBLE WITH",
      "cli.title": "Bring your own AI.",
      "cli.sub": "MCP is an open protocol. If your client speaks it, Followr fits.",
      "cli.other": "+ any MCP client",

      "ins.eyebrow": "INSTALL",
      "ins.title": "One npm command. One API key. Done.",
      "ins.sub": "No build step. No service to host. The MCP runs as a subprocess of your AI client.",
      "ins.guideLink": "<strong>New to MCPs?</strong> Read the full step-by-step install guide.",
      "ins.guideLinkArrow": "Open guide →",
      "ins.planNote": "<strong>Heads up:</strong> the Followr API is available on plans that include API access, or on plans with the API key add-on. If your plan does not include it, the MCP will install but every call will return 401. Check this inside <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">your Followr account</a> first.",
      "ins.t0.step": "From inside Claude Desktop: profile picture (bottom-left) → <strong>Settings</strong> → <strong>Developer</strong> → <strong>Edit Config</strong>. Paste this into <code>claude_desktop_config.json</code>:",
      "ins.t0.note": "Fully close Claude Desktop (Cmd+Q on macOS, system tray → Quit on Windows) and open it again from scratch. Closing the window is not enough. The first <code>npx</code> download takes 5 to 10 seconds; cached after.",
      "ins.t1.step": "Run this once. <code>--scope user</code> makes the MCP available in every project.",
      "ins.t1.note": "Single quotes around the env var are mandatory. Followr API keys contain a pipe (<code>|</code>) which the shell would otherwise truncate.",
      "ins.t2.step": "Edit <code>~/.cursor/mcp.json</code> (or use <em>Cursor Settings → MCP</em>):",
      "ins.t2.note": "Same JSON shape as Claude Desktop. Reload Cursor and the connector appears.",
      "ins.token.title": "Need a Followr API key?",
      "ins.token.s1": "Sign in to <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">Followr</a>.",
      "ins.token.s2": "Click your profile picture in the top-left → select <strong>API Keys</strong> from the dropdown (or open the <a href=\"https://app.followr.ai/settings/api-keys\" target=\"_blank\" rel=\"noopener noreferrer\">API Keys settings</a> directly).",
      "ins.token.s3": "<strong>Generate</strong>, name it (e.g. “Claude MCP”), copy the API key. Followr only shows it once.",

      "trust.eyebrow": "YOUR API KEY",
      "trust.title": "Stays where you put it.",
      "trust.t1.title": "Local subprocess",
      "trust.t1.body": "The MCP runs on your machine. Your API key lives in your AI client’s config file. The only host that ever sees it is <code>api.followr.ai</code>.",
      "trust.t2.title": "Never logged",
      "trust.t2.body": "The MCP doesn’t write the API key to disk, doesn’t print it, doesn’t send it anywhere else. Verify in the source.",
      "trust.t3.title": "Open source. MIT.",
      "trust.t3.body": "Every tool, every API call, every line of code. Auditable. Forkable. PRs welcome.",

      "cta.title": "Ready to plug Followr into your AI chat?",
      "cta.sub": "One npm install, one API key, zero new dashboards.",
      "cta.install": "Install in 1 minute",
      "cta.github": "Star on GitHub",
      "cta.secondary": "Want to read the API behind it?",
      "cta.docs": "Community docs →",

      "footer.disclaimer": "Followr MCP. Maintained by Followr Community Maintainers. Not endorsed by, affiliated with, or supported by Followr Inc. For official support, contact support@followr.ai.",
      "footer.madeWith": "made with care · 2026",

      "guide.back": "Back to home",
      "guide.eyebrow": "DETAILED GUIDE",
      "guide.title": "Install the Followr MCP, step by step.",
      "guide.subtitle": "From a clean machine to a working connector in five minutes. Pick the path that matches your comfort with the terminal. The end result is the same: Claude (or any MCP client) talking to your Followr workspace.",
      "guide.toc.prereq": "Prerequisites",
      "guide.toc.token": "Get your API key",
      "guide.toc.optB": "Claude Code",
      "guide.toc.optA": "Claude Desktop",
      "guide.toc.trouble": "Troubleshooting",

      "guide.fork.eyebrow": "PICK ONE",
      "guide.fork.title": "The next two sections are alternatives. You only do one.",
      "guide.fork.body": "Pick the option that matches the AI client you actually use. Section 03 (Option A) is for Claude Code (terminal). Section 04 (Option B) is for Claude Desktop (app). Doing both is not necessary and not recommended.",
      "guide.fork.optA.title": "Claude Code (CLI)",
      "guide.fork.optA.sub": "One terminal command. Recommended.",
      "guide.fork.optB.title": "Claude Desktop (app)",
      "guide.fork.optB.sub": "Edit a JSON config file.",
      "guide.fork.or": "OR",

      "guide.s1.eyebrow": "01 · PREREQUISITES",
      "guide.s1.title": "Three things before you start.",
      "guide.s1.intro": "If any of these are missing the install will fail. Check them now, save yourself five minutes of debugging later.",
      "guide.s1.c1.title": "Node.js 20 or newer",
      "guide.s1.c1.body": "Open a terminal and run <code>node --version</code>. If you see <code>v20</code> or higher, you are set. If the command is missing or the version is older, install the LTS build from <a href=\"https://nodejs.org\" target=\"_blank\" rel=\"noopener noreferrer\">nodejs.org</a> and restart your terminal.",
      "guide.s1.c2.title": "A Followr plan with API access",
      "guide.s1.c2.body": "API keys are only available on plans that include API access, or on plans with the API key add-on enabled. If your current plan does not include it, the MCP will install fine but every call will return 401. Check or upgrade your plan in <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">your Followr account</a> before you continue.",
      "guide.s1.c3.title": "A Followr API key",
      "guide.s1.c3.body": "A long string Followr generates for you. The MCP reads it at startup and uses it to authenticate every call. We walk through generating one in the next section.",

      "guide.s2.eyebrow": "02 · API KEY",
      "guide.s2.title": "Generate your API key.",
      "guide.s2.intro": "One API key works for every workspace under your account. Generate it once, paste it into your AI client, forget it exists.",
      "guide.s2.st1.title": "Sign in to <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">Followr</a>.",
      "guide.s2.st1.body": "Use the account whose workspaces you want to expose to the AI client. The API key will inherit your permissions.",
      "guide.s2.st2.title": "Click your profile picture in the top-left and select API Keys from the dropdown menu.",
      "guide.s2.st2.body": "Shortcut: open the <a href=\"https://app.followr.ai/settings/api-keys\" target=\"_blank\" rel=\"noopener noreferrer\">API Keys settings</a> directly.",
      "guide.s2.st3.title": "Click Generate, name it, copy the API key.",
      "guide.s2.st3.body": "Name it something you will recognize later, like “Claude MCP” or “My laptop”. Copy the API key immediately. Followr shows the full string only once.",
      "guide.s2.warn.head": "Treat the API key like a password.",
      "guide.s2.warn.body": " Never paste it into a chat, an issue, a screenshot, or a Slack thread. Paste it only into your local terminal or a config file on your own machine. If an API key leaks, revoke it from the same screen and generate a new one.",

      "guide.s3.eyebrow": "03 · OPTION A",
      "guide.s3.chip": "recommended",
      "guide.s3.title": "Claude Code (CLI).",
      "guide.s3.intro": "If you use Claude Code, this is the option for you. One terminal command, one verification, done. Skip Option B below.",
      "guide.s3.st1.title": "Open your terminal and paste this command.",
      "guide.s3.st1.body": "Replace <code>PASTE_YOUR_API_KEY_HERE</code> with the API key you copied. Then press Enter.",
      "guide.s3.callout.head": "The single quotes matter.",
      "guide.s3.callout.body": " Followr API keys contain a pipe character (<code>|</code>). Without single quotes the shell interprets the pipe as a pipe operator, truncates the API key, and every call returns 401.",
      "guide.s3.st2.title": "Verify the connection.",
      "guide.s3.st2.body": "Run this and confirm both lines:",
      "guide.s3.st2.note": "If you see <code>Scope: Local config</code> instead, the MCP is only visible inside the directory where you ran the command. Remove it (<code>claude mcp remove followr</code>) and re-run the install with <code>--scope user</code>.",
      "guide.s3.st3.title": "Try a real prompt.",
      "guide.s3.st3.body": "Inside Claude Code, ask “List my Followr workspaces” or “Show me the next scheduled posts”. If you get real data back, you are done.",

      "guide.s4.eyebrow": "04 · OPTION B",
      "guide.s4.chip": "alternative",
      "guide.s4.title": "Claude Desktop.",
      "guide.s4.intro": "Only follow this option if you did NOT already do Option A above. A JSON config file lives somewhere on your machine. We open it, paste a block, save it, and restart Claude. No terminal required if you use the in-app shortcut.",
      "guide.s4.h1": "Step 1. Open the config from inside the app.",
      "guide.s4.h1.s1.title": "Open Claude Desktop.",
      "guide.s4.h1.s1.body": "If you don't have it yet, download it from <a href=\"https://claude.ai/download\" target=\"_blank\" rel=\"noopener noreferrer\">claude.ai/download</a> and sign in with your Anthropic account. The web app at claude.ai cannot run local MCPs, so the desktop app is required for this path.",
      "guide.s4.h1.s2.title": "Click your profile picture in the bottom-left corner of the Claude window.",
      "guide.s4.h1.s2.body": "A menu opens.",
      "guide.s4.h1.s3.title": "Go to Settings → Developer → Edit Config.",
      "guide.s4.h1.s3.body": "That opens the folder containing <code>claude_desktop_config.json</code>. Double-click the file to open it in your default text editor (TextEdit, Notepad, VS Code, whatever you have). If the file does not exist yet, create one inside that folder with that exact name.",
      "guide.s4.h2": "Step 2. Paste the Followr block.",
      "guide.s4.h2.intro": "If the file is empty, paste exactly this:",
      "guide.s4.h2.append": "If the file already has other MCPs configured, only add the <code>\"followr\"</code> block inside <code>\"mcpServers\"</code>, separated by a comma from the previous block:",
      "guide.s4.h2.callout.head": "The comma is required.",
      "guide.s4.h2.callout.body": " If you forget it between MCP blocks the JSON becomes invalid and Claude won't load any connector, not just Followr. When in doubt paste the whole file into <a href=\"https://jsonlint.com\" target=\"_blank\" rel=\"noopener noreferrer\">jsonlint.com</a>.",
      "guide.s4.h3": "Step 3. Paste your API key and save the file.",
      "guide.s4.h3.body": "Replace <code>PASTE_YOUR_API_KEY_HERE</code> with the API key you copied from Followr. Keep the double quotes around it. The result looks like:",
      "guide.s4.h3.save": "Save the file with Cmd+S (macOS) or Ctrl+S (Windows).",
      "guide.s4.h4": "Step 4. Fully close Claude Desktop. Then open it again.",
      "guide.s4.h4.callout.head": "Closing only the window is NOT enough.",
      "guide.s4.h4.callout.body": " Claude keeps running in the background and will not reload the config file until it's fully closed. After closing the window, follow the instructions for your OS below, then open the app again from scratch.",
      "guide.s4.h4.mac.head": "macOS:",
      "guide.s4.h4.mac.body": "Menu bar → Claude → Quit Claude (or press Cmd+Q). Then reopen from the Dock or Spotlight.",
      "guide.s4.h4.win.head": "Windows:",
      "guide.s4.h4.win.body": "Right-click the Claude icon in the system tray (next to the clock) → Quit. Then open Claude again from the Start menu.",
      "guide.s4.h4.lin.head": "Linux:",
      "guide.s4.h4.lin.body": "Close the app fully, kill any lingering process if needed, then open it again.",
      "guide.s4.h5": "Step 5. Confirm the MCP is connected.",
      "guide.s4.h5.body": "Inside a new chat, click the tools or plug icon below the message box. You should see <code>followr</code> listed. The first time the connector loads, expect a 5 to 10 second delay while <code>npx</code> downloads <code>@followr/mcp</code>. Subsequent launches are instant.",
      "guide.s4.alt.title": "Alternative: locate the config file manually.",
      "guide.s4.alt.intro": "If the in-app shortcut doesn't work for any reason, the file lives at one of these paths. Open it directly with your editor.",
      "guide.s4.alt.mac": "On macOS, the fastest way to reach that folder is Finder → Go → Go to Folder (Cmd+Shift+G), then paste <code>~/Library/Application Support/Claude/</code>.",

      "guide.s5.eyebrow": "05 · TROUBLESHOOTING",
      "guide.s5.title": "Common errors and fixes.",
      "guide.s5.e1.title": "Every call returns 401 Unauthorized.",
      "guide.s5.e1.body": "Either the API key was truncated by the shell (missing single quotes on Claude Code), there is an extra space when you pasted it, or your plan does not include API access. Re-check the API key character by character and verify your plan inside <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">Followr</a>.",
      "guide.s5.e2.title": "The followr connector doesn't appear in Claude Desktop.",
      "guide.s5.e2.body": "Almost always invalid JSON. Paste the full file into <a href=\"https://jsonlint.com\" target=\"_blank\" rel=\"noopener noreferrer\">jsonlint.com</a>. The most frequent cause is a missing comma between MCP blocks. Also confirm you fully quit Claude (Cmd+Q on macOS, system tray on Windows), not just closed the window.",
      "guide.s5.e3.title": "“command not found: npx”.",
      "guide.s5.e3.body": "Node.js is not installed or not on your PATH. Install LTS from <a href=\"https://nodejs.org\" target=\"_blank\" rel=\"noopener noreferrer\">nodejs.org</a>, restart your terminal, restart your AI client, try again.",
      "guide.s5.e4.title": "First call hangs for several seconds.",
      "guide.s5.e4.body": "Normal on first run. <code>npx</code> is downloading the package (~25 MB cached in <code>~/.npm/_npx/</code>). Every launch after the first is instant. To pre-warm, run <code>npx -y @followr/mcp --version || true</code> in your terminal.",
      "guide.s5.e5.title": "claude.ai (web) does not list local MCPs.",
      "guide.s5.e5.body": "Expected. The browser version of claude.ai only supports remote HTTP connectors, not local stdio servers. For now, use Claude Desktop, Claude Code, or any other client listed on the home page.",
      "guide.s5.e6.title": "API key leaked. What now?",
      "guide.s5.e6.body": "Open the <a href=\"https://app.followr.ai/settings/api-keys\" target=\"_blank\" rel=\"noopener noreferrer\">API Keys settings</a>, revoke the leaked API key, generate a new one, update your config file or rerun <code>claude mcp add</code>, restart your AI client.",

      "guide.cta.title": "All set. What next?",
      "guide.cta.sub": "Open Claude and ask it to list your next scheduled posts. If it answers with real data, the connector is live.",
      "guide.cta.home": "Back to home",
      "guide.cta.github": "Star on GitHub",
      "guide.cta.secondary": "Want to peek at the API behind it?",
      "guide.cta.docs": "Community docs →"
    },

    es: {
      "nav.unofficial": "no oficial",
      "nav.github": "GitHub",
      "nav.install": "Instalar",
      "nav.home": "Inicio",

      "code.copy": "Copiar",
      "code.copied": "Copiado",
      "code.error": "Error",

      "hero.eyebrow": "MODEL CONTEXT PROTOCOL",
      "hero.titleLine1": "No abras Followr.",
      "hero.titleLine2": "Pedíselo.",
      "hero.subtitle": "Un servidor MCP que permite a Claude, Cursor y cualquier cliente MCP manejar tu workspace de Followr por prompt. Programá posts, generá reels con avatar, triagá DMs, lanzá campañas enteras. Sin tab‑hopping.",
      "hero.ctaInstall": "Instalá en 1 minuto",
      "hero.ctaDemo": "Mirálo en acción",
      "hero.stat1": "tools",
      "hero.stat2": "resources",
      "hero.stat3": "workflows",
      "hero.stat4": "npm install",

      "demo.eyebrow": "DEMO",
      "demo.title": "Se ve así en tu chat.",
      "demo.sub": "Tres conversaciones reales. Cliquea una solapa para cambiar.",
      "demo.tab1": "Lanzamiento de campaña",
      "demo.tab2": "Reels con avatar",
      "demo.tab3": "Triaje de DMs",
      "demo.you": "vos",
      "demo.c0.user": "Armame una campaña de 7 días para el drop de cardigans de marzo. Lanzamiento el 15 de marzo a las 10 AM Buenos Aires. Instagram, X y LinkedIn.",
      "demo.c0.a1": "Listo. Queued en tu workspace de Acme:",
      "demo.c0.l1": "3 teasers entre el 12 y el 14 de marzo",
      "demo.c0.l2": "1 post de lanzamiento el 15 a las 10 AM Buenos Aires",
      "demo.c0.l3": "3 follow‑ups del 17 al 20 de marzo",
      "demo.c0.l4": "tag “cardigan‑drop‑marzo” aplicado a los 7",
      "demo.c0.a2": "Hero generada en la paleta de marca. ¿Apruebo o querés revisar antes?",
      "demo.c0.chip1": "leí brand voice",
      "demo.c0.chip2": "generé hero",
      "demo.c0.chip3": "creé 7 borradores",
      "demo.c0.chip4": "programé en 3 redes",
      "demo.c1.user": "Hacelas a 5 reels cortos con avatar sobre productividad para la semana que viene. Usá a Sofía. Uno por día a las 8 AM.",
      "demo.c1.a1": "Elegí a Sofía de tu biblioteca. La grilla:",
      "demo.c1.l1": "Lun: la regla de los dos minutos",
      "demo.c1.l2": "Mar: protegé tu primera hora",
      "demo.c1.l3": "Mié: time‑blocking sin culpa",
      "demo.c1.l4": "Jue: cuándo decir que no",
      "demo.c1.l5": "Vie: revisión semanal en 10 minutos",
      "demo.c1.a2": "Cada reel cuesta unos 700 créditos. Tu saldo alcanza. ¿Lanzo los 5?",
      "demo.c1.chip1": "listé avatares",
      "demo.c1.chip2": "chequé créditos",
      "demo.c1.chip3": "redacté 5 guiones",
      "demo.c2.user": "¿Hay DMs sin leer? Mostrame todo y armá borradores en mi tono.",
      "demo.c2.a1": "4 sin leer entre todas las redes:",
      "demo.c2.l1": "Instagram: 2 (consulta de stock + propuesta de colab)",
      "demo.c2.l2": "Facebook: 1 (queja del envío del pedido #4421)",
      "demo.c2.l3": "X: 1 (mención del podcast)",
      "demo.c2.a2": "Borradores listos en tu tono. ¿Los mando o querés editar antes?",
      "demo.c2.chip1": "escaneé 4 inboxes",
      "demo.c2.chip2": "redacté 4 respuestas",
      "demo.disclaimer": "Mockup ilustrativo. El wording y las tools son reales. Tu cliente de IA decide la frase exacta.",

      "cap.eyebrow": "QUÉ PODES HACER",
      "cap.title": "Seis superficies. Una conversación.",
      "cap.c1.title": "Programar",
      "cap.c1.body": "Post groups, borradores, calendarios multi‑red, zonas horarias respetadas automáticamente.",
      "cap.c1.prompt": "“Programá este carousel para el martes a las 9 AM en IG y FB.”",
      "cap.c2.title": "Generar",
      "cap.c2.body": "Texto, imágenes, audio, clips lipsync, reels multi‑escena con subtítulos. Todo por prompt.",
      "cap.c2.prompt": "“Generá 3 variantes en la paleta de marca.”",
      "cap.c3.title": "Avatares y voces",
      "cap.c3.body": "Elegí o creá avatares, traé voces de ElevenLabs, renderá reels con subtítulos quemados y outfit consistente.",
      "cap.c3.prompt": "“Creá un avatar con esta foto. Voz argentina cálida.”",
      "cap.c4.title": "Inbox social",
      "cap.c4.body": "DMs, comentarios, contactos, conversaciones en cada red conectada. Triaje y borradores en una pasada.",
      "cap.c4.prompt": "“Contestá cada DM sin leer. Tono suave, sin emoji.”",
      "cap.c5.title": "Validar",
      "cap.c5.body": "Specs por red antes de publicar: largo de caption, cantidad de assets, duración de video, aspect ratio, tier de cuenta.",
      "cap.c5.prompt": "“¿Esto corre en Twitter Basic? Validá primero.”",
      "cap.c6.title": "Workspaces",
      "cap.c6.body": "Brand voice multi‑empresa, tags, folders, reglas de Autopilot, imports de Canva, analytics. Una API key, todos los workspaces.",
      "cap.c6.prompt": "“En Acme: ¿qué posts funcionaron mejor el mes pasado?”",

      "wf.eyebrow": "PRESETS",
      "wf.title": "Cinco workflows que vienen de fábrica.",
      "wf.sub": "Orquestaciones multi‑step expuestas como prompts MCP. Elegí uno y tu IA corre la secuencia completa.",
      "wf.w1.title": "Brief semanal",
      "wf.w1.body": "Le pasás un brief. Te devuelve una semana entera de posts en brand voice, balanceada por red, programada día a día.",
      "wf.w2.title": "Lanzamiento de campaña",
      "wf.w2.body": "Tag taxonomía, hero asset, teasers, lanzamiento, follow‑ups. Todo programado, todo tagueado, en un prompt.",
      "wf.w3.title": "Serie de videos",
      "wf.w3.body": "N reels con avatar sobre un mismo tema. Ángulos distintos, renders lipsync, programados al cadence que elijas.",
      "wf.w4.title": "Respuesta de crisis",
      "wf.w4.body": "Tres variantes de respuesta (disculpa / aclaración / deflección) como borradores. Un humano elige y publica.",
      "wf.w5.title": "Repurpose de URL",
      "wf.w5.body": "Le pasás la URL de un blog. Te devuelve un hilo, un carousel, un post de LinkedIn y un script de video. Ajustado por red.",
      "wf.w6.title": "El tuyo.",
      "wf.w6.body": "Componé cualquiera de las 72 tools en un workflow propio. O forkeá el repo y agregá un preset.",
      "wf.w6.link": "Abrir el repo →",

      "per.eyebrow": "CASOS DE USO",
      "per.title": "Para quien vive adentro de una ventana de chat.",
      "per.p1.tag": "AGENCIA",
      "per.p1.title": "Doce clientes. Un prompt.",
      "per.p1.body": "Cambiá de workspace con una frase. Compará calendarios. Empujá la misma campaña a todos.",
      "per.p1.quote": "“En cada workspace: listá los posts programados para la semana que viene.”",
      "per.p2.tag": "CREADOR SOLO",
      "per.p2.title": "Se acabó el tab‑hopping. Subilo.",
      "per.p2.body": "Escribí el post, generá el visual, programálo, anda a hacer otra cosa. El dashboard es un chat.",
      "per.p2.quote": "“Convertí este newsletter en un carousel y un Reel.”",
      "per.p3.tag": "PLANNER DE CAMPAÑAS",
      "per.p3.title": "Tres días de prep. Un párrafo.",
      "per.p3.body": "Briefá a la IA como brieferiás a un planner junior. Te devuelve una campaña entera, tagueada y programada.",
      "per.p3.quote": "“Armá el lanzamiento del 15 de marzo. Teasers, lanzamiento, follow‑ups.”",
      "per.p4.tag": "COMMUNITY MANAGER",
      "per.p4.title": "Cada inbox. Una ventana.",
      "per.p4.body": "Triajá DMs y comentarios en cada red. Redactá respuestas en brand voice. Aprobá, editá, mandá.",
      "per.p4.quote": "“Mostrame todo lo no leído. Redactá respuestas.”",

      "cli.eyebrow": "COMPATIBLE CON",
      "cli.title": "Traé tu propia IA.",
      "cli.sub": "MCP es un protocolo abierto. Si tu cliente lo habla, Followr entra.",
      "cli.other": "+ cualquier cliente MCP",

      "ins.eyebrow": "INSTALAR",
      "ins.title": "Un comando npm. Una API key. Listo.",
      "ins.sub": "Sin build step. Sin servicio que hostear. El MCP corre como subprocess de tu cliente de IA.",
      "ins.guideLink": "<strong>¿Primera vez con un MCP?</strong> Leé la guía de instalación paso a paso.",
      "ins.guideLinkArrow": "Abrir guía →",
      "ins.planNote": "<strong>Importante:</strong> la API de Followr está disponible en planes que incluyen acceso a la API, o en planes con el add-on de API key. Si tu plan no lo incluye, el MCP se instala igual pero cada llamada va a devolver 401. Verificá esto en <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">tu cuenta de Followr</a> antes de seguir.",
      "ins.t0.step": "Desde adentro de Claude Desktop: foto de perfil (abajo a la izquierda) → <strong>Configuración</strong> → <strong>Desarrollador</strong> → <strong>Editar configuración</strong>. Pegá esto en <code>claude_desktop_config.json</code>:",
      "ins.t0.note": "Cerrá Claude Desktop por completo (Cmd+Q en macOS, system tray → Quit en Windows) y volvé a abrirla desde cero. Cerrar solo la ventana no alcanza. La primera descarga de <code>npx</code> tarda 5 a 10 segundos; después queda cacheada.",
      "ins.t1.step": "Corré esto una vez. <code>--scope user</code> hace que el MCP esté disponible en todos los proyectos.",
      "ins.t1.note": "Las comillas simples alrededor del env var son obligatorias. Las API keys de Followr contienen un pipe (<code>|</code>) que el shell sino interpreta como pipe y trunca.",
      "ins.t2.step": "Editá <code>~/.cursor/mcp.json</code> (o usá <em>Cursor Settings → MCP</em>):",
      "ins.t2.note": "Mismo formato JSON que Claude Desktop. Recargá Cursor y aparece el connector.",
      "ins.token.title": "¿Necesitás una API key de Followr?",
      "ins.token.s1": "Logueáte en <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">Followr</a>.",
      "ins.token.s2": "Cliqueá tu foto de perfil arriba a la izquierda → elegí <strong>API Keys</strong> del menú desplegable (o abrí la <a href=\"https://app.followr.ai/settings/api-keys\" target=\"_blank\" rel=\"noopener noreferrer\">configuración de API Keys</a> directamente).",
      "ins.token.s3": "<strong>Generate</strong>, nombrála (por ej. “Claude MCP”), copiá la API key. Followr la muestra una sola vez.",

      "trust.eyebrow": "TU API KEY",
      "trust.title": "Se queda donde lo pusiste.",
      "trust.t1.title": "Subprocess local",
      "trust.t1.body": "El MCP corre en tu máquina. Tu API key vive en el config file de tu cliente de IA. El único host que la ve es <code>api.followr.ai</code>.",
      "trust.t2.title": "Nunca logueado",
      "trust.t2.body": "El MCP no escribe la API key a disco, no la printea, no la manda a ningún otro lado. Verificable en la source.",
      "trust.t3.title": "Open source. MIT.",
      "trust.t3.body": "Cada tool, cada llamada al API, cada línea de código. Auditable. Forkeable. PRs bienvenidas.",

      "cta.title": "¿Listo para enchufar Followr a tu chat de IA?",
      "cta.sub": "Un npm install, una API key, cero dashboards nuevos.",
      "cta.install": "Instalá en 1 minuto",
      "cta.github": "Estrella en GitHub",
      "cta.secondary": "¿Querés leer la API detrás?",
      "cta.docs": "Doc de la comunidad →",

      "footer.disclaimer": "Followr MCP. Mantenido por Followr Community Maintainers. Sin endorsement, sin afiliación, sin soporte de Followr Inc. Para soporte oficial, escribí a support@followr.ai.",
      "footer.madeWith": "hecho con cariño · 2026",

      "guide.back": "Volver al inicio",
      "guide.eyebrow": "GUÍA DETALLADA",
      "guide.title": "Instalá el Followr MCP, paso a paso.",
      "guide.subtitle": "De máquina limpia a connector funcionando en cinco minutos. Elegí el camino según tu comodidad con la terminal. El resultado es el mismo: Claude (o cualquier cliente MCP) hablándole a tu workspace de Followr.",
      "guide.toc.prereq": "Requisitos",
      "guide.toc.token": "Conseguí tu API key",
      "guide.toc.optB": "Claude Code",
      "guide.toc.optA": "Claude Desktop",
      "guide.toc.trouble": "Solución de problemas",

      "guide.fork.eyebrow": "ELEGÍ UNA",
      "guide.fork.title": "Las dos secciones siguientes son alternativas. Hacés una sola.",
      "guide.fork.body": "Elegí la opción que coincida con el cliente de IA que usás. La Sección 03 (Opción A) es para Claude Code (terminal). La Sección 04 (Opción B) es para Claude Desktop (app). Hacer las dos no es necesario y no se recomienda.",
      "guide.fork.optA.title": "Claude Code (CLI)",
      "guide.fork.optA.sub": "Un comando en la terminal. Recomendada.",
      "guide.fork.optB.title": "Claude Desktop (app)",
      "guide.fork.optB.sub": "Editar un archivo JSON de configuración.",
      "guide.fork.or": "O",

      "guide.s1.eyebrow": "01 · REQUISITOS",
      "guide.s1.title": "Tres cosas antes de empezar.",
      "guide.s1.intro": "Si falta cualquiera de estas, la instalación falla. Chequealas ahora y ahorrate cinco minutos de debug después.",
      "guide.s1.c1.title": "Node.js 20 o más nuevo",
      "guide.s1.c1.body": "Abrí una terminal y corré <code>node --version</code>. Si ves <code>v20</code> o superior, listo. Si no aparece el comando o la versión es vieja, bajá el LTS de <a href=\"https://nodejs.org\" target=\"_blank\" rel=\"noopener noreferrer\">nodejs.org</a> y reiniciá la terminal.",
      "guide.s1.c2.title": "Un plan de Followr con acceso a la API",
      "guide.s1.c2.body": "Las API keys están disponibles solo en planes que incluyen acceso a la API, o en planes con el add-on de API key. Si tu plan actual no lo incluye, el MCP se va a instalar igual pero cada llamada va a devolver 401. Revisá o actualizá tu plan en <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">tu cuenta de Followr</a> antes de seguir.",
      "guide.s1.c3.title": "Una API key de Followr",
      "guide.s1.c3.body": "Un string largo que Followr genera para vos. El MCP lo lee al arrancar y lo usa para autenticar cada llamada. La generamos en la siguiente sección.",

      "guide.s2.eyebrow": "02 · API KEY",
      "guide.s2.title": "Generá tu API key.",
      "guide.s2.intro": "Una sola API key sirve para todos los workspaces de tu cuenta. Generala una vez, pegala en tu cliente de IA, olvidate que existe.",
      "guide.s2.st1.title": "Logueáte en <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">Followr</a>.",
      "guide.s2.st1.body": "Usá la cuenta cuyos workspaces querés exponer al cliente de IA. La API key va a heredar tus permisos.",
      "guide.s2.st2.title": "Cliqueá tu foto de perfil arriba a la izquierda y elegí API Keys del menú desplegable.",
      "guide.s2.st2.body": "Atajo: abrí la <a href=\"https://app.followr.ai/settings/api-keys\" target=\"_blank\" rel=\"noopener noreferrer\">configuración de API Keys</a> directamente.",
      "guide.s2.st3.title": "Cliqueá Generate, nombrála, copiá la API key.",
      "guide.s2.st3.body": "Ponele un nombre que reconozcas después, como “Claude MCP” o “Mi notebook”. Copiá la API key al instante. Followr muestra el string completo una sola vez.",
      "guide.s2.warn.head": "Tratá la API key como un password.",
      "guide.s2.warn.body": " Nunca la pegues en un chat, issue, screenshot, o hilo de Slack. Pegala solo en tu terminal local o en un config file de tu propia máquina. Si una API key se filtra, revocála desde la misma pantalla y generá una nueva.",

      "guide.s3.eyebrow": "03 · OPCIÓN A",
      "guide.s3.chip": "recomendada",
      "guide.s3.title": "Claude Code (CLI).",
      "guide.s3.intro": "Si usás Claude Code, esta es la opción para vos. Un comando en la terminal, una verificación, listo. Saltá la Opción B de abajo.",
      "guide.s3.st1.title": "Abrí tu terminal y pegá este comando.",
      "guide.s3.st1.body": "Reemplazá <code>PASTE_YOUR_API_KEY_HERE</code> con la API key que copiaste. Después Enter.",
      "guide.s3.callout.head": "Las comillas simples importan.",
      "guide.s3.callout.body": " Las API keys de Followr tienen un pipe (<code>|</code>). Sin las comillas simples, el shell lo interpreta como pipe operator, trunca la API key, y cada llamada devuelve 401.",
      "guide.s3.st2.title": "Verificá la conexión.",
      "guide.s3.st2.body": "Corré esto y confirmá las dos líneas:",
      "guide.s3.st2.note": "Si ves <code>Scope: Local config</code>, el MCP solo está visible adentro del directorio donde corriste el comando. Removelo (<code>claude mcp remove followr</code>) y volvé a instalar con <code>--scope user</code>.",
      "guide.s3.st3.title": "Probá un prompt real.",
      "guide.s3.st3.body": "Adentro de Claude Code, pedile “Listame mis workspaces de Followr” o “Mostrame los próximos posts programados”. Si te devuelve data real, terminaste.",

      "guide.s4.eyebrow": "04 · OPCIÓN B",
      "guide.s4.chip": "alternativa",
      "guide.s4.title": "Claude Desktop.",
      "guide.s4.intro": "Seguí esta opción SOLO si NO hiciste la Opción A de arriba. Hay un archivo JSON de configuración en algún lugar de tu máquina. Lo abrimos, pegamos un bloque, lo guardamos, y reiniciamos Claude. No hace falta terminal si usás el shortcut adentro de la app.",
      "guide.s4.h1": "Paso 1. Abrí la config desde adentro de la app.",
      "guide.s4.h1.s1.title": "Abrí Claude Desktop.",
      "guide.s4.h1.s1.body": "Si no la tenés instalada, bajála de <a href=\"https://claude.ai/download\" target=\"_blank\" rel=\"noopener noreferrer\">claude.ai/download</a> y logueáte con tu cuenta de Anthropic. La versión web de claude.ai no puede correr MCPs locales, así que para este camino hace falta la app de escritorio.",
      "guide.s4.h1.s2.title": "Cliqueá tu foto de perfil en la esquina inferior izquierda de la ventana de Claude.",
      "guide.s4.h1.s2.body": "Se abre un menú.",
      "guide.s4.h1.s3.title": "Andá a Configuración → Desarrollador → Editar configuración.",
      "guide.s4.h1.s3.body": "Eso abre la carpeta donde vive <code>claude_desktop_config.json</code>. Doble click al archivo para abrirlo con tu editor de texto por defecto (TextEdit, Notepad, VS Code, lo que tengas). Si el archivo todavía no existe, creá uno en esa carpeta con ese nombre exacto.",
      "guide.s4.h2": "Paso 2. Pegá el bloque de Followr.",
      "guide.s4.h2.intro": "Si el archivo está vacío, pegá exactamente esto:",
      "guide.s4.h2.append": "Si el archivo ya tiene otros MCPs configurados, agregá solo el bloque <code>\"followr\"</code> adentro de <code>\"mcpServers\"</code>, separado por una coma del bloque anterior:",
      "guide.s4.h2.callout.head": "La coma es obligatoria.",
      "guide.s4.h2.callout.body": " Si te olvidás de la coma entre bloques de MCP, el JSON queda inválido y Claude no levanta ningún connector, no solo Followr. Si dudás, pegá todo el archivo en <a href=\"https://jsonlint.com\" target=\"_blank\" rel=\"noopener noreferrer\">jsonlint.com</a>.",
      "guide.s4.h3": "Paso 3. Pegá tu API key y guardá el archivo.",
      "guide.s4.h3.body": "Reemplazá <code>PASTE_YOUR_API_KEY_HERE</code> con la API key que copiaste de Followr. Dejá las comillas dobles alrededor. Tiene que quedar así:",
      "guide.s4.h3.save": "Guardá el archivo con Cmd+S (macOS) o Ctrl+S (Windows).",
      "guide.s4.h4": "Paso 4. Cerrá Claude Desktop por completo. Después abrila de nuevo.",
      "guide.s4.h4.callout.head": "Cerrar solo la ventana NO alcanza.",
      "guide.s4.h4.callout.body": " Claude sigue corriendo en background y no relee el archivo de config hasta que cierre del todo. Después de cerrar la ventana, seguí las instrucciones para tu sistema operativo de abajo, y abrí la app de nuevo desde cero.",
      "guide.s4.h4.mac.head": "macOS:",
      "guide.s4.h4.mac.body": "Menu bar → Claude → Quit Claude (o apretá Cmd+Q). Después reabrila desde el Dock o Spotlight.",
      "guide.s4.h4.win.head": "Windows:",
      "guide.s4.h4.win.body": "Click derecho en el ícono de Claude en la system tray (al lado del reloj) → Quit. Después abrí Claude de nuevo desde el menú Inicio.",
      "guide.s4.h4.lin.head": "Linux:",
      "guide.s4.h4.lin.body": "Cerrá la app por completo, matá cualquier proceso colgado si hace falta, después abrila de nuevo.",
      "guide.s4.h5": "Paso 5. Confirmá que el MCP está conectado.",
      "guide.s4.h5.body": "En un chat nuevo, cliqueá el ícono de herramientas o enchufe debajo del input. Deberías ver <code>followr</code> listado. La primera vez tarda 5 a 10 segundos mientras <code>npx</code> baja <code>@followr/mcp</code>. Las siguientes son instantáneas.",
      "guide.s4.alt.title": "Alternativa: encontrá el archivo de config a mano.",
      "guide.s4.alt.intro": "Si el shortcut adentro de la app no te funciona, el archivo vive en alguno de estos paths. Abrilo directo con tu editor.",
      "guide.s4.alt.mac": "En macOS, la forma más rápida de llegar a la carpeta es Finder → Go → Go to Folder (Cmd+Shift+G), y pegar <code>~/Library/Application Support/Claude/</code>.",

      "guide.s5.eyebrow": "05 · SOLUCIÓN DE PROBLEMAS",
      "guide.s5.title": "Errores comunes y cómo arreglarlos.",
      "guide.s5.e1.title": "Cada llamada devuelve 401 Unauthorized.",
      "guide.s5.e1.body": "O la API key fue truncada por el shell (te faltaron las comillas simples en Claude Code), o tiene un espacio extra al pegarla, o tu plan no incluye acceso a la API. Revisá la API key caracter por caracter y verificá tu plan dentro de <a href=\"https://app.followr.ai\" target=\"_blank\" rel=\"noopener noreferrer\">Followr</a>.",
      "guide.s5.e2.title": "El connector followr no aparece en Claude Desktop.",
      "guide.s5.e2.body": "Casi siempre JSON inválido. Pegá el archivo entero en <a href=\"https://jsonlint.com\" target=\"_blank\" rel=\"noopener noreferrer\">jsonlint.com</a>. La causa más frecuente es una coma faltante entre bloques de MCP. También confirmá que cerraste Claude del todo (Cmd+Q en macOS, system tray en Windows), no solo la ventana.",
      "guide.s5.e3.title": "“command not found: npx”.",
      "guide.s5.e3.body": "Node.js no está instalado o no está en el PATH. Instalá el LTS de <a href=\"https://nodejs.org\" target=\"_blank\" rel=\"noopener noreferrer\">nodejs.org</a>, reiniciá la terminal, reiniciá tu cliente de IA, volvé a probar.",
      "guide.s5.e4.title": "La primera llamada se cuelga varios segundos.",
      "guide.s5.e4.body": "Es normal la primera vez. <code>npx</code> está bajando el paquete (~25 MB cacheados en <code>~/.npm/_npx/</code>). Cada arranque después del primero es instantáneo. Para precalentar, corré <code>npx -y @followr/mcp --version || true</code> en tu terminal.",
      "guide.s5.e5.title": "claude.ai (web) no muestra MCPs locales.",
      "guide.s5.e5.body": "Era esperable. La versión browser de claude.ai solo soporta connectors HTTP remotos, no servidores stdio locales. Por ahora usá Claude Desktop, Claude Code, o cualquier otro cliente listado en la página principal.",
      "guide.s5.e6.title": "Se filtró la API key. ¿Qué hago?",
      "guide.s5.e6.body": "Abrí la <a href=\"https://app.followr.ai/settings/api-keys\" target=\"_blank\" rel=\"noopener noreferrer\">configuración de API Keys</a>, revocá la API key filtrada, generá una nueva, actualizá tu config file o volvé a correr <code>claude mcp add</code>, reiniciá tu cliente de IA.",

      "guide.cta.title": "Todo listo. ¿Y ahora?",
      "guide.cta.sub": "Abrí Claude y pedile que liste tus próximos posts programados. Si responde con data real, el connector está vivo.",
      "guide.cta.home": "Volver al inicio",
      "guide.cta.github": "Estrella en GitHub",
      "guide.cta.secondary": "¿Querés leer la API detrás?",
      "guide.cta.docs": "Doc de la comunidad →"
    }
  };

  function detectLocale() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && translations[stored]) return stored;
    } catch (e) {
      /* localStorage not available */
    }
    var nav = (navigator.language || "en").toLowerCase();
    for (var i = 0; i < locales.length; i++) {
      if (nav === locales[i].code || nav.indexOf(locales[i].code + "-") === 0) {
        return locales[i].code;
      }
    }
    return "en";
  }

  function getShortLabel(code) {
    for (var i = 0; i < locales.length; i++) {
      if (locales[i].code === code) return locales[i].short;
    }
    return code.toUpperCase();
  }

  function applyLocale(code) {
    var dict = translations[code] || translations.en;
    document.documentElement.lang = code;

    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      var value = dict[key];
      if (typeof value === "string") {
        // Allow restricted inline HTML for install/token strings that need <code>, <strong>, <a>, <em>.
        if (value.indexOf("<") !== -1) {
          nodes[i].innerHTML = value;
        } else {
          nodes[i].textContent = value;
        }
      } else {
        nodes[i].textContent = "[" + key + "]";
      }
    }

    var label = document.getElementById("lang-button-label");
    if (label) label.textContent = getShortLabel(code);

    var options = document.querySelectorAll(".lang-option");
    for (var j = 0; j < options.length; j++) {
      if (options[j].getAttribute("data-locale") === code) {
        options[j].classList.add("active");
      } else {
        options[j].classList.remove("active");
      }
    }

    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch (e) {
      /* localStorage not available */
    }
  }

  function buildDropdown(currentCode) {
    var dropdown = document.getElementById("lang-dropdown");
    if (!dropdown) return;
    dropdown.innerHTML = "";
    for (var i = 0; i < locales.length; i++) {
      var item = document.createElement("li");
      var btn = document.createElement("button");
      btn.className = "lang-option" + (locales[i].code === currentCode ? " active" : "");
      btn.setAttribute("data-locale", locales[i].code);
      btn.setAttribute("type", "button");
      btn.textContent = locales[i].label;
      btn.addEventListener("click", onLocaleOptionClick);
      item.appendChild(btn);
      dropdown.appendChild(item);
    }
  }

  function onLocaleOptionClick(e) {
    var code = e.currentTarget.getAttribute("data-locale");
    if (!code) return;
    applyLocale(code);
    closeDropdown();
  }

  function openDropdown() {
    var dropdown = document.getElementById("lang-dropdown");
    var button = document.getElementById("lang-button");
    if (!dropdown || !button) return;
    dropdown.classList.add("open");
    button.setAttribute("aria-expanded", "true");
  }

  function closeDropdown() {
    var dropdown = document.getElementById("lang-dropdown");
    var button = document.getElementById("lang-button");
    if (!dropdown || !button) return;
    dropdown.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  }

  function toggleDropdown() {
    var dropdown = document.getElementById("lang-dropdown");
    if (!dropdown) return;
    if (dropdown.classList.contains("open")) {
      closeDropdown();
    } else {
      openDropdown();
    }
  }

  function initLangSelector() {
    var current = detectLocale();
    buildDropdown(current);
    applyLocale(current);

    var button = document.getElementById("lang-button");
    if (button) {
      button.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleDropdown();
      });
    }

    document.addEventListener("click", function (e) {
      var selector = document.querySelector(".lang-selector");
      if (selector && !selector.contains(e.target)) closeDropdown();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDropdown();
    });
  }

  function initDemoTabs() {
    var tabs = document.querySelectorAll(".demo-tab");
    var chats = document.querySelectorAll(".chat");
    if (!tabs.length || !chats.length) return;

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (e) {
        var target = e.currentTarget.getAttribute("data-tab");
        for (var j = 0; j < tabs.length; j++) {
          var isMatch = tabs[j].getAttribute("data-tab") === target;
          tabs[j].classList.toggle("is-active", isMatch);
          tabs[j].setAttribute("aria-selected", isMatch ? "true" : "false");
        }
        for (var k = 0; k < chats.length; k++) {
          var isChatMatch = chats[k].getAttribute("data-chat") === target;
          chats[k].hidden = !isChatMatch;
        }
      });
    }
  }

  function initInstallTabs() {
    var tabs = document.querySelectorAll(".install-tab");
    var panes = document.querySelectorAll(".install-pane");
    if (!tabs.length || !panes.length) return;

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (e) {
        var target = e.currentTarget.getAttribute("data-install");
        for (var j = 0; j < tabs.length; j++) {
          var isMatch = tabs[j].getAttribute("data-install") === target;
          tabs[j].classList.toggle("is-active", isMatch);
          tabs[j].setAttribute("aria-selected", isMatch ? "true" : "false");
        }
        for (var k = 0; k < panes.length; k++) {
          var isPaneMatch = panes[k].getAttribute("data-install-pane") === target;
          panes[k].hidden = !isPaneMatch;
        }
      });
    }
  }

  function getCurrentDict() {
    var lang = document.documentElement.lang || "en";
    return translations[lang] || translations.en;
  }

  function setCopyButtonState(btn, state) {
    var label = btn.querySelector(".code-copy-label");
    var dict = getCurrentDict();
    if (btn._copyResetTimer) {
      clearTimeout(btn._copyResetTimer);
      btn._copyResetTimer = null;
    }
    btn.classList.remove("is-copied", "is-error");
    if (state === "copied") {
      btn.classList.add("is-copied");
      if (label) label.textContent = dict["code.copied"] || "Copied";
    } else if (state === "error") {
      btn.classList.add("is-error");
      if (label) label.textContent = dict["code.error"] || "Error";
    } else {
      if (label) label.textContent = dict["code.copy"] || "Copy";
      return;
    }
    btn._copyResetTimer = setTimeout(function () {
      btn.classList.remove("is-copied", "is-error");
      var d = getCurrentDict();
      if (label) label.textContent = d["code.copy"] || "Copy";
      btn._copyResetTimer = null;
    }, 1600);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function initCopyButtons() {
    var buttons = document.querySelectorAll(".code-copy");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          var block = btn.closest(".code-block");
          if (!block) return;
          var codeEl = block.querySelector("pre code");
          if (!codeEl) return;
          var text = codeEl.textContent || "";
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () { setCopyButtonState(btn, "copied"); },
              function () {
                var ok = fallbackCopy(text);
                setCopyButtonState(btn, ok ? "copied" : "error");
              },
            );
          } else {
            var ok = fallbackCopy(text);
            setCopyButtonState(btn, ok ? "copied" : "error");
          }
        });
      })(buttons[i]);
    }
  }

  function init() {
    initLangSelector();
    initDemoTabs();
    initInstallTabs();
    initCopyButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
