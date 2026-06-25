---
name: PPCBench
description: Privacy-first Amazon PPC toolkit — a precise, in-browser data instrument for ad-spend operators.
colors:
  brand-indigo: "#4f46e5"
  brand-indigo-bright: "#6366f1"
  brand-indigo-deep: "#4338ca"
  brand-indigo-wash: "#eef2ff"
  brand-cyan: "#06b6d4"
  brand-cyan-bright: "#22d3ee"
  signal-profit: "#10b981"
  signal-profit-deep: "#059669"
  signal-profit-wash: "#ecfdf5"
  signal-waste: "#f43f5e"
  signal-waste-deep: "#e11d48"
  signal-waste-wash: "#fff1f2"
  ink: "#0f172a"
  ink-soft: "#334155"
  muted: "#64748b"
  muted-light: "#94a3b8"
  hairline: "#e2e8f0"
  surface-sunken: "#f8fafc"
  surface: "#ffffff"
typography:
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 6vw, 3.75rem)"
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 3vw, 2rem)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label-mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.18em"
  data-mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "1.875rem"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "normal"
rounded:
  sm: "4px"
  lg: "8px"
  xl: "12px"
  "2xl": "16px"
  full: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.brand-indigo}"
    textColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.brand-indigo-deep}"
    textColor: "{colors.surface}"
  input-field:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.2xl}"
    padding: "24px"
---

# Design System: PPCBench

## 1. Overview

**Creative North Star: "The Data Instrument"**

PPCBench looks like a precision tool, not a brochure. The reference object is a measuring instrument — an oscilloscope, a trading terminal, a lab notebook — where every mark on the surface earns its place by carrying information. The signature is the pairing of a clean humanist sans (Inter) for substance with a monospace (JetBrains Mono) used as the instrument's readout layer: eyebrows, trust lines, KPI numbers, and section markers are all set in mono, so the interface reads as *calibrated* rather than *decorated*. A faint graph-paper grid sits behind the hero like the gridlines on plotting paper. The voice is sharp, confident, and expert: it states the number and shows the math.

This system explicitly rejects the generic-SaaS monoculture. No Inter-for-everything with a purple-to-blue gradient on every surface, no cards nested in cards, no rounded-square icon tile stamped above every heading, no tiny tracked uppercase eyebrow on every section as reflex scaffolding. It equally rejects the cluttered default-dashboard look (chartjunk, raw Chart.js styling, every metric shouting at once), enterprise navy-and-gray brochureware, and playful-consumer pastel. Distinctiveness is the baseline, because the product's own promise is to make Amazon listings stop looking templated.

**Key Characteristics:**
- Monospace as a functional readout layer (numbers, labels, markers), not as decoration.
- A restrained surface: white and near-white slate, with color reserved for meaning.
- A three-channel signal palette — profit (emerald), waste (rose), neutral/brand (indigo→cyan) — that runs consistently through tools and charts.
- Quiet, custom-themed data viz; never default Chart.js.
- Calm by default; motion and color appear only to carry state or meaning.

## 2. Colors

A restrained slate-and-white surface, an indigo→cyan brand spine, and a two-color profit/waste signal system that does the semantic work.

### Primary
- **Brand Indigo** (#4f46e5): The product's spine. Primary buttons, active states, the Builder/Harvester tool accent, focus rings on the primary flow. The bright variant (#6366f1) is the lighter brand tone for washes and accents.
- **Brand Cyan** (#06b6d4): The second half of the brand gradient and the Smart N-Gram tool's accent. Bright cyan (#22d3ee) is the gradient's light end, used in the logomark.

### Secondary (signal colors — semantic, not decorative)
- **Signal Profit / Emerald** (#10b981, deep #059669): Profitable terms, good-ACOS, positive deltas. The "good" channel in every chart and table. Wash (#ecfdf5) for success callouts.
- **Signal Waste / Rose** (#f43f5e, deep #e11d48): Wasted spend, high-ACOS flags, the Bulk Negator's accent, destructive/error states. Wash (#fff1f2) and error selects.

### Neutral
- **Ink** (#0f172a): Primary text, the dark app header, chart tooltips. The near-black anchor.
- **Ink Soft** (#334155): Secondary headings and strong body.
- **Muted** (#64748b) / **Muted Light** (#94a3b8): Supporting text, mono trust lines, table meta. Never below 4.5:1 on white for body-sized text.
- **Hairline** (#e2e8f0): Card borders, table dividers, row separators.
- **Surface Sunken** (#f8fafc) / **Surface** (#ffffff): Page background and raised card/panel surfaces. Inputs rest on sunken, lift to white (#ffffff) on focus.

### Named Rules
**The Signal-Reserve Rule.** Emerald and rose are *reserved for meaning* — profit and waste. Never use them decoratively. If a green or red appears on screen, it must mean "this is making money" or "this is bleeding money."

**The Wordmark Exception Rule.** Gradient-clipped text (`background-clip: text` over the indigo→cyan gradient) is permitted on **exactly two** elements: the "Bench" in the PPCBench wordmark, and one hero accent phrase. It is forbidden on every other heading, label, number, or body element. Emphasis elsewhere comes from weight, size, or a solid signal color.

## 3. Typography

**Display / Body Font:** Inter (with system-ui, sans-serif)
**Label / Data Font:** JetBrains Mono (with ui-monospace, SFMono-Regular, monospace)

**Character:** A single humanist sans in many weights (400–900) carries all prose and headings; the contrast axis is sans-vs-mono, not two-sans. The monospace is the instrument readout — it makes labels and figures feel measured and precise, and it is the system's single strongest anti-generic signal. The two are never blurred: mono never sets paragraphs, Inter never sets a KPI number.

### Hierarchy
- **Display** (Inter 900, clamp(2.25rem, 6vw, 3.75rem), 1.05, -0.02em): Hero and page headlines. Ceiling held at ~3.75rem — confident, not shouting. `text-wrap: balance`.
- **Headline** (Inter 800, clamp(1.5rem, 3vw, 2rem), 1.15): Section titles inside tools and marketing.
- **Body** (Inter 400, 1rem, 1.6): Prose and table content. Cap measure at 65–75ch.
- **Label / Mono** (JetBrains Mono 700, 0.6875rem, +0.18em, often uppercase): Eyebrows, trust lines, section markers, table column meta. The "// comment" prefix on hero voice lines is a deliberate code-register tell.
- **Data / Mono** (JetBrains Mono 900, ~1.875rem): KPI and proof-band numbers. Numbers are always mono.

### Named Rules
**The Mono-Readout Rule.** Every number that reports a measurement — KPIs, counts, spend, ACOS, proof-band stats — is set in JetBrains Mono. Prose is Inter. The split is the brand.

## 4. Elevation

Near-flat. Depth comes from hairline borders and the sunken-vs-raised surface pair, not from heavy shadow. Cards sit on `shadow-sm` only; the system never reaches for dramatic drop shadows or glassmorphism. The one piece of "depth" that is purposeful is the masked graph-paper grid behind the hero, which reads as plotting-paper texture, not as a shadow.

### Shadow Vocabulary
- **Card rest** (`box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05)` — Tailwind `shadow-sm`): The only ambient elevation. Cards, panels, sticky bars.
- **Header** (`shadow-md` on the dark app bar): Separates the fixed app header from scrolling content.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest, separated by 1px hairlines (#e2e8f0). Elevation is a response to state (a sticky bar, the dark header), never decoration. If a card needs a shadow to feel like a card, the border is doing the wrong job.

## 5. Components

### Buttons
- **Shape:** Gently rounded (8px, `rounded-lg`).
- **Primary:** Solid Brand Indigo (#4f46e5) on white text, ~10px/20px padding. Hover deepens to #4338ca.
- **CTA (brand surfaces only):** The indigo→cyan gradient fill (`from-indigo-600 to-cyan-500`) on the landing hero/closing CTA. This is a fill gradient on a button, distinct from the banned text gradient.
- **Destructive:** Rose (#f43f5e) family, used in the Negator and for removing rows.

### Inputs / Fields
- **Style:** 1px slate border (#cbd5e1 / slate-300) on a sunken `#f8fafc` ground, 8px radius (4px for dense table inputs).
- **Focus:** Background lifts to white (#ffffff) and a 1px focus ring appears in the **current tool's accent** — indigo for Builder/Harvester, rose for Negator, cyan for N-Gram. Focus color is a wayfinding signal, not just a highlight.

### Cards / Containers
- **Corner Style:** 16px (`rounded-2xl`).
- **Background:** White (#ffffff) on the #f8fafc page.
- **Border:** 1px hairline (#e2e8f0). **Shadow:** `shadow-sm` only.
- **Internal Padding:** 24px.
- **Feature-card accent:** A 3px top bar in a per-card `--feat-accent` (indigo #6366f1 / emerald #10b981 / rose #f43f5e / cyan #06b6d4). Top edge only — never a side stripe.

### Navigation
- Dark app header (#0f172a), white wordmark with gradient-clipped "Bench", mono utility links. Fixed, `shadow-md`, hairline bottom border.

### Charts (signature component)
- Custom-themed Chart.js, never default. Gradient-filled bars, branded dark tooltip (#0f172a, rounded, no color box), point-style legend. Doughnuts are thin rings (`cutout: 70%`), white-stroked, spaced segments — never a fat pie. Good/waste/high-ACOS encoded in the signal palette **plus** position/label, never color alone.

## 6. Do's and Don'ts

### Do:
- **Do** set every reported number in JetBrains Mono and every paragraph in Inter (The Mono-Readout Rule).
- **Do** reserve emerald and rose for profit and waste only (The Signal-Reserve Rule).
- **Do** keep surfaces flat, separated by 1px #e2e8f0 hairlines and the sunken/raised pair (The Flat-By-Default Rule).
- **Do** tint each tool's input focus ring to that tool's accent (indigo / rose / cyan) for wayfinding.
- **Do** verify body text hits ≥4.5:1; push muted slate toward ink before it gets too light.
- **Do** keep charts quiet and custom-themed; thin doughnuts, gradient bars, dark tooltip.

### Don't:
- **Don't** ship the generic-SaaS look: no Inter-with-a-purple-gradient-on-everything, no cards nested in cards, no rounded-square icon tile above every heading, no tracked uppercase eyebrow on every section as reflex.
- **Don't** use gradient-clipped text anywhere except the wordmark and one hero accent phrase (The Wordmark Exception Rule).
- **Don't** use `border-left`/`border-right` greater than 1px as a colored accent stripe — feature accents go on the **top** edge only.
- **Don't** let charts default to raw Chart.js styling or pile every metric on with equal weight (the cluttered-dashboard anti-reference).
- **Don't** drift toward enterprise navy-and-gray brochureware or playful-consumer pastel/mascot/emoji registers.
- **Don't** convey good/waste/high-ACOS by color alone; always pair with label or position.
