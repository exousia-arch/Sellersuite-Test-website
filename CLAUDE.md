# PPCBench

Privacy-first Amazon PPC toolkit. Bulk files are processed 100% in the browser — no account connection, no upload. Public marketing landing (`index.html`) + gated 4-tool app at `/app` (`app.html`: Search Term Harvester, Bulk Campaign Creator/Builder, Bulk Negator, Smart N-Gram Analyzer) + free public N-Gram (`ngram.html`). Static site on Vercel; `styles.css` is a compiled/purged Tailwind v3.4.17 build (rebuild after changing classes — see `.claude` memory / `tailwind.config.cjs`).

## Design Context

Design guidance lives in **`PRODUCT.md`** (strategic: register, users, principles, anti-references) and **`DESIGN.md`** (visual: tokens, type, components). Read both before any UI work. Managed by the `impeccable` skill (`/impeccable <command>`).

- **Register:** product (app/dashboards are the default lens; the landing is brand — override per task).
- **North Star:** "The Data Instrument" — Inter for substance + JetBrains Mono as the readout layer (numbers/labels/markers). Calibrated, not decorated.
- **Principles:** privacy is the product · show the math, not magic · practice what we preach (no generic tells) · speed to insight · expert defaults, full control.
- **Signal palette:** indigo→cyan = brand; emerald = profit; rose = waste. Color reserved for meaning.
- **Hard don'ts:** generic-SaaS template, gradient-clipped text (except wordmark + one hero phrase), >1px side-stripe accents, default Chart.js, color-only signaling.
