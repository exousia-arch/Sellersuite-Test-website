# Product

## Register

product

## Users

Amazon sellers, advertising agencies, and in-house PPC managers running Sponsored Products at scale. They arrive with a bulk operations file or a search-term report exported from Amazon Advertising and a specific job: find wasted ad spend, harvest converting search terms into new targets, build or negate keywords in bulk, and ship the changes back to Amazon — fast, and without handing a third party access to their Seller Central or Advertising account. They are comfortable with spreadsheets and ACOS math; they are not looking to be taught what PPC is. Sessions are short, task-focused, and often run against large files (hundreds of thousands of rows).

## Product Purpose

PPCBench is a privacy-first toolkit of four Amazon PPC tools — Search Term Harvester, Bulk Campaign Creator (Builder), Bulk Negator, and Smart N-Gram Analyzer — that process Amazon bulk files entirely in the browser. No account connection, no OAuth, no upload: the file never leaves the tab. The product exists because the alternative (connecting your Amazon account to a SaaS that ingests your data) is a privacy and trust cost sellers shouldn't have to pay for routine bulk-file work. Success looks like: a user drops in a bulk file and reaches an actionable insight (wasted-spend negatives, harvested targets, a ready-to-upload bulk sheet) within seconds, trusts the numbers enough to export and apply them, and reuses the same file across tools without re-uploading. Currently in private beta.

## Brand Personality

Sharp, confident, expert. Speaks to practitioners as a peer, not a beginner — direct, numbers-first, no hand-holding or hype. Voice is that of a senior PPC analyst who respects your time: states the finding, shows the math behind it, and gets out of the way. Privacy is stated plainly as a fact, not sold as a feature. Emotional goal: earned trust and quiet competence — the user should feel the tool knows the domain as well as they do.

## Anti-references

This should NOT look like any of the following:

- **Generic SaaS template / "AI slop"**: Inter for everything, purple-to-blue gradients, cards nested in cards, the rounded-square icon tile above every heading, tiny tracked uppercase eyebrows, identical card grids. The product that de-generics Amazon listings cannot itself read as templated.
- **Cluttered data dashboard**: chartjunk, default Chart.js styling, dense readouts with no visual hierarchy, every metric shouting at once. Charts must look deliberately custom and quiet.
- **Heavy enterprise / corporate brochureware**: stock photography, navy-and-gray B2B, jargon-dense slabs of marketing copy.
- **Playful consumer startup**: mascots, rounded blobs, pastel gradients, emoji-heavy copy. The audience is professional operators, not casual consumers.

## Design Principles

- **Privacy is the product, not a feature.** In-browser processing is the core promise. Never design a flow that implies data leaves the device, and never bury the "your file never leaves the tab" fact.
- **Show the math, not magic.** Every recommendation (wasted spend, high-ACOS flag, harvested target) surfaces the numbers behind it so expert users can verify and trust it. No black boxes.
- **Practice what we preach.** A tool whose job is to make Amazon listings look non-generic must itself avoid every templated tell. Distinctiveness is table stakes, not polish.
- **Speed to insight.** Upload to actionable result in seconds — no setup, no OAuth, no configuration detour. Reuse a processed file across tools instead of re-uploading.
- **Expert defaults, full control.** Ship opinionated recommendations, but keep every number editable before export. Respect the operator's judgment.

## Accessibility & Inclusion

Target WCAG 2.1 AA. Body text ≥4.5:1 contrast (≥3:1 for large text), full keyboard navigation, visible focus states, and labeled form controls throughout the tools. Honor `prefers-reduced-motion` on every animation with a crossfade or instant fallback — motion is never required to reach content or understand state. Charts must not rely on color alone to convey good/wasted/high-ACOS distinctions.
