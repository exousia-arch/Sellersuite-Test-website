// Builds the three tier versions of the app from the one labelled source:
//   src/app.source.html  ->  gated/app.free.htm, gated/app.core.htm, gated/app.pro.htm
//
// WHY: a tool the user's plan does not include must not be in the page at all (hiding a button is not
// security). The page gate (middleware.js) serves /app from the matching file and refuses the others, and
// the tool scripts under gated/tools/ are gated the same way.
//
// Source labels (everything is explicit; code outside a label is an error, so a new function can never
// silently land in the wrong tier):
//   JS   : a line  //@tool <name>   starts a region (shared | harvester | builder | negator | ngram),
//          up to the next //@tool line or the closing </script>. Scripts that have any label must start with one.
//   HTML : <!--@tool <name> <kind>-->  ...  <!--@end-->   kind = nav | home | footer | view | inline | script
//          Included when the tier has the tool. For nav/home/footer a locked tool is kept but turned into an
//          upgrade prompt; view/inline/script are removed. Regions may nest.
//   <!--@inject config-->  becomes the tier / locked-tools config the page reads.
//
// Output extension is .htm on purpose (see OUT below).
// Usage: node scripts/build-app.mjs           (write the files)
//        node scripts/build-app.mjs --check   (exit 1 if the files on disk are not what the build produces)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { TIERS, TOOL_TIER, TOOL_NAMES, TIER_LABEL, canUse, toolsFor, lockedFor } from '../api/_tiers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'app.source.html');
// .htm, not .html: with cleanUrls on, Vercel redirects *.html to the extensionless path and that would muddy the internal rewrite
const OUT = t => join(ROOT, 'gated', `app.${t}.htm`);
const TOOLS = Object.keys(TOOL_TIER);
const MARK_JS = /^\s*\/\/@tool (\w+)\s*$/, MARK_OPEN = /^\s*<!--@tool (\w+) (\w+)-->\s*$/, MARK_END = /^\s*<!--@end-->\s*$/;
const SCRIPT_OPEN = /^\s*<script>\s*$/, SCRIPT_CLOSE = /^\s*<\/script>\s*$/;

const fail = m => { throw new Error('build-app: ' + m); };

// ------------------------------------------------------------------ helpers
function lockedDecorate(kind, tool, text) {
  const tierLabel = TIER_LABEL[TOOL_TIER[tool]];
  let t = text.replace(/onclick="switchView\('[^']*'\)"/, `onclick="lockedTool('${tool}')" title="Included in the ${tierLabel} plan"`);
  if (!t.includes('lockedTool(')) fail(`locked ${kind} for ${tool} has no switchView onclick to replace`);
  const dim = kind === 'home' ? 'opacity-75' : kind === 'nav' ? 'opacity-60 inline-flex items-center gap-1' : 'opacity-60';
  t = t.replace(/class="/, `class="${dim} `);                                        // first class attribute = the element itself
  if (kind === 'nav') {
    // the language switcher replaces the text of any element carrying data-i18n, which would wipe the icon:
    // move the attribute from the button onto an inner span
    t = t.replace(/(<button[^>]*?)\sdata-i18n="(\w+)"([^>]*>)([^<]*)<\/button>/, '$1$3<span data-i18n="$2">$4</span></button>');
    return t.replace(/(<button[^>]*>)/, `$1<i data-lucide="lock" class="w-3 h-3 shrink-0"></i> `);
  }
  if (kind === 'footer') return t.replace(/(<button[^>]*>)/, `$1<i data-lucide="lock" class="w-3 h-3 inline -mt-0.5 mr-1"></i>`).replace('</button>', ` <span class="text-[10px] font-bold uppercase text-slate-500">${tierLabel}</span></button>`);
  if (kind === 'home') {
    if (!/<h2/.test(t)) fail(`locked home card for ${tool} has no <h2>`);
    return t.replace(/<h2/, `<span class="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 rounded-md px-2 py-0.5 mb-2 inline-flex items-center gap-1"><i data-lucide="lock" class="w-3 h-3"></i> ${tierLabel}</span>\n          <h2`);
  }
  fail('cannot decorate kind ' + kind);
}

function configScript(tier) {
  const locked = {};
  lockedFor(tier).forEach(t => { locked[t] = { name: TOOL_NAMES[t], tier: TOOL_TIER[t], tierLabel: TIER_LABEL[TOOL_TIER[t]] }; });
  return `  <script>window.PPCB_TIER=${JSON.stringify(tier)};window.PPCB_TIER_LABEL=${JSON.stringify(TIER_LABEL[tier])};window.PPCB_LOCKED=${JSON.stringify(locked)};</script>`;
}

// ------------------------------------------------------------------ one tier
function buildTier(src, tier) {
  const lines = src.split('\n'), out = [];
  let i = 0;
  const entitled = t => canUse(tier, t);

  // process lines until the matching <!--@end--> (when `nested`) or end of file; returns the lines produced
  function block(nested) {
    const res = []; let inScript = false, jsTool = null, managed = false, sawCode = false;
    while (i < lines.length) {
      const line = lines[i];
      if (MARK_END.test(line)) { if (!nested) fail(`stray <!--@end--> at source line ${i + 1}`); i++; return res; }
      const mo = line.match(MARK_OPEN);
      if (mo) {
        const [, tool, kind] = mo, at = i + 1; if (!TOOLS.includes(tool)) fail(`unknown tool "${tool}" at source line ${at}`);
        i++; const inner = block(true);
        if (entitled(tool)) res.push(...inner);
        else if (['nav', 'home', 'footer'].includes(kind)) res.push(...lockedDecorate(kind, tool, inner.join('\n')).split('\n'));
        else if (!['view', 'inline', 'script'].includes(kind)) fail(`unknown region kind "${kind}" at source line ${at}`);
        continue;
      }
      if (line.includes('<!--@inject config-->')) { res.push(configScript(tier)); i++; continue; }
      if (!inScript && SCRIPT_OPEN.test(line)) { inScript = true; jsTool = null; managed = false; sawCode = false; res.push(line); i++; continue; }
      if (inScript && SCRIPT_CLOSE.test(line)) { inScript = false; res.push(line); i++; continue; }
      if (inScript) {
        const mj = line.match(MARK_JS);
        if (mj) { if (mj[1] !== 'shared' && !TOOLS.includes(mj[1])) fail(`unknown tool "${mj[1]}" at source line ${i + 1}`); jsTool = mj[1]; managed = true; i++; continue; }
        // a script that uses labels must label everything: code before the first label is an error
        if (!managed && line.trim() && !/^\s*\/\//.test(line)) sawCode = sawCode || true;
        if (managed && jsTool === null) fail(`unlabelled code at source line ${i + 1}`);
        if (managed && jsTool !== 'shared' && !entitled(jsTool)) { i++; continue; }          // drop locked tool code
        res.push(line); i++; continue;
      }
      res.push(line); i++;
    }
    if (nested) fail('missing <!--@end-->');
    return res;
  }
  const result = block(false);
  return result.join('\n');
}

// Scripts must either have no labels at all, or start with one (checked while building: unlabelled code throws).
function checkLabelsFirst(src) {
  const lines = src.split('\n'); let inScript = false, first = true, managed = false, sawBeforeLabel = false;
  lines.forEach((line, n) => {
    if (!inScript && SCRIPT_OPEN.test(line)) { inScript = true; first = true; managed = false; sawBeforeLabel = false; return; }
    if (inScript && SCRIPT_CLOSE.test(line)) { if (managed && sawBeforeLabel) fail(`code before the first //@tool label in the script ending at source line ${n + 1}`); inScript = false; return; }
    if (!inScript) return;
    const mj = line.match(MARK_JS);
    if (mj) { if (mj[1] !== 'shared' && !TOOLS.includes(mj[1])) fail(`unknown tool "${mj[1]}" at source line ${n + 1}`); managed = true; return; }
    if (!managed && line.trim() && !/^\s*\/\//.test(line)) sawBeforeLabel = true;
  });
  lines.forEach((line, n) => { const mo = line.match(MARK_OPEN); if (mo && !TOOLS.includes(mo[1])) fail(`unknown tool "${mo[1]}" at source line ${n + 1}`); });
}

// ------------------------------------------------------------------ checks on a built page
const stripComments = js => { const spans = []; try { acorn.parse(js, { ecmaVersion: 2022, onComment: (b, t, s, e) => spans.push([s, e]) }); } catch { return js; } let o = ''; let p = 0; spans.sort((a, b) => a[0] - b[0]).forEach(([s, e]) => { o += js.slice(p, s) + ' '.repeat(e - s); p = e; }); return o + js.slice(p); };
const inlineScripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

// every top-level name a tool declares (from its labelled regions in the SOURCE)
function toolNames(src) {
  const names = Object.fromEntries(TOOLS.map(t => [t, new Set()]));
  const lines = src.split('\n'); let inScript = false, tool = null, buf = [];
  const flush = () => { if (tool && tool !== 'shared' && buf.length) { const ast = acorn.parse(buf.join('\n'), { ecmaVersion: 2022 });
    for (const n of ast.body) { if (n.type === 'FunctionDeclaration') names[tool].add(n.id.name); else if (n.type === 'VariableDeclaration') n.declarations.forEach(d => d.id.name && names[tool].add(d.id.name)); } } buf = []; };
  for (const line of lines) {
    if (!inScript && SCRIPT_OPEN.test(line)) { inScript = true; tool = null; buf = []; continue; }
    if (inScript && SCRIPT_CLOSE.test(line)) { flush(); inScript = false; tool = null; continue; }
    if (!inScript) continue;
    const m = line.match(MARK_JS); if (m) { flush(); tool = m[1]; continue; }
    buf.push(line);
  }
  return names;
}

function verify(html, tier, names) {
  const problems = [], excluded = lockedFor(tier);
  if (/<!--@|\/\/@tool/.test(html)) problems.push('label markers left in the output');
  const scripts = inlineScripts(html);
  scripts.forEach((js, n) => { try { new Script(js, { filename: `${tier}-inline-${n}` }); } catch (e) { problems.push(`inline script ${n} does not compile: ${e.message}`); } });
  // names declared (anywhere) by the code that IS in this page
  const declared = new Set(), refs = [];
  const asts = scripts.map(js => { try { return acorn.parse(js, { ecmaVersion: 2022 }); } catch { return null; } }).filter(Boolean);
  asts.forEach(ast => walk.full(ast, n => {
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) declared.add(n.id.name);
    if (n.type === 'VariableDeclarator') (function pat(p) { if (!p) return; if (p.type === 'Identifier') declared.add(p.name); else if (p.type === 'ObjectPattern') p.properties.forEach(q => pat(q.value || q.argument)); else if (p.type === 'ArrayPattern') p.elements.forEach(pat); else if (p.type === 'AssignmentPattern') pat(p.left); else if (p.type === 'RestElement') pat(p.argument); })(n.id);
    if (/Function/.test(n.type)) (n.params || []).forEach(function pat(p) { if (!p) return; if (p.type === 'Identifier') declared.add(p.name); else if (p.type === 'ObjectPattern') p.properties.forEach(q => pat(q.value || q.argument)); else if (p.type === 'ArrayPattern') p.elements.forEach(pat); else if (p.type === 'AssignmentPattern') pat(p.left); else if (p.type === 'RestElement') pat(p.argument); });
    if (n.type === 'CatchClause' && n.param && n.param.type === 'Identifier') declared.add(n.param.name);
  }));
  const gone = new Set(); excluded.forEach(t => names[t].forEach(x => { if (!declared.has(x)) gone.add(x); }));
  // 1) unguarded identifier use of something that was removed (typeof X and obj.X are fine)
  asts.forEach(ast => walk.ancestor(ast, { Identifier(n, st, anc) {
    if (!gone.has(n.name)) return; const p = anc[anc.length - 2];
    if (p && p.type === 'MemberExpression' && p.property === n && !p.computed) return;
    if (p && p.type === 'Property' && p.key === n && !p.computed && !p.shorthand) return;
    if (p && p.type === 'UnaryExpression' && p.operator === 'typeof') return;
    refs.push(n.name);
  } }));
  [...new Set(refs)].forEach(r => problems.push(`unguarded use of "${r}", which is not in the ${tier} page`));
  // 2) removed names called from markup handlers or from HTML inside JS strings
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script>([\s\S]*?)<\/script>/g, (m, js) => '<script>' + stripComments(js) + '</script>');
  for (const x of gone) { if (x.length < 6) continue;
    const re = new RegExp('(?<![\\w$.])' + x.replace(/\$/g, '\\$') + '\\s*\\(', 'g'); let m;
    while ((m = re.exec(clean))) { const before = clean.slice(Math.max(0, m.index - 8), m.index); if (/typeof\s$/.test(before)) continue; problems.push(`"${x}(" appears in the ${tier} page (a removed tool's function)`); break; } }
  // 3) removed tool markup and scripts must be gone
  excluded.forEach(t => {
    const viewId = t === 'harvester' ? 'view-harvester-upload' : 'view-' + t;
    if (html.includes(`id="${viewId}"`)) problems.push(`view of locked tool "${t}" is present`);
    if (t === 'dayparting' || t === 'sqp') if (html.includes(`/gated/tools/${t}.js`)) problems.push(`script of locked tool "${t}" is referenced`);
  });
  toolsFor(tier).forEach(t => { const viewId = t === 'harvester' ? 'view-harvester-upload' : 'view-' + t; if (!html.includes(`id="${viewId}"`)) problems.push(`view of entitled tool "${t}" is missing`); });
  return problems;
}

// ------------------------------------------------------------------ main
export function buildAll(source = readFileSync(SRC, 'utf8')) {
  const src = source.replace(/\r\n/g, '\n');
  checkLabelsFirst(src);
  const names = toolNames(src), result = {};
  for (const tier of TIERS) {
    let html = buildTier(src, tier);
    html = html.replace('<head>', `<head>\n  <!-- GENERATED by scripts/build-app.mjs from src/app.source.html for the "${tier}" plan. Do not edit. -->`);
    const problems = verify(html, tier, names);
    if (problems.length && !process.argv.includes('--force')) fail(`${tier} page failed checks:\n  - ` + problems.join('\n  - '));
    if (problems.length) console.error(`[${tier}] ${problems.length} problem(s):\n  - ` + problems.join('\n  - '));
    result[tier] = html;
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = buildAll(), check = process.argv.includes('--check');
  let stale = 0;
  for (const tier of TIERS) {
    const file = OUT(tier);
    // compare ignoring line endings: Git on Windows checks files out with CRLF
    if (check) { const have = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null; if (have !== built[tier]) { stale++; console.error(`stale: gated/app.${tier}.htm`); } }
    else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, built[tier]); console.log(`wrote gated/app.${tier}.htm (${(built[tier].length / 1024).toFixed(0)} KB)`); }
  }
  if (check) { if (stale) { console.error('Run: npm run build:app'); process.exit(1); } console.log('gated/app.*.htm are up to date'); }
}
