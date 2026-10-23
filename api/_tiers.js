// The one table that says which plan unlocks which tool. Used by the page gate (middleware.js),
// /api/me and the app build script (scripts/build-app.mjs), so they can never disagree.
//
//   free : Smart N-Gram Analyzer
//   core : + Search Term Harvester, Bulk Negator
//   pro  : + Bulk Campaign Creator, Dayparting Planner, SQP Tracker
//
// A user's tier comes from app_metadata.tier (set only with SQL or the service role, never by the user).
// Missing or unknown = 'free' (least privilege).
export const TIERS = ['free', 'core', 'pro'];
export const TOOL_TIER = { ngram: 'free', harvester: 'core', negator: 'core', builder: 'pro', dayparting: 'pro', sqp: 'pro' };
export const TOOL_NAMES = { ngram: 'Smart N-Gram Analyzer', harvester: 'Search Term Harvester', negator: 'Bulk Negator', builder: 'Bulk Campaign Creator', dayparting: 'Dayparting Planner', sqp: 'SQP Tracker' };
export const TIER_LABEL = { free: 'Free', core: 'Core', pro: 'Pro' };

export const isTier = t => TIERS.includes(t);
export const normTier = t => (isTier(t) ? t : 'free');
export const tierRank = t => TIERS.indexOf(normTier(t));
export const canUse = (tier, tool) => Object.prototype.hasOwnProperty.call(TOOL_TIER, tool) && tierRank(tier) >= tierRank(TOOL_TIER[tool]);
export const toolsFor = tier => Object.keys(TOOL_TIER).filter(t => canUse(tier, t));
export const lockedFor = tier => Object.keys(TOOL_TIER).filter(t => !canUse(tier, t));
