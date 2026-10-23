// node build.test.mjs — checks that the plan versions of the app (gated/app.<plan>.htm) are current, contain
// exactly what each plan allows, and that the build refuses mistakes that could leak a tool into a lower plan.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAll } from './scripts/build-app.mjs';
import { TIERS, TOOL_TIER, toolsFor, lockedFor, canUse, normTier, TOOL_NAMES } from './api/_tiers.js';

const SRC = readFileSync('src/app.source.html', 'utf8'), built = buildAll(SRC);
const disk = t => readFileSync(`gated/app.${t}.htm`, 'utf8').replace(/\r\n/g, '\n');   // Git on Windows checks files out with CRLF

// ---- the files on disk are exactly what the build produces (nobody edited or forgot to rebuild)
for (const t of TIERS) assert.equal(disk(t), built[t], `gated/app.${t}.htm is stale: run npm run build:app`);

// ---- plan table
assert.deepEqual(toolsFor('free'), ['ngram']);
assert.deepEqual(toolsFor('core').sort(), ['harvester', 'negator', 'ngram']);
assert.deepEqual(toolsFor('pro').sort(), Object.keys(TOOL_TIER).sort());
assert.equal(normTier('admin'), 'free'); assert.equal(normTier(undefined), 'free'); assert.equal(normTier('PRO'), 'free'); assert.equal(normTier('__proto__'), 'free');
assert.equal(canUse('pro', 'toString'), false);                             // inherited property names are not tools
assert.equal(canUse('core', 'builder'), false); assert.equal(canUse('pro', 'sqp'), true);

// ---- canaries: each tool's own code must be absent from every plan below it, and present at its plan
const CANARY = {   // definitions, not mentions: shared code may still name a function behind a guard
  harvester: ['function processSingleBulkFile(', 'function renderHarvesterTable(', 'function exportHarvesterData(', 'function loadSampleHarvestData('],
  negator: ['function processNegatorFile(', 'function generateNegationXLSX(', 'function renderNegatorTable('],
  builder: ['function generateXLSX(', 'function createBuilderRowHTML(', 'function validateBuilderTargets(', 'function renderBuilderReview(', 'function duplicateRow('],
  ngram: ['let ngramsData'],
  dayparting: ['/gated/tools/dayparting.js', 'id="view-dayparting"'],
  sqp: ['/gated/tools/sqp.js', 'id="view-sqp"']
};
for (const t of TIERS) for (const [tool, words] of Object.entries(CANARY)) for (const w of words) {
  const has = built[t].includes(w);
  assert.equal(has, canUse(t, tool), `${tool} canary "${w}" ${has ? 'IS' : 'is NOT'} in the ${t} page`);
}
// locked tools stay visible as upgrade prompts (nav, home card, footer), pointing at lockedTool and not at the tool
for (const t of TIERS) for (const tool of lockedFor(t)) {
  const page = built[t], viewId = tool === 'harvester' ? 'view-harvester-upload' : 'view-' + tool;
  assert.ok(!page.includes(`id="${viewId}"`), `${tool} view in ${t}`);
  assert.ok(page.includes(`onclick="lockedTool('${tool}')"`), `${tool} lock entry in ${t}`);
  assert.ok(!page.includes(`onclick="switchView('${viewId}')"`), `${tool} still links to its view in ${t}`);
}
for (const t of TIERS) for (const tool of toolsFor(t)) assert.ok(!built[t].includes(`onclick="lockedTool('${tool}')"`), `${tool} wrongly locked in ${t}`);
// config the page reads
assert.match(built.core, /window\.PPCB_TIER="core";window\.PPCB_TIER_LABEL="Core";window\.PPCB_LOCKED=\{[^}]*"builder":\{"name":"Bulk Campaign Creator","tier":"pro","tierLabel":"Pro"\}/);
assert.match(built.pro, /window\.PPCB_LOCKED=\{\};/);
assert.ok(built.free.length < built.core.length && built.core.length < built.pro.length, 'free < core < pro in size');
// Harvester's "push to Builder" button must go when Builder is not on the plan
assert.ok(!built.core.includes('onclick="pushToBuilder()"') && !built.core.includes('function pushToBuilder('), 'core page has the push-to-Builder button or function');
assert.ok(built.pro.includes('onclick="pushToBuilder()"') && built.pro.includes('function pushToBuilder('));

// ---- the build refuses mistakes (each of these would otherwise quietly leak or break a plan)
const rejects = (mutate, re, why) => assert.throws(() => buildAll(mutate(SRC)), re, why);
rejects(s => s.replace('    //@tool shared\n    // Tools register', '    //@tool shared\n    function leakyShared() { addRow(); }\n    // Tools register'), /unguarded use of "addRow"/, 'shared code calling a Builder function directly');
rejects(s => s.replace("window.renderHarvesterTable();", "renderHarvesterTable();"), /unguarded use of "renderHarvesterTable"/, 'shared code calling a Harvester function directly');
rejects(s => s.replace('<!--@end-->', ''), /missing <!--@end-->|stray/, 'a region with no end marker');
rejects(s => s.replace('<!--@tool sqp view-->', '<!--@tool nonsense view-->'), /unknown tool "nonsense"/, 'an unknown tool name');
rejects(s => s.replace('//@tool builder', '//@tool buildr'), /unknown tool "buildr"/, 'a mistyped JS label');
rejects(s => s.replace('<!--@tool sqp view-->', '<!--@tool sqp weird-->'), /unknown region kind|view of locked tool|view of entitled tool/, 'an unknown region kind');
// dropping a tool's label folds its code into the region above (it would then ship in lower plans). The dependency
// check catches it: that code still calls the parts of the tool that ARE removed, and the build refuses.
const mutated = SRC.replace(/\n    \/\/@tool builder\n(    \/\/ =+ BUILDER LOGIC)/, '\n$1');
assert.notEqual(mutated, SRC, 'sanity: the mutation changed the source');
assert.throws(() => buildAll(mutated), /unguarded use of|appears in the core page/, 'a missing label must not build');
// code placed before the first label of a labelled script is refused
rejects(s => s.replace('  <script>\n    //@tool shared\n', '  <script>\n    const orphan = 1;\n    //@tool shared\n'), /code before the first/, 'code above the first label');
// a locked entry whose onclick is not a switchView call cannot be turned into a prompt
rejects(s => s.replace(`<!--@tool sqp footer-->\n          <li><button onclick="switchView('view-sqp')"`, `<!--@tool sqp footer-->\n          <li><button onclick="doSomething()"`), /no switchView onclick/, 'a lock entry with nothing to replace');

console.log('build: all checks pass');
