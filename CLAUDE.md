# PPCBench

Privacy-first Amazon PPC toolkit. Bulk files are processed 100% in the browser — no account connection, no upload. Public marketing landing (`index.html`) + gated 6-tool app at `/app` (Search Term Harvester, Bulk Campaign Creator/Builder, Bulk Negator, Smart N-Gram Analyzer, Dayparting Planner, SQP Tracker). **The app has plans (free / core / pro; table in `api/_tiers.js`) and a tool not on the user's plan is not in their page at all.** Edit `src/app.source.html` (labelled regions: `//@tool name` in scripts, `<!--@tool name kind-->` in markup; see `scripts/build-app.mjs`), then run `npm run build:app` to regenerate `gated/app.<plan>.htm` (never edit those by hand; `npm test` fails if they are stale). `middleware.js` serves `/app` from the user's plan and gates `/gated/*` (tool scripts live in `gated/tools/`). `npm run test:ui` is the browser check for every plan + free public N-Gram (`ngram.html`). Static site on Vercel; `styles.css` is a compiled/purged Tailwind v3.4.17 build (rebuild after changing classes — see `.claude` memory / `tailwind.config.cjs`).

## Design Context

Design guidance lives in **`PRODUCT.md`** (strategic: register, users, principles, anti-references) and **`DESIGN.md`** (visual: tokens, type, components). Read both before any UI work. Managed by the `impeccable` skill (`/impeccable <command>`).

- **Register:** product (app/dashboards are the default lens; the landing is brand — override per task).
- **North Star:** "The Data Instrument" — Inter for substance + JetBrains Mono as the readout layer (numbers/labels/markers). Calibrated, not decorated.
- **Principles:** privacy is the product · show the math, not magic · practice what we preach (no generic tells) · speed to insight · expert defaults, full control.
- **Brand palette:** burnt-orange spine (`#c2410c`); amber = N-Gram / high-ACOS; emerald = profit; rose = waste. Color reserved for meaning. (Orange was chosen to escape the indigo→cyan AI-palette tell.)
- **Hard don'ts:** the indigo/violet→cyan gradient (the AI tell this brand escapes), generic-SaaS template, gradient-clipped text (except wordmark + one hero phrase), >1px side-stripe accents, default Chart.js, color-only signaling.
