/**
 * nhl.js — EyeWall Analytics Worker
 *
 * NHL poll loop, push notifications, and all /nhl/* + /poll/* HTTP endpoints.
 * Scheduled trigger calls poll() every 60s during the season.
 */

import { kvGet, kvPut, json, corsHeaders, badRequest, SB_URL, SB_ANON, sbUpsert, parseRSS, parseESPN, parseAtom, parseReddit, parseSportsnet, parseGoogleNews, parseNHLNews, sendPush, checkAiRateLimit, buildHeadToHeadPayload } from './shared.js';
import { resolveNHLSeason } from './seasons.js';

const NHL_BASE   = 'https://api-web.nhle.com/v1';
const STATS_BASE = 'https://api.nhle.com/stats/rest/en';

// ── Team configuration ────────────────────────────────────────
// All 32 teams. The poll() scheduled job uses DEFAULT_TEAM_ABBR.
// Every HTTP endpoint resolves a per-request team from ?team= query param,
// falling back to DEFAULT_TEAM_ABBR when omitted.
//
// NOTE: these objects used to each carry their own hardcoded `season`
// field (32 identical copies of '20252026'). That's gone now — season is
// resolved live via resolveNHLSeason() wherever it's needed (see
// getTeamConfig() below and poll()), instead of being baked into static
// team data that has nothing to do with the season.

const DEFAULT_TEAM_ABBR = 'CAR';

export const TEAM_CONFIGS = {
  // keywords: short names/nicknames used by beat writers and BR/Athletic article titles.
  // Used by teamFilterKeywords() to filter league-wide RSS feeds.
  ANA: { abbr:'ANA', teamId:24, franchiseId:32, displayName:'Anaheim Ducks',         keywords:['ducks','anaheim','drysdale','fowler','terry','zegras'],                       winCopy:"Let's go Ducks! 🦆",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`ANA vs ${o} — puck drop!`, hashtags:['#AnaheimDucks','#LetsGoDucks','#NHL'] },
  BOS: { abbr:'BOS', teamId:6,  franchiseId:6,  displayName:'Boston Bruins',          keywords:['bruins','boston','pastrnak','mcavoy','swayman'],                               winCopy:"Let's go Bruins! 🐻",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`BOS vs ${o} — puck drop!`, hashtags:['#NHLBruins','#BostonBruins','#NHL'] },
  BUF: { abbr:'BUF', teamId:7,  franchiseId:7,  displayName:'Buffalo Sabres',         keywords:['sabres','buffalo','tuch','power','ukko-pekka'],                                winCopy:"Let's go Sabres! ⚔️",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`BUF vs ${o} — puck drop!`, hashtags:['#Sabres','#LetsGoBuffalo','#NHL'] },
  CGY: { abbr:'CGY', teamId:20, franchiseId:27, displayName:'Calgary Flames',         keywords:['flames','calgary','huberdeau','weegar','markstrom'],                          winCopy:"Let's go Flames! 🔥",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CGY vs ${o} — puck drop!`, hashtags:['#Flames','#CofRed','#NHL'] },
  CAR: { abbr:'CAR', teamId:12, franchiseId:26, displayName:'Carolina Hurricanes',    keywords:['canes','hurricanes','carolina','aho','svechnikov','kotkaniemi','kochetkov'],   winCopy:"Let's go Canes! 🌀",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CAR vs ${o} — puck drop!`, hashtags:['#LetsGoCanes','#Canes','#NHL','#CarolinaHurricanes','#SoundTheSiren'] },
  CHI: { abbr:'CHI', teamId:16, franchiseId:11, displayName:'Chicago Blackhawks',     keywords:['blackhawks','chicago','hawks','bedard','dickinson'],                          winCopy:"Let's go Blackhawks! 🪶",  lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CHI vs ${o} — puck drop!`, hashtags:['#Blackhawks','#OneGoal','#NHL'] },
  COL: { abbr:'COL', teamId:21, franchiseId:27, displayName:'Colorado Avalanche',     keywords:['avalanche','colorado','avs','mackinnon','makar','landeskog'],                  winCopy:"Let's go Avs! ❄️",         lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`COL vs ${o} — puck drop!`, hashtags:['#GoAvsGo','#Avalanche','#NHL'] },
  CBJ: { abbr:'CBJ', teamId:29, franchiseId:36, displayName:'Columbus Blue Jackets',  keywords:['blue jackets','columbus','jackets','fantilli','voronkov'],                    winCopy:"Let's go Jackets! 💥",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CBJ vs ${o} — puck drop!`, hashtags:['#CBJ','#NHLJackets','#NHL'] },
  DAL: { abbr:'DAL', teamId:25, franchiseId:15, displayName:'Dallas Stars',           keywords:['stars','dallas','robertson','seguin','oettinger'],                            winCopy:"Let's go Stars! ⭐",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`DAL vs ${o} — puck drop!`, hashtags:['#GoStars','#TexasHockey','#NHL'] },
  DET: { abbr:'DET', teamId:17, franchiseId:12, displayName:'Detroit Red Wings',      keywords:['red wings','detroit','wings','larkin','raymond','seider'],                    winCopy:"Let's go Wings! 🐙",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`DET vs ${o} — puck drop!`, hashtags:['#LGRW','#DetroitRedWings','#NHL'] },
  EDM: { abbr:'EDM', teamId:22, franchiseId:25, displayName:'Edmonton Oilers',        keywords:['oilers','edmonton','mcdavid','draisaitl','skinner'],                          winCopy:"Let's go Oilers! 🛢️",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`EDM vs ${o} — puck drop!`, hashtags:['#LetsGoOilers','#Oilers','#NHL'] },
  FLA: { abbr:'FLA', teamId:13, franchiseId:33, displayName:'Florida Panthers',       keywords:['panthers','florida','barkov','reinhart','bobrovsky'],                         winCopy:"Let's go Panthers! 🐾",    lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`FLA vs ${o} — puck drop!`, hashtags:['#TimeToHunt','#FlaPanthers','#NHL'] },
  LAK: { abbr:'LAK', teamId:26, franchiseId:14, displayName:'Los Angeles Kings',      keywords:['kings','los angeles','kopitar','doughty','fiala'],                            winCopy:"Let's go Kings! 👑",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`LAK vs ${o} — puck drop!`, hashtags:['#GoKingsGo','#LAKings','#NHL'] },
  MIN: { abbr:'MIN', teamId:30, franchiseId:37, displayName:'Minnesota Wild',         keywords:['wild','minnesota','kirill kaprizov','gustavsson','hartman'],                   winCopy:"Let's go Wild! 🌲",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`MIN vs ${o} — puck drop!`, hashtags:['#mnwild','#MNWild','#NHL'] },
  MTL: { abbr:'MTL', teamId:8,  franchiseId:1,  displayName:'Montreal Canadiens',     keywords:['canadiens','montreal','habs','caufield','slafkovsky','montembeault'],         winCopy:"Let's go Habs! 🔵",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`MTL vs ${o} — puck drop!`, hashtags:['#GoHabsGo','#Canadiens','#NHL'] },
  NSH: { abbr:'NSH', teamId:18, franchiseId:34, displayName:'Nashville Predators',    keywords:['predators','nashville','preds','forsberg','juuse saros'],                     winCopy:"Let's go Preds! 🐯",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NSH vs ${o} — puck drop!`, hashtags:['#Preds','#NashvillePredators','#NHL'] },
  NJD: { abbr:'NJD', teamId:1,  franchiseId:23, displayName:'New Jersey Devils',      keywords:['devils','new jersey','hischier','hughes','vanecek'],                          winCopy:"Let's go Devils! 😈",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NJD vs ${o} — puck drop!`, hashtags:['#NJDevils','#NJD','#NHL'] },
  NYI: { abbr:'NYI', teamId:2,  franchiseId:22, displayName:'New York Islanders',     keywords:['islanders','new york','isles','barzal','sorokin'],                            winCopy:"Let's go Islanders! 🏝️",  lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NYI vs ${o} — puck drop!`, hashtags:['#Isles','#NYIsles','#NHL'] },
  NYR: { abbr:'NYR', teamId:3,  franchiseId:10, displayName:'New York Rangers',       keywords:['rangers','new york','panarin','zibanejad','shesterkin'],                      winCopy:"Let's go Rangers! 🗽",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NYR vs ${o} — puck drop!`, hashtags:['#NYR','#NYRangers','#NHL'] },
  OTT: { abbr:'OTT', teamId:9,  franchiseId:30, displayName:'Ottawa Senators',        keywords:['senators','ottawa','sens','tkachuk','stutzle','forsberg'],                    winCopy:"Let's go Sens! 🏛️",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`OTT vs ${o} — puck drop!`, hashtags:['#GoSensGo','#Sens','#NHL'] },
  PHI: { abbr:'PHI', teamId:4,  franchiseId:16, displayName:'Philadelphia Flyers',    keywords:['flyers','philadelphia','matvei michkov','cates','fedotov'],                   winCopy:"Let's go Flyers! 🟠",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`PHI vs ${o} — puck drop!`, hashtags:['#Flyers','#PhiladelphiaFlyers','#NHL'] },
  PIT: { abbr:'PIT', teamId:5,  franchiseId:17, displayName:'Pittsburgh Penguins',    keywords:['penguins','pittsburgh','pens','crosby','malkin','jarry'],                     winCopy:"Let's go Pens! 🐧",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`PIT vs ${o} — puck drop!`, hashtags:['#LetsGoPens','#Penguins','#NHL'] },
  SEA: { abbr:'SEA', teamId:55, franchiseId:39, displayName:'Seattle Kraken',         keywords:['kraken','seattle','beniers','tanev','grubauer'],                              winCopy:"Let's go Kraken! 🦑",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`SEA vs ${o} — puck drop!`, hashtags:['#SeattleKraken','#Kraken','#NHL'] },
  SJS: { abbr:'SJS', teamId:28, franchiseId:29, displayName:'San Jose Sharks',        keywords:['sharks','san jose','celebrini','couture','mackeown'],                         winCopy:"Let's go Sharks! 🦈",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`SJS vs ${o} — puck drop!`, hashtags:['#SJSharks','#Sharks','#NHL'] },
  STL: { abbr:'STL', teamId:19, franchiseId:18, displayName:'St. Louis Blues',        keywords:['blues','st. louis','thomas','kyrou','binnington'],                            winCopy:"Let's go Blues! 🎵",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`STL vs ${o} — puck drop!`, hashtags:['#STLBlues','#Blues','#NHL'] },
  TBL: { abbr:'TBL', teamId:14, franchiseId:31, displayName:'Tampa Bay Lightning',    keywords:['lightning','tampa bay','bolts','stamkos','kucherov','vasilevskiy'],           winCopy:"Let's go Lightning! ⚡",   lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`TBL vs ${o} — puck drop!`, hashtags:['#GoBolts','#TBLightning','#NHL'] },
  TOR: { abbr:'TOR', teamId:10, franchiseId:5,  displayName:'Toronto Maple Leafs',   keywords:['maple leafs','toronto','leafs','matthews','marner','nylander'],                winCopy:"Let's go Leafs! 🍁",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`TOR vs ${o} — puck drop!`, hashtags:['#LeafsForever','#TMLtalk','#NHL'] },
  UTA: { abbr:'UTA', teamId:59, franchiseId:40, displayName:'Utah Mammoth',           keywords:['mammoth','utah','keller','peterka','villalta'],                               winCopy:"Let's go Mammoth! 🦣",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`UTA vs ${o} — puck drop!`, hashtags:['#TusksUp','#UtahMammoth','#Mammoth','#NHL'] },
  VAN: { abbr:'VAN', teamId:23, franchiseId:20, displayName:'Vancouver Canucks',      keywords:['canucks','vancouver','demko','pettersson','hughes'],                          winCopy:"Let's go Canucks! 🏒",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`VAN vs ${o} — puck drop!`, hashtags:['#Canucks','#VanCIty','#NHL'] },
  VGK: { abbr:'VGK', teamId:54, franchiseId:38, displayName:'Vegas Golden Knights',   keywords:['golden knights','vegas','knights','marchessault','stone','hill'],              winCopy:"Let's go Knights! ⚔️",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`VGK vs ${o} — puck drop!`, hashtags:['#VegasBorn','#GoKnightsGo','#NHL'] },
  WSH: { abbr:'WSH', teamId:15, franchiseId:24, displayName:'Washington Capitals',    keywords:['capitals','washington','caps','ovechkin','carlson','kuemper'],                winCopy:"Let's go Caps! 🦅",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`WSH vs ${o} — puck drop!`, hashtags:['#ALLCAPS','#Capitals','#NHL'] },
  WPG: { abbr:'WPG', teamId:52, franchiseId:35, displayName:'Winnipeg Jets',          keywords:['jets','winnipeg','scheifele','wheeler','hellebuyck'],                          winCopy:"Let's go Jets! ✈️",         lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`WPG vs ${o} — puck drop!`, hashtags:['#GoJetsGo','#NHLJets','#NHL'] },
};

// Resolve team config from a request's ?team= param; falls back to DEFAULT_TEAM_ABBR.
// Use this in every HTTP endpoint that serves team-specific data.
// Async because `season` is now live-resolved (see seasons.js) rather
// than a static field on the team object — every call site needs `await`.
async function getTeamConfig(request, env) {
  const abbr = new URL(request.url).searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
  const base = TEAM_CONFIGS[abbr] || TEAM_CONFIGS[DEFAULT_TEAM_ABBR];
  return { ...base, season: await resolveNHLSeason(env) };
}

// Namespaced by season so multiple seasons' schedules can be cached side by
// side without evicting each other — a bare `schedule:{abbr}` key can only
// ever hold one season at a time. Current season stays on the existing
// short TTL (schedule reshuffles as games get added/postponed); a past
// season's final schedule is immutable, so it gets a long TTL instead —
// still bustable manually via /cache, just not re-fetched every 10 minutes
// for no reason.
const CURRENT_SCHEDULE_TTL    = 600;             // 10 min — matches prior behavior
const HISTORICAL_SCHEDULE_TTL = 60 * 24 * 3600;   // 60 days — past season, won't change
function scheduleKey(abbr, season) {
  return `schedule:${abbr}:${season}`;
}

// The scheduled poll job uses the default team's static config.
// KV keys and notifications in poll() derive from this. `season` is NOT
// included here — poll() resolves it live for itself (see poll() below)
// since this constant is evaluated once at module load, before any
// request (and its env) exists.
const TEAM_CONFIG = TEAM_CONFIGS[DEFAULT_TEAM_ABBR];

// Convenience aliases for the poll path (unchanged from before, minus season)
const { abbr: TEAM_ABBR, teamId: TEAM_ID } = TEAM_CONFIG;

// ── Helpers ───────────────────────────────────────────────────


async function nhlGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EyeWall-Analytics-Worker/1.0' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`NHL API ${res.status}: ${url}`);
  return res.json();
}

// Server-side Supabase REST read, for the /player-analytics etc. proxy
// routes below — same shape as supabaseClient.js's own sbFetch(), just
// running here instead of in the browser.
async function sbRows(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${path}`);
  return r.json();
}

// Combined Prediction Calibration (2026-07) — see
// eyewall-pipeline/docs/combined_calibration_part_a_b_results.md for the
// fit/validation this was built from, and COMBINED_CALIBRATION_IMPLEMENTATION.md
// for the "switch, don't stack" regime design these three helpers implement.

// League-average PP% -- the one shared fallback value for a missing
// team_seasons.pp_pct in buildPreseasonFallback (used identically by both
// the scorecard and the AI prompt text; see PP_PCT_BACKFILL_GAP_INVESTIGATION.md).
const PP_PCT_DEFAULT = 22;

// e.g. 20252026 -> 20242025. Mirrors rapm.py's prior_season() exactly —
// keep in sync if that ever changes.
function priorSeason(season) {
  const endYear = season % 10000;
  const startYear = Math.floor(season / 10000);
  return (startYear - 1) * 10000 + (endYear - 1);
}

// Fitted via eyewall-pipeline/fit_scorecard_calibration.py on the main
// backtest's current-season-to-date predictions (fit: 2024-25, holdout:
// 2025-26) — see scorecard_calibration.json for the source artifact.
// Isotonic regression's fitted function is a monotonic step/interpolation
// curve; these are its (x, y) breakpoints. Only ever applied to the
// in-season branch — the true-preseason regime uses continuity dampening
// instead (see COMBINED_CALIBRATION_IMPLEMENTATION.md's "switch, don't
// stack" resolution). Refit cadence tied to the quarterly RAPM validation
// review (see ISOTONIC_RECALIBRATION_CADENCE.md) — a validated check each
// review, not an automatic refit.
//
// Refit 2026-07-24: the original fit (2026-07-23) predates the pp_goals/
// pp_opps situationCode-misindexing fix (PP_GOALS_FULL_FIX.md, pipeline
// PR #53) by ~8 hours. backtest_predictions.py's standings_inputs_asof()
// sums those same game_log columns into pp_pct, one of the scorecard's
// five inputs — so the original curve was fit on a raw score distorted by
// that bug (home teams' pp_pct forced toward 0 in nearly every game, a
// directional bias, not noise) across both the 2024-25 fit set and the
// 2025-26 holdout. Re-fit against the now-corrected game_log; see
// eyewall-pipeline/docs/isotonic_recalibration_recheck_results.md.
const ISOTONIC_X = [
  0.0, 0.045454545454545456, 0.08333333333333334, 0.08571428571428572, 0.16, 0.16666666666666669,
  0.48387096774193555, 0.5, 0.7307692307692308, 0.7391304347826086, 0.76, 0.7666666666666666,
  0.896551724137931, 0.9, 1.0,
];
const ISOTONIC_Y = [
  0.41420118343195267, 0.4375, 0.4375, 0.5034965034965035, 0.5034965034965035, 0.5236220472440944,
  0.5236220472440944, 0.5967741935483871, 0.5967741935483871, 0.625, 0.625, 0.6644295302013423,
  0.6644295302013423, 0.6888888888888889, 0.6888888888888889,
];

// x is the raw scorecard fraction (0-1, i.e. carScore/total before
// rounding to a percentage) — apply calibration BEFORE rounding, matching
// exactly what was fit and validated in Python (fitting on an already-
// rounded integer percentage would be a subtly different input).
// Linear interpolation between breakpoints, clipped outside the fitted
// range — verified against sklearn's actual IsotonicRegression.predict()
// output across the full range (including boundary clips and flat/duplicate-
// x steps) before shipping, not assumed from the algorithm's name.
function isotonicCalibrate(x) {
  if (x <= ISOTONIC_X[0]) return ISOTONIC_Y[0];
  const last = ISOTONIC_X.length - 1;
  if (x >= ISOTONIC_X[last]) return ISOTONIC_Y[last];
  for (let i = 0; i < last; i++) {
    if (x >= ISOTONIC_X[i] && x <= ISOTONIC_X[i + 1]) {
      const x0 = ISOTONIC_X[i], x1 = ISOTONIC_X[i + 1];
      const y0 = ISOTONIC_Y[i], y1 = ISOTONIC_Y[i + 1];
      if (x1 === x0) return y0; // flat step (duplicate x-threshold)
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return ISOTONIC_Y[last]; // unreachable safety net
}

// Fraction (0-1) of a team's prior-season total TOI attributable to
// players still on its roster today — validated in
// TRUE_PRESEASON_BACKTEST_EXTENSION.md/_RESULTS.md (continuity-adjusted
// fallback: Brier -13%, log loss -63% vs. the raw fallback, no accuracy
// cost). rosterIds: current roster player ids for the team (from
// `players.team`, live — no historical proxy needed in production, unlike
// the backtest reconstruction). priorSeasonRows: that team's own
// player_seasons rows for the prior season (player_id, games_played,
// toi_per_game).
function continuityFraction(rosterIds, priorSeasonRows) {
  let totalToi = 0, retainedToi = 0;
  for (const r of priorSeasonRows) {
    const toi = (r.toi_per_game || 0) * (r.games_played || 0);
    totalToi += toi;
    if (rosterIds.has(r.player_id)) retainedToi += toi;
  }
  return totalToi > 0 ? retainedToi / totalToi : null;
}

// Called from /prediction/analyze when standings are still pinned to last
// season (no real current-season data yet). Prior-season scorecard +
// roster-continuity dampening, validated in TRUE_PRESEASON_BACKTEST_RESULTS.md
// — never combined with the in-season branch's isotonic calibration (see
// the "switch, don't stack" resolution in COMBINED_CALIBRATION_IMPLEMENTATION.md).
async function buildPreseasonFallback(env, tc, oppAbbr, isHome, isPlayoff, gameId, kvKey) {
  const prior = priorSeason(tc.season);

  const [teamSeasonRows, playerRows, priorPlayerSeasonRows] = await Promise.all([
    sbRows(`team_seasons?team=in.(${tc.abbr},${oppAbbr})&season=eq.${prior}&game_type=eq.2` +
      `&select=team,points,goals_for_pg,goals_ag_pg,pp_pct,shots_for_pg,corsi_for_pct,corsi_for_pct_5v5`),
    sbRows(`players?team=in.(${tc.abbr},${oppAbbr})&select=id,team`),
    sbRows(`player_seasons?team=in.(${tc.abbr},${oppAbbr})&season=eq.${prior}&game_type=eq.2` +
      `&select=player_id,team,games_played,toi_per_game`),
  ]);

  const carRow = teamSeasonRows.find(r => r.team === tc.abbr);
  const oppRow = teamSeasonRows.find(r => r.team === oppAbbr);
  if (!carRow || !oppRow) {
    return json({ error: `No prior-season (${prior}) data available for ${tc.abbr} or ${oppAbbr} — cannot generate a preseason estimate yet.` });
  }

  const carGpg = carRow.goals_for_pg ?? 0;
  const oppGpg = oppRow.goals_for_pg ?? 0;
  const carGag = carRow.goals_ag_pg ?? 0;
  const oppGag = oppRow.goals_ag_pg ?? 0;
  const carSF  = carRow.shots_for_pg ?? 0;
  const oppSF  = oppRow.shots_for_pg ?? 0;

  // Same scorecard as the in-season branch, minus the streak term — no
  // such concept for a completed prior season's final record.
  let carScore = 0, oppScore = 0;
  if (!isPlayoff) {
    const ptsDiff = (carRow.points ?? 0) - (oppRow.points ?? 0);
    carScore += ptsDiff > 0 ? Math.min(ptsDiff / 20, 1) : 0;
    oppScore += ptsDiff < 0 ? Math.min(-ptsDiff / 20, 1) : 0;
  }
  if (carGpg > oppGpg) carScore += 0.6; else oppScore += 0.6;
  if (carGag < oppGag) carScore += 0.6; else oppScore += 0.6;
  // League-average default (22%) when a team's prior-season pp_pct is
  // missing from team_seasons -- resolved once and reused below in the
  // prompt text too, so scoring and the AI narrative never disagree on
  // what value stood in for the missing data (they used to: scoring
  // defaulted to 22, the prompt separately defaulted to 0, silently).
  // Logged, not silent -- this shouldn't happen once a season's
  // team_seasons row is fully populated (see backfill_uta_2025_team_stats.py
  // for the one confirmed real-world case, a teamId-mapping gap).
  if (carRow.pp_pct == null) console.error(`buildPreseasonFallback: ${tc.abbr} ${prior} pp_pct missing, defaulting to league-average ${PP_PCT_DEFAULT}%`);
  if (oppRow.pp_pct == null) console.error(`buildPreseasonFallback: ${oppAbbr} ${prior} pp_pct missing, defaulting to league-average ${PP_PCT_DEFAULT}%`);
  const carPP = carRow.pp_pct ?? PP_PCT_DEFAULT;
  const oppPP = oppRow.pp_pct ?? PP_PCT_DEFAULT;
  if (carPP > oppPP) carScore += 0.4; else oppScore += 0.4;
  if (carSF > oppSF) carScore += 0.5; else oppScore += 0.5;
  const total = carScore + oppScore || 1;
  const rawFraction = carScore / total;

  // Roster continuity — current roster from `players.team` (live, no
  // historical proxy needed here, unlike the backtest reconstruction),
  // prior-season TOI from that team's own player_seasons rows.
  const carRosterIds = new Set(playerRows.filter(p => p.team === tc.abbr).map(p => p.id));
  const oppRosterIds = new Set(playerRows.filter(p => p.team === oppAbbr).map(p => p.id));
  const carPriorRows = priorPlayerSeasonRows.filter(r => r.team === tc.abbr);
  const oppPriorRows = priorPlayerSeasonRows.filter(r => r.team === oppAbbr);
  const carContinuity = continuityFraction(carRosterIds, carPriorRows);
  const oppContinuity = continuityFraction(oppRosterIds, oppPriorRows);
  const validContinuities = [carContinuity, oppContinuity].filter(c => c != null);
  // No roster data at all (shouldn't happen once players.team is
  // populated, but defensively) -- fall back to the raw, undamped
  // fraction rather than guessing at a dampening factor.
  const avgContinuity = validContinuities.length > 0
    ? validContinuities.reduce((a, b) => a + b, 0) / validContinuities.length
    : 1;

  const dampenedFraction = 0.5 + (rawFraction - 0.5) * avgContinuity;
  const carWinPct = Math.round(dampenedFraction * 100);

  // Corsi: reuse team_seasons, just filtered to the prior season instead
  // of the current one — same table the in-season branch already reads.
  let carCF = null, oppCF = null, corsiSource = 'unavailable';
  if (carRow.corsi_for_pct_5v5 != null && oppRow.corsi_for_pct_5v5 != null) {
    carCF = (carRow.corsi_for_pct_5v5 * 100).toFixed(1);
    oppCF = (oppRow.corsi_for_pct_5v5 * 100).toFixed(1);
    corsiSource = '5v5';
  } else if (carRow.corsi_for_pct != null && oppRow.corsi_for_pct != null) {
    carCF = (carRow.corsi_for_pct * 100).toFixed(1);
    oppCF = (oppRow.corsi_for_pct * 100).toFixed(1);
    corsiSource = 'all_situations';
  }
  const corsiCaveat = carCF != null
    ? `${corsiSource === '5v5' ? '5-on-5' : 'All-situations'} shot-attempt share from ${prior}, ${tc.displayName}'s last completed season — not this season's form.`
    : `Real Corsi data unavailable for ${prior}.`;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const homeAdj = isHome ? 0.12 : -0.12;
  const expCar = clamp(Math.sqrt(Math.max(carGpg, 0.5) * Math.max(oppGag, 0.5)) + homeAdj, 1.5, 5.0).toFixed(1);
  const expOpp = clamp(Math.sqrt(Math.max(oppGpg, 0.5) * Math.max(carGag, 0.5)) - homeAdj, 1.5, 5.0).toFixed(1);

  const prompt = `You are EyeWall Analytics, a ${tc.displayName} hockey analytics assistant. Write a sharp, data-driven PRESEASON analysis for ${tc.displayName} fans — no games have been played yet this season, so this is based on last season's (${prior}) final numbers, adjusted for roster turnover. 2-3 sentences only. Be specific about the numbers and be clear this is a preseason estimate, not current form. No filler. No "In this matchup" opener.

Game: ${tc.abbr} (${isHome ? 'HOME' : 'AWAY'}) vs ${oppAbbr}
Context: Preseason estimate, based on ${prior} final standings

${tc.abbr} last season (${prior}): ${carRow.points ?? '—'} pts, GF/GA per game: ${carGpg.toFixed(2)} / ${carGag.toFixed(2)}, PP%: ${carPP.toFixed(1)}%, roster continuity: ${carContinuity != null ? (carContinuity * 100).toFixed(0) + '%' : 'unknown'}
${oppAbbr} last season (${prior}): ${oppRow.points ?? '—'} pts, GF/GA per game: ${oppGpg.toFixed(2)} / ${oppGag.toFixed(2)}, PP%: ${oppPP.toFixed(1)}%, roster continuity: ${oppContinuity != null ? (oppContinuity * 100).toFixed(0) + '%' : 'unknown'}

Expected score (Pythagorean, from last season's rates): ${tc.abbr} ${expCar} - ${oppAbbr} ${expOpp}
Model win probability (roster-continuity adjusted): ${tc.abbr} ${carWinPct}%

Write the analysis now. Mention the single most decisive factor from last season, note the roster continuity level for at least one team if notably low, and a concrete expected-score range.`;

  const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
  });
  const narrative = aiResponse.response?.trim() || '';
  if (!narrative) return json({ error: 'Empty response' });

  const result = {
    gameId,
    oppAbbr,
    isHome,
    isPlayoff,
    carWinPct,
    expCar: parseFloat(expCar),
    expOpp: parseFloat(expOpp),
    narrative,
    h2hRecord: 'no games played yet this season',
    carStreak: 'N/A (preseason)',
    oppStreak: 'N/A (preseason)',
    carCF,
    corsiForPct: { car: carCF != null ? parseFloat(carCF) : null, opp: oppCF != null ? parseFloat(oppCF) : null },
    corsiCaveat,
    generatedAt: new Date().toISOString(),
    regime: 'preseason',
    correction: 'continuity-dampened',
    isFallback: true,
    dataSeason: prior,
    continuity: { car: carContinuity, opp: oppContinuity },
  };

  await kvPut(env, kvKey, result, 24 * 3600);
  console.log(`Preseason prediction analysis generated for game ${gameId} (data season ${prior})`);
  return json(result);
}

function isCompleted(game) {
  return ['OFF','FINAL','F','FINAL_OVERTIME','FINAL_SHOOTOUT'].includes(game.gameState);
}


// broadcast — send to subscribers filtered by teamAbbr + eventType pref
// eventType: 'goal'|'oppGoal'|'gameStart'|'periodStart'|'periodEnd'|
//            'penalty'|'win'|'loss'|'goaliePulled'|'hatTrick'
async function broadcast(env, payload, teamAbbr, eventType) {
  const subs = (await kvGet(env, 'push:subs')) || [];
  if (!subs.length) return;

  // Filter to subscribers for this team who have this pref enabled
  const targets = subs.filter(s => {
    // Legacy subs (no teamAbbr) always match NHL:CAR
    const subTeam = s.teamAbbr || 'NHL:CAR';
    if (subTeam !== teamAbbr) return false;
    // Legacy subs (no prefs) get all events
    if (!s.prefs) return true;
    return s.prefs[eventType] !== false; // default true if not explicitly false
  });

  console.log(`broadcast: ${targets.length}/${subs.length} targets for ${teamAbbr}:${eventType}`);
  if (!targets.length) return;

  const results = await Promise.all(targets.map(s => sendPush(s, payload, env)));

  // Prune expired subs from full list
  const expiredEndpoints = new Set(
    targets.filter((_, i) => results[i] === 'expired').map(s => s.endpoint)
  );
  if (expiredEndpoints.size > 0) {
    const active = subs.filter(s => !expiredEndpoints.has(s.endpoint));
    await kvPut(env, 'push:subs', active, 365 * 24 * 3600);
    console.log(`broadcast: removed ${expiredEndpoints.size} expired subscription(s)`);
  }
  console.log(`broadcast results: ${results.join(', ')}`);
}

// ── Event detection ───────────────────────────────────────────
// Broadcasts to BOTH teams playing in `game`, each framed from their own
// perspective — mirrors pollPWHLGame's dual-broadcast pattern in pwhl.js.
// Used to only ever run for TEAM_ABBR (Carolina); poll() now calls this for
// every live game league-wide, so there's no fixed "our team" here anymore.

async function detectAndNotify(env, game, pbp) {
  if (!game || !pbp?.plays) return;

  const liveId    = game.id;
  const homeAbbr  = game.homeTeam?.abbrev;
  const awayAbbr  = game.awayTeam?.abbrev;
  const homeId    = game.homeTeam?.id;
  const awayId    = game.awayTeam?.id;
  const homeScore = game.homeTeam?.score ?? 0;
  const awayScore = game.awayTeam?.score ?? 0;
  const playCount = pbp.plays.length;
  const period    = pbp.periodDescriptor?.number || 1;

  const stateKey  = `push:gamestate:${liveId}`;
  const lastState = (await kvGet(env, stateKey)) || {
    homeScore: 0, awayScore: 0, playCount: 0, started: false, period: 0,
    goalScorers: {}, // { playerId: count } for hat trick tracking
  };

  const lastPlayIdx = lastState.playCount;
  const newPlays    = pbp.plays.slice(lastPlayIdx);
  const periodLabel = n => n === 4 ? 'OT' : n === 5 ? 'SO' : `P${n}`;

  const notify = (abbr, payload, eventType) => broadcast(env, payload, `NHL:${abbr}`, eventType);

  // ── Game just started ─────────────────────────────────────
  if (!lastState.started && game.gameState === 'LIVE') {
    for (const [abbr, oppAbbr] of [[homeAbbr, awayAbbr], [awayAbbr, homeAbbr]]) {
      await notify(abbr, {
        title: '🏒 Game Starting!',
        body:  TEAM_CONFIGS[abbr]?.gameStartBody(oppAbbr) || `${abbr} vs ${oppAbbr} — puck drop!`,
        tag:   `game-start-${liveId}`,
        url:   '/',
      }, 'gameStart');
    }
  }

  // ── Period start (P2, P3, OT only — P1 = game start) ─────
  if (period > 1 && period !== lastState.period && game.gameState === 'LIVE') {
    for (const [abbr, myScore, oppScore, oppAbbr] of [
      [homeAbbr, homeScore, awayScore, awayAbbr],
      [awayAbbr, awayScore, homeScore, homeAbbr],
    ]) {
      await notify(abbr, {
        title: `🏒 ${periodLabel(period)} Starting`,
        body:  `${abbr} ${myScore}–${oppScore} ${oppAbbr} — ${periodLabel(period)} underway`,
        tag:   `period-start-${liveId}-${period}`,
        url:   '/',
      }, 'periodStart');
    }
  }

  // ── Period end ────────────────────────────────────────────
  if (lastState.period > 0 && period > lastState.period && lastState.started) {
    for (const [abbr, myScore, oppScore, oppAbbr] of [
      [homeAbbr, homeScore, awayScore, awayAbbr],
      [awayAbbr, awayScore, homeScore, homeAbbr],
    ]) {
      await notify(abbr, {
        title: `🔔 End of ${periodLabel(lastState.period)}`,
        body:  `${abbr} ${myScore}–${oppScore} ${oppAbbr} after ${periodLabel(lastState.period)}`,
        tag:   `period-end-${liveId}-${lastState.period}`,
        url:   '/',
      }, 'periodEnd');
    }
  }

  // ── Goals — both directions independently (a poll cycle can, in theory,
  // catch both teams having scored since the last check) ───────────────
  const goalScorers = { ...lastState.goalScorers };

  const handleGoal = async (scoringAbbr, scoringTeamId, scoringScore, otherAbbr, otherScore, lastScoringScore) => {
    const newGoals = scoringScore - lastScoringScore;
    const goalPlay = [...pbp.plays].reverse().find(p =>
      p.typeDescKey === 'goal' && p.details?.eventOwnerTeamId === scoringTeamId
    );
    const scorer   = goalPlay?.details?.scoringPlayerName || scoringAbbr;
    const scorerId = String(goalPlay?.details?.scoringPlayerId || '');
    const shotType = goalPlay?.details?.shotType || null;
    const isSH     = goalPlay?.details?.situationCode?.charAt(1) === '4'; // strength indicator

    if (scorerId) goalScorers[scorerId] = (goalScorers[scorerId] || 0) + newGoals;

    // SH goals still notify under the 'goal' preference — there's no
    // separate shorthanded-goal toggle in NotificationBell's PREF_GROUPS
    // for users to filter by, so no separate eventType is needed here.
    await notify(scoringAbbr, {
      title: `🚨 GOAL! ${scoringAbbr} ${scoringScore}–${otherScore} ${otherAbbr}`,
      body:  newGoals > 1
        ? `${newGoals} goals scored!`
        : `${scorer} scores!${shotType ? ` (${shotType})` : ''}${isSH ? ' ⚡ Short-Handed!' : ''}`,
      tag:   `goal-${liveId}-${scoringAbbr}-${scoringScore}`,
      url:   '/',
    }, 'goal');

    await notify(otherAbbr, {
      title: `${scoringAbbr} scores. ${otherAbbr} ${otherScore}–${scoringScore} ${scoringAbbr}`,
      body:  otherScore === scoringScore ? `${scoringAbbr} ties it up — stay sharp!`
          : otherScore > scoringScore    ? `Still leading — hold the line!`
          :                                `${scoringAbbr} takes the lead. Time to push back!`,
      tag:   `opp-goal-${liveId}-${scoringAbbr}-${scoringScore}`,
      url:   '/',
    }, 'oppGoal');

    if (scorerId && goalScorers[scorerId] === 3) {
      await notify(scoringAbbr, {
        title: `🎩 HAT TRICK! ${scorer}`,
        body:  `${scorer} scores their 3rd goal of the game!`,
        tag:   `hattrick-${liveId}-${scorerId}`,
        url:   '/',
      }, 'hatTrick');
    }
  };

  if (homeScore > lastState.homeScore) {
    await handleGoal(homeAbbr, homeId, homeScore, awayAbbr, awayScore, lastState.homeScore);
  }
  if (awayScore > lastState.awayScore) {
    await handleGoal(awayAbbr, awayId, awayScore, homeAbbr, homeScore, lastState.awayScore);
  }

  // ── Goalie pulled — notify whichever team benefits (empty-net look) ──
  const goaliePull = newPlays.find(p => p.typeDescKey === 'goalie-pulled');
  if (goaliePull) {
    const pulledTeamId  = goaliePull.details?.eventOwnerTeamId;
    const benefitAbbr   = pulledTeamId === homeId ? awayAbbr : homeAbbr;
    const pulledAbbr    = pulledTeamId === homeId ? homeAbbr : awayAbbr;
    const benefitScore  = pulledTeamId === homeId ? awayScore : homeScore;
    const pulledScore   = pulledTeamId === homeId ? homeScore : awayScore;
    await notify(benefitAbbr, {
      title: `🥅 ${pulledAbbr} pulled their goalie!`,
      body:  `6-on-5 — ${benefitAbbr} ${benefitScore}–${pulledScore}. Empty net opportunity!`,
      tag:   `goalie-pull-${liveId}-${lastPlayIdx}`,
      url:   '/',
    }, 'goaliePulled');
  }

  // ── Penalty — notify whichever team gets the power play ──────────────
  const penalty = newPlays.find(p => p.typeDescKey === 'penalty');
  if (penalty) {
    const penTeamId = penalty.details?.eventOwnerTeamId;
    const ppAbbr    = penTeamId === homeId ? awayAbbr : homeAbbr;
    const penAbbr   = penTeamId === homeId ? homeAbbr : awayAbbr;
    const dur  = penalty.details?.duration || 2;
    const desc = penalty.details?.descKey?.replace(/-/g, ' ') || 'penalty';
    await notify(ppAbbr, {
      title: `⚡ ${ppAbbr} Power Play!`,
      body:  `${penAbbr} — ${dur} min ${desc}`,
      tag:   `pp-${liveId}-${lastPlayIdx}`,
      url:   '/',
    }, 'penalty');
  }

  // Save new state
  await kvPut(env, stateKey, {
    homeScore, awayScore, playCount, period,
    started: true,
    goalScorers,
  }, 24 * 3600);
}

async function notifyGameOver(env, game) {
  const sentKey     = `push:gameover:${game.id}`;
  const alreadySent = await kvGet(env, sentKey);
  if (alreadySent) return;

  const homeAbbr  = game.homeTeam?.abbrev;
  const awayAbbr  = game.awayTeam?.abbrev;
  const homeScore = game.homeTeam?.score ?? 0;
  const awayScore = game.awayTeam?.score ?? 0;

  for (const [abbr, myScore, oppScore, oppAbbr] of [
    [homeAbbr, homeScore, awayScore, awayAbbr],
    [awayAbbr, awayScore, homeScore, homeAbbr],
  ]) {
    const won = myScore > oppScore;
    await broadcast(env, won ? {
      title: `🏆 ${abbr} Win! ${abbr} ${myScore}–${oppScore} ${oppAbbr}`,
      body:  TEAM_CONFIGS[abbr]?.winCopy || 'Final score — great win!',
      tag:   `win-${game.id}-${abbr}`,
      url:   '/',
    } : {
      title: `Final: ${abbr} ${myScore}–${oppScore} ${oppAbbr}`,
      body:  TEAM_CONFIGS[abbr]?.lossCopy || 'Final score.',
      tag:   `final-${game.id}-${abbr}`,
      url:   '/',
    }, `NHL:${abbr}`, won ? 'win' : 'loss');
  }

  await kvPut(env, sentKey, true, 24 * 3600);

  // AI game summary (and the social post it triggers) deliberately stay
  // scoped to this app's own team, not every team playing tonight — X
  // posting for all 32 teams was explicitly deferred (2026-07), and
  // summary:${gameId} has no other reader (the in-app "game summary" UI
  // reads the separate, already-per-team /summary/narrative system, not
  // this KV blob) so there's no reason to generate it for games this app's
  // own team wasn't even in.
  if (homeAbbr === DEFAULT_TEAM_ABBR || awayAbbr === DEFAULT_TEAM_ABBR) {
    await generateGameSummary(env, game).catch(e =>
      console.error('Summary generation error:', e.message)
    );
  }
}

// ── Game Summary Card ─────────────────────────────────────────
async function generateGameSummary(env, game) {
  const gameId     = game.id;
  const summaryKey = `summary:${gameId}`;

  // Don't regenerate if already done
  if (await kvGet(env, summaryKey)) return;

  console.log(`Generating summary for game ${gameId}...`);

  // Always fetch fresh PBP for completed games — KV may have pre-final data
  // Re-fetch directly from NHL to ensure OT goals are included
  const [freshPbp, freshBs] = await Promise.allSettled([
    nhlGet(`${NHL_BASE}/gamecenter/${gameId}/play-by-play`),
    nhlGet(`${NHL_BASE}/gamecenter/${gameId}/boxscore`),
  ]);
  const pbp      = freshPbp.status === 'fulfilled' ? freshPbp.value : await kvGet(env, `pbp:${gameId}`);
  const boxscore = freshBs.status  === 'fulfilled' ? freshBs.value  : await kvGet(env, `boxscore:${gameId}`);

  // Store the fresh final PBP in KV for the app to read
  if (freshPbp.status === 'fulfilled') await kvPut(env, `pbp:${gameId}`, freshPbp.value, 3600);
  if (freshBs.status  === 'fulfilled') await kvPut(env, `boxscore:${gameId}`, freshBs.value, 3600);
  const isHome   = game.homeTeam?.abbrev === TEAM_ABBR;
  const carScore = isHome ? game.homeTeam?.score : game.awayTeam?.score;
  const oppScore = isHome ? game.awayTeam?.score : game.homeTeam?.score;
  const oppAbbr  = isHome ? game.awayTeam?.abbrev : game.homeTeam?.abbrev;
  const won      = carScore > oppScore;

  // Build player name map from rosterSpots (same as app's buildPlayerMap)
  const playerMap = {};
  (pbp?.rosterSpots || []).forEach(p => {
    if (p.playerId) {
      playerMap[String(p.playerId)] =
        `${p.firstName?.default || ''} ${p.lastName?.default || ''}`.trim();
    }
  });
  const pName = id => playerMap[String(id)] || null;

  // Compute Corsi from PBP
  let carAttempts = 0, totalAttempts = 0;
  const goals = [], penalties = [];
  if (pbp?.plays) {
    pbp.plays.forEach(p => {
      const isCar = p.details?.eventOwnerTeamId === TEAM_ID;
      const t     = p.typeDescKey;
      if (['goal','shot-on-goal','missed-shot','blocked-shot'].includes(t)) {
        if (isCar) carAttempts++;
        totalAttempts++;
      }
      if (t === 'goal') goals.push({
        team:   isCar ? TEAM_ABBR : oppAbbr,
        scorer: pName(p.details?.scoringPlayerId) || 'Unknown',
        period: p.periodDescriptor?.number,
        time:   p.timeInPeriod,
        shot:   p.details?.shotType || '',
      });
      if (t === 'penalty') penalties.push({
        team: isCar ? TEAM_ABBR : oppAbbr,
        desc: (p.details?.descKey || 'penalty').replace(/-/g, ' '),
        mins: p.details?.duration || 2,
      });
    });
  }
  const cfPct = totalAttempts > 0 ? Math.round(carAttempts / totalAttempts * 100) : 50;

  // CAR goalie stats
  let carGoalie = null;
  const goalies = isHome
    ? boxscore?.playerByGameStats?.homeTeam?.goalies
    : boxscore?.playerByGameStats?.awayTeam?.goalies;
  const g = goalies?.find(g => g.saves > 0 || (g.toi && g.toi !== '00:00'));
  if (g) carGoalie = {
    name:   g.name?.default || 'Goalie',
    saves:  g.saves,
    shots:  g.shotsAgainst,
    svPct:  g.savePctg != null
      ? (g.savePctg <= 1 ? g.savePctg : g.savePctg / 100) // store as decimal 0-1
      : null,
  };

  // Game-winning goal: OT goal if it went to OT, otherwise the CAR goal
  // that gave them the margin they won by
  const carGoals = goals.filter(g => g.team === TEAM_ABBR);
  const otGoal   = carGoals.find(g => g.period >= 4); // OT or shootout
  let topScorer  = null;
  if (otGoal) {
    topScorer = otGoal.scorer; // OT winner is always the GWG scorer
  } else if (won && carGoals.length > 0) {
    // GWG = the goal that gave CAR a lead they never relinquished
    // Simple proxy: the goal that made the score carScore - (oppScore - 1) → final margin
    // i.e. the last goal that mattered = carGoals[carScore - oppScore - 1] index
    // (0-indexed: in a 3-2 win, goal index 1 = the 2nd CAR goal = the GWG)
    const gwgIndex = Math.max(0, (oppScore ?? 0)); // = winning margin goal
    topScorer = carGoals[Math.min(gwgIndex, carGoals.length - 1)]?.scorer || carGoals[carGoals.length - 1]?.scorer || null;
  } else if (!won && carGoals.length > 0) {
    topScorer = carGoals[carGoals.length - 1]?.scorer || null; // show last CAR goal in a loss
  }
  const carPens   = penalties.filter(p => p.team === TEAM_ABBR).length;
  const oppPens   = penalties.filter(p => p.team !== TEAM_ABBR).length;

  // Build explicit allowed-names list — only players confirmed in this game's data
  const goalScorerNames = [...new Set(goals.map(g => g.scorer).filter(n => n && n !== 'Unknown'))];
  const allowedNames    = carGoalie
    ? [...goalScorerNames, carGoalie.name]
    : goalScorerNames;
  const allowedBlock = allowedNames.length > 0
    ? `Players you may name: ${allowedNames.join(', ')}. Do not name any other player.`
    : `No confirmed player names — refer to teams by abbreviation only.`;

  const prompt = `You are EyeWall Analytics, a ${TEAM_CONFIG.displayName} hockey analytics voice. Write a sharp 3-sentence game summary for ${TEAM_CONFIG.displayName} fans. Use the stats. Write flowing prose — no bullets, no headers.

Result: CAR ${carScore}-${oppScore} ${oppAbbr} (${won ? 'WIN' : 'LOSS'}) · ${game.gameDate} · ${isHome ? 'Home' : 'Away'}
Corsi For%: ${cfPct}% (${cfPct >= 50 ? 'CAR controlled possession' : 'CAR was outshot territorially'})
Goals: ${goals.map(g => `${g.team} ${g.scorer} P${g.period} ${g.time}`).join(' | ') || 'no goals recorded'}
${carGoalie ? `CAR Goalie: ${carGoalie.name} — ${carGoalie.saves}/${carGoalie.shots} (${carGoalie.svPct != null ? (carGoalie.svPct * 100).toFixed(1) : '—'}% SV%)` : ''}
${topScorer ? `Top CAR scorer: ${topScorer}` : ''}
Penalties — CAR: ${carPens}, ${oppAbbr}: ${oppPens}

${allowedBlock}

3 sentences only. Sentence 1: result and key storyline. Sentence 2: possession/goaltending insight. Sentence 3: one forward-looking thought.`;

  const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }],
  });
  const narrative = aiResponse.response?.trim() || '';
  if (!narrative)  { console.error('Empty narrative'); return; }

  const summaryData = {
    gameId, gameDate: game.gameDate, won,
    carScore, oppScore, oppAbbr, isHome,
    cfPct, narrative, topScorer, carGoalie, goals,
    generatedAt: new Date().toISOString(),
  };
  await kvPut(env, summaryKey, summaryData, 30 * 24 * 3600); // 30 days
  console.log(`Summary stored for game ${gameId}`);

  // Post to social media (wait ~10s for any final data to settle)
  await new Promise(r => globalThis.setTimeout(r, 10000));
  await postGameToSocial(env, game, summaryData).catch(e =>
    console.error('Social post error:', e.message)
  );
}

// ── X (Twitter) Posting ──────────────────────────────────────

// OAuth 1.0a signing for X API v2
async function signOAuth1(method, url, params, env) {
  const oauthParams = {
    oauth_consumer_key:     env.X_CONSUMER_KEY,
    oauth_nonce:            crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_token:            env.X_ACCESS_TOKEN,
    oauth_version:          '1.0',
  };

  // Combine and sort all params for signature base string
  const allParams = { ...params, ...oauthParams };
  const paramStr  = Object.keys(allParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseStr = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramStr),
  ].join('&');

  const signingKey = `${encodeURIComponent(env.X_CONSUMER_SECRET)}&${encodeURIComponent(env.X_ACCESS_SECRET)}`;

  const keyData  = new TextEncoder().encode(signingKey);
  const msgData  = new TextEncoder().encode(baseStr);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  oauthParams.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const authHeader = 'OAuth ' + Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return authHeader;
}

async function postToX(env, text) {
  if (!env.X_CONSUMER_KEY || !env.X_ACCESS_TOKEN) {
    console.log('X credentials not configured, skipping post');
    return null;
  }

  const url    = 'https://api.twitter.com/2/tweets';
  const body   = JSON.stringify({ text });
  const auth   = await signOAuth1('POST', url, {}, env);

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': auth,
      'Content-Type':  'application/json',
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('X post failed:', JSON.stringify(data).slice(0, 200));
    return null;
  }
  console.log('X post success:', data?.data?.id);
  return data?.data?.id;
}

// Build opponent hashtag from abbreviation
function oppHashtag(abbr) {
  const map = {
    BOS: '#BostonBruins',   TOR: '#LeafsForever',   TBL: '#GoBolts',
    FLA: '#TimeToHunt',     MTL: '#GoHabsGo',        OTT: '#GoSensGo',
    BUF: '#LetsGoBuffalo',  DET: '#LGRW',            CBJ: '#CBJ',
    NYR: '#NYR',            NYI: '#Isles',            NJD: '#NJDevils',
    PHI: '#Flyers',         WSH: '#ALLCAPS',          PIT: '#LetsGoPens',
    CHI: '#Blackhawks',     NSH: '#Preds',            STL: '#STLBlues',
    WPG: '#GoJetsGo',       MIN: '#MNWild',           COL: '#GoAvsGo',
    DAL: '#GoStars',        UTA: '#TusksUp',          VGK: '#VegasBorn',
    SEA: '#SeattleKraken',  ANA: '#FlyTogether',      LAK: '#GoKingsGo',
    SJS: '#SJSharks',       CGY: '#Flames',           EDM: '#LetsGoOilers',
    VAN: '#Canucks',
  };
  return map[abbr] || `#${abbr}`;
}

function buildGamePost(game, summary) {
  const { won, carScore, oppScore, oppAbbr, isHome, narrative, goals = [] } = summary;
  const isPlayoff  = game.gameType === 3;
  const result     = won ? '🌀 WIN' : '❌ LOSS';
  const scoreStr   = `CAR ${carScore}-${oppScore} ${oppAbbr}`;
  const venue      = isHome ? 'Home' : 'Away';

  // OT/SO indicator
  const maxPeriod  = goals.length > 0 ? Math.max(...goals.map(g => g.period)) : 3;
  const periodStr  = maxPeriod === 4 ? ' (OT)' : maxPeriod > 4 ? ' (SO)' : '';

  // Build hashtags
  const tags = [
    ...TEAM_CONFIG.hashtags,
    oppHashtag(oppAbbr),
    isPlayoff ? '#StanleyCupPlayoffs' : '#GameRecap',
  ].join(' ');

  // Trim narrative to fit — X limit is 280 chars
  // Reserve: result(10) + score(15) + venue(8) + narrative(~180) + link(25) + tags(~80) + newlines(6)
  const maxNarrative = 120;
  const trimmed = narrative.length > maxNarrative
    ? narrative.slice(0, maxNarrative).replace(/\s+\S*$/, '') + '…'
    : narrative;

  const post = `${result}: ${scoreStr}${periodStr} · ${venue}

${trimmed}

${tags}

📊 eyewallanalytics.com`;

  return post;
}

async function postGameToSocial(env, game, summary) {
  const postKey = `social:posted:${game.id}`;
  if (await kvGet(env, postKey)) {
    console.log(`Social post already sent for game ${game.id}`);
    return;
  }

  const text = buildGamePost(game, summary);
  console.log('Posting to X:', text.slice(0, 80) + '...');

  const tweetId = await postToX(env, text);
  if (tweetId) {
    await kvPut(env, postKey, { tweetId, postedAt: new Date().toISOString() }, 7 * 24 * 3600);
    console.log(`Social post sent for game ${game.id}`);
  }
}

// ── MoneyPuck Player Analytics ───────────────────────────────

// MP_URL used to be built from a hardcoded MP_SEASON constant here —
// a second, Worker-side copy of the exact bug found in the Python
// pipeline's moneypuck.py (a separately-hardcoded MoneyPuck year,
// decoupled from the actual season). Now built live inside
// fetchAndComputeMoneyPuck(), which already has `env` in scope.
const MIN_GP = 10; // minimum games to include in percentile pool

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  // Only parse rows for situations we need — skip others for speed
  const neededSituations = new Set(['all', '5on5', 'powerPlay', 'penaltyKill']);
  const sitIdx = headers.indexOf('situation');
  return lines.slice(1).reduce((acc, line) => {
    // Quick check before full parse
    if (sitIdx >= 0) {
      const sit = line.split(',')[sitIdx];
      if (!neededSituations.has(sit)) return acc;
    }
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    acc.push(row);
    return acc;
  }, []);
}

function n(v) { return parseFloat(v) || 0; }

function per60(stat, icetimeSeconds) {
  if (!icetimeSeconds || icetimeSeconds < 60) return 0;
  return (n(stat) / icetimeSeconds) * 3600;
}

function percentileRank(value, sortedValues) {
  if (!sortedValues.length || value == null) return null;
  // Binary search on pre-sorted array — O(log n) vs O(n)
  let lo = 0, hi = sortedValues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.round((lo / sortedValues.length) * 100);
}

// Compute all analytics for a team's players + league context for percentiles
async function fetchAndComputeMoneyPuck(env, teamAbbr = TEAM_ABBR) {
  const cacheKey = `moneypuck:skaters:${teamAbbr}`;
  const cached   = await kvGet(env, cacheKey);
  if (cached) return cached;

  // Phase 1: fetch CSV and store raw rows in KV (fast — mostly I/O)
  let rows = await kvGet(env, 'moneypuck:raw');
  if (!rows) {
    const season = await resolveNHLSeason(env);
    const mpYear = String(season).slice(0, 4); // MoneyPuck's URL scheme wants the start year
    const mpUrl  = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${mpYear}/regular/skaters.csv`;
    console.log(`Fetching MoneyPuck skaters CSV (${mpYear})...`);
    const res = await fetch(mpUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://moneypuck.com/',
      }
    });
    if (!res.ok) throw new Error(`MoneyPuck fetch failed: ${res.status}`);
    const text = await res.text();
    rows = parseCSV(text);
    // Store raw rows for 25 hours so phase 2 can use them
    await kvPut(env, 'moneypuck:raw', rows, 25 * 3600);
  }

  // Phase 2: compute analytics from raw rows
  return computeMoneyPuckAnalytics(env, rows, teamAbbr);
}

async function computeMoneyPuckAnalytics(env, rows, teamAbbr = TEAM_ABBR) {
  const cacheKey = `moneypuck:skaters:${teamAbbr}`;

  // Filter to 5on5 and powerPlay situations for the right context
  const ev  = rows.filter(r => r.situation === '5on5');
  const pp  = rows.filter(r => r.situation === 'powerPlay');
  const pk  = rows.filter(r => r.situation === 'penaltyKill');
  const all = rows.filter(r => r.situation === 'all');

  // Index by playerId for quick lookup
  const byId = (arr) => {
    const m = {};
    arr.forEach(r => { m[r.playerId] = r; });
    return m;
  };
  const evMap  = byId(ev);
  const ppMap  = byId(pp);
  const pkMap  = byId(pk);

  // Build league-wide pools for percentile computation
  // Only include players with MIN_GP games and real icetime
  const qualified = all.filter(r => n(r.games_played) >= MIN_GP && n(r.icetime) >= 300);
  const fwds = qualified.filter(r => ['C','L','R','F'].includes(r.position));
  const defs = qualified.filter(r => r.position === 'D');

  // Build sorted pools for O(log n) percentile lookup
  function buildPool(players, metricFn) {
    return players.map(metricFn)
      .filter(v => v != null && !isNaN(v))
      .sort((a, b) => a - b);
  }

  // ── Metric functions ──────────────────────────────────────────

  // EV Offense: on-ice xGF% at 5on5 (higher = better offense with player on ice)
  const evOffFn = (allRow) => {
    const evRow = evMap[allRow.playerId];
    return evRow ? n(evRow.onIce_xGoalsPercentage) : null;
  };

  // EV Defense: xGA/60 at 5on5, inverted (lower GA = better defense)
  const evDefFn = (allRow) => {
    const evRow = evMap[allRow.playerId];
    if (!evRow || !n(evRow.icetime)) return null;
    // Use on-ice xGA/60, inverted so higher = better defense
    const xGA60 = per60(evRow.OnIce_A_xGoals, n(evRow.icetime));
    return xGA60 > 0 ? 1 / xGA60 : null; // invert: lower GA = higher rank
  };

  // PP: PP xGF/60 (only players with PP time)
  const ppOffFn = (allRow) => {
    const ppRow = ppMap[allRow.playerId];
    if (!ppRow || n(ppRow.icetime) < 60) return null;
    return per60(ppRow.OnIce_F_xGoals, n(ppRow.icetime));
  };

  // PK: PK xGA/60, inverted
  const pkDefFn = (allRow) => {
    const pkRow = pkMap[allRow.playerId];
    if (!pkRow || n(pkRow.icetime) < 60) return null;
    const xGA60 = per60(pkRow.OnIce_A_xGoals, n(pkRow.icetime));
    return xGA60 > 0 ? 1 / xGA60 : null;
  };

  // Finishing: individual goals vs xGoals (positive = overperforming)
  const finishingFn = (allRow) => {
    const it = n(allRow.icetime);
    if (!it) return null;
    // Goals above xGoals per 60
    return per60(n(allRow.I_F_goals) - n(allRow.I_F_xGoals), it);
  };

  // Goals/60
  const goalsFn = (allRow) => per60(allRow.I_F_goals, n(allRow.icetime));

  // Primary assists/60
  const a1Fn = (allRow) => per60(allRow.I_F_primaryAssists, n(allRow.icetime));

  // Penalties: drawn minus taken per 60 (higher = better)
  const penFn = (allRow) => {
    const evRow = evMap[allRow.playerId];
    if (!evRow || !n(evRow.icetime)) return null;
    // penalityMinutes taken (cost) vs drawn (benefit) 
    // MoneyPuck has penalityMinutes as individual minutes taken
    // We approximate drawn from the difference between on-ice penalties and individual
    // Use gameScore as a proxy for now — penaltyDifferential not directly available
    // Fallback: use -penalityMinutes/60 (negative PIM = good discipline)
    return -per60(allRow.I_F_penalityMinutes, n(allRow.icetime));
  };

  // Competition: offIce_xGoalsPercentage at EV (higher opponent quality when you're OFF ice = harder comp when on)
  // We use the delta: onIce - offIce xGF% at 5on5 (positive = adding value beyond their competition)
  const compFn = (allRow) => {
    const evRow = evMap[allRow.playerId];
    if (!evRow) return null;
    // Higher offIce% = harder competition context
    return n(evRow.offIce_xGoalsPercentage);
  };

  // Teammates: onIce - offIce delta (positive = player elevates their teammates)
  const tmFn = (allRow) => {
    const evRow = evMap[allRow.playerId];
    if (!evRow) return null;
    return n(evRow.onIce_xGoalsPercentage) - n(evRow.offIce_xGoalsPercentage);
  };

  // ── WAR approximation ─────────────────────────────────────────
  // Simplified: (goals above average) + (penalty impact) / goals_per_win
  // Goals per win ≈ 5.4 for 2024-25
  const GOALS_PER_WIN = 5.4;
  const PENALTY_MIN_VALUE = 0.11; // goals per penalty minute (from methodology)

  // League average metrics for "above average" calculation
  const leagueAvgxGF60 = (pool) => {
    const vals = pool.map(r => per60(r.OnIce_F_xGoals, n(r.icetime))).filter(v => v > 0);
    return vals.reduce((a,b) => a+b, 0) / (vals.length || 1);
  };
  const leagueAvgxGA60 = (pool) => {
    const vals = pool.map(r => per60(r.OnIce_A_xGoals, n(r.icetime))).filter(v => v > 0);
    return vals.reduce((a,b) => a+b, 0) / (vals.length || 1);
  };

  const fwdAvgxGF60 = leagueAvgxGF60(fwds);
  const defAvgxGF60 = leagueAvgxGF60(defs);
  const fwdAvgxGA60 = leagueAvgxGA60(fwds);
  const defAvgxGA60 = leagueAvgxGA60(defs);

  function computeWAR(allRow, isForward) {
    const evRow = evMap[allRow.playerId];
    if (!evRow) return null;
    const it = n(evRow.icetime) / 3600; // hours of EV ice

    const avgxGF60 = isForward ? fwdAvgxGF60 : defAvgxGF60;
    const avgxGA60 = isForward ? fwdAvgxGA60 : defAvgxGA60;

    const xGF60 = per60(evRow.OnIce_F_xGoals, n(evRow.icetime));
    const xGA60 = per60(evRow.OnIce_A_xGoals, n(evRow.icetime));

    // Goals above average (offensive + defensive)
    const offGAA = (xGF60 - avgxGF60) * it;
    const defGAA = (avgxGA60 - xGA60) * it;

    // Penalty impact (goals equivalent)
    const penGoals = n(allRow.I_F_penalityMinutes) * PENALTY_MIN_VALUE * -1; // taken = negative

    // Individual finishing above xGoals
    const finishing = n(allRow.I_F_goals) - n(allRow.I_F_xGoals);

    // Total goals above average → wins above replacement
    // Replacement level ≈ -0.5 WAR per 82 games for a regular player
    const gaa = offGAA + defGAA + penGoals * 0.3 + finishing * 0.3;
    const war = (gaa / GOALS_PER_WIN) + 0.5; // add replacement baseline

    return Math.round(war * 100) / 100;
  }

  // ── Build league pools for percentiles ───────────────────────
  const fwdPool = { evOff: buildPool(fwds, evOffFn), evDef: buildPool(fwds, evDefFn),
    pp: buildPool(fwds, ppOffFn), pk: buildPool(fwds, pkDefFn),
    finishing: buildPool(fwds, finishingFn), goals: buildPool(fwds, goalsFn),
    a1: buildPool(fwds, a1Fn), pen: buildPool(fwds, penFn),
    comp: buildPool(fwds, compFn), tm: buildPool(fwds, tmFn) };
  const defPool = { evOff: buildPool(defs, evOffFn), evDef: buildPool(defs, evDefFn),
    pp: buildPool(defs, ppOffFn), pk: buildPool(defs, pkDefFn),
    finishing: buildPool(defs, finishingFn), goals: buildPool(defs, goalsFn),
    a1: buildPool(defs, a1Fn), pen: buildPool(defs, penFn),
    comp: buildPool(defs, compFn), tm: buildPool(defs, tmFn) };

  // ── Compute for team players ──────────────────────────────────
  const carPlayers = all.filter(r => r.team === teamAbbr && n(r.games_played) >= 1);
  const result = {};

  for (const row of carPlayers) {
    const isF = ['C','L','R','F'].includes(row.position);
    const pool = isF ? fwdPool : defPool;

    const evOff     = evOffFn(row);
    const evDef     = evDefFn(row);
    const ppVal     = ppOffFn(row);
    const pkVal     = pkDefFn(row);
    const finishing = finishingFn(row);
    const goals     = goalsFn(row);
    const a1        = a1Fn(row);
    const pen       = penFn(row);
    const comp      = compFn(row);
    const tm        = tmFn(row);
    const war       = computeWAR(row, isF);

    // Raw stats for display
    const evRow  = evMap[row.playerId];
    const ppRow  = ppMap[row.playerId];
    const pkRow  = pkMap[row.playerId];

    result[row.playerId] = {
      name:     row.name,
      team:     row.team,
      position: row.position,
      gp:       n(row.games_played),
      war,
      // Percentile rankings (null if insufficient data)
      percentiles: {
        evOff:     { val: evOff,     pct: percentileRank(evOff,     pool.evOff),    label: 'EV Offence',  note: 'On-ice xGF% at 5-on-5' },
        evDef:     { val: evDef,     pct: percentileRank(evDef,     pool.evDef),    label: 'EV Defence',  note: 'On-ice xGA/60 at 5-on-5 (lower = better)' },
        pp:        { val: ppVal,     pct: ppRow && n(ppRow.icetime) >= 60 ? percentileRank(ppVal, pool.pp) : null,   label: 'Power Play', note: 'PP xGF/60' },
        pk:        { val: pkVal,     pct: pkRow && n(pkRow.icetime) >= 60 ? percentileRank(pkVal, pool.pk) : null,   label: 'Penalty Kill', note: 'PK xGA/60 (lower = better)' },
        finishing: { val: finishing, pct: percentileRank(finishing, pool.finishing), label: 'Finishing',   note: 'Goals above xGoals per 60' },
        goals:     { val: goals,     pct: percentileRank(goals,     pool.goals),    label: 'Goals',       note: 'Goals per 60 min' },
        a1:        { val: a1,        pct: percentileRank(a1,        pool.a1),       label: '1st Assists', note: 'Primary assists per 60 min' },
        penalties: { val: pen,       pct: percentileRank(pen,       pool.pen),      label: 'Penalties',   note: 'Penalty discipline (drawn minus taken)' },
        comp:      { val: comp,      pct: percentileRank(comp,      pool.comp),     label: 'Competition', note: 'Quality of competition faced' },
        teammates: { val: tm,        pct: percentileRank(tm,        pool.tm),       label: 'Teammates',   note: 'Player impact vs teammates (on-ice minus off-ice xGF%)' },
      },
      // Context stats for display
      evXGF60:   evRow ? Math.round(per60(evRow.OnIce_F_xGoals, n(evRow.icetime)) * 100) / 100 : null,
      evXGA60:   evRow ? Math.round(per60(evRow.OnIce_A_xGoals, n(evRow.icetime)) * 100) / 100 : null,
      xGF_pct:   evRow ? Math.round(n(evRow.onIce_xGoalsPercentage) * 1000) / 10 : null,
      goals60:   Math.round(goals * 100) / 100,
      a1_60:     Math.round(a1 * 100) / 100,
      ppToi:     ppRow ? Math.round(n(ppRow.icetime) / 60) : 0,
      pkToi:     pkRow ? Math.round(n(pkRow.icetime) / 60) : 0,
      gameScore: Math.round(n(row.gameScore) * 100) / 100,
    };
  }

  // Cache for 12 hours (MoneyPuck updates nightly, 4hr was expiring too often)
  await kvPut(env, cacheKey, result, 12 * 3600);
  console.log(`MoneyPuck: computed analytics for ${Object.keys(result).length} ${teamAbbr} players`);
  return result;
}

// ── News fetching ─────────────────────────────────────────────

// Generic NHL news sources — always included regardless of team.
// Sources with filterKey: 'team' have a dynamic per-team filter injected
// by getNewsSources() so league-wide feeds are narrowed to relevant articles.
const NHL_NEWS_SOURCES = [
  {
    id:    'espn',
    name:  'ESPN',
    color: '#cc0000',
    url:   'https://www.espn.com/espn/rss/nhl/news',
    type:  'espn',
  },
  {
    id:        'sportsnet',
    name:      'Sportsnet',
    color:     '#d4a017',
    url:       'https://www.sportsnet.ca/feed/',
    type:      'sportsnet',
    filterKey: 'team',  // injected per-team at runtime by getNewsSources()
  },
  {
    id:    'thescore',
    name:  'The Score',
    color: '#e8000d',
    url:   'https://origin-feeds.thescore.com/nhl.rss',
    type:  'rss',
  },
  {
    // The Athletic NHL — league-wide feed, filtered per team at runtime
    id:        'athletic',
    name:      'The Athletic',
    color:     '#222222',
    url:       'https://www.nytimes.com/athletic/rss/nhl/',
    type:      'rss',
    filterKey: 'team',
  },
  {
    // Bleacher Report — league-wide feed, filtered per team at runtime
    id:        'bleacherreport',
    name:      'Bleacher Report',
    color:     '#f5a623',
    url:       'https://feeds.bleacherreport.com/articles',
    type:      'rss',
    filterKey: 'team',
  },
];

// Team-specific news sources — keyed by team abbrev.
// Each team: one beat/fan-blog + one Reddit. UTA Reddit only (no blog yet).
const TEAM_NEWS_SOURCES = {
  ANA: [
    { id: 'reddit-ana',        name: 'r/AnaheimDucks',         color: '#f47a38', url: 'https://www.reddit.com/r/AnaheimDucks/new.json',         type: 'reddit' },
  ],
  BOS: [
    { id: 'reddit-bos',        name: 'r/BostonBruins',         color: '#fcb514', url: 'https://www.reddit.com/r/BostonBruins/new.json',         type: 'reddit' },
  ],
  BUF: [
    { id: 'reddit-buf',        name: 'r/sabres',               color: '#003e7e', url: 'https://www.reddit.com/r/sabres/new.json',               type: 'reddit' },
  ],
  CGY: [
    { id: 'flamesnation',      name: 'Flames Nation',          color: '#d2122e', url: 'https://flamesnation.ca/feed/',                         type: 'rss'    },
    { id: 'reddit-cgy',        name: 'r/calgaryflames',        color: '#d2122e', url: 'https://www.reddit.com/r/calgaryflames/new.json',        type: 'reddit' },
  ],
  CAR: [
    { id: 'canescountry',      name: 'Canes Country',          color: '#cc2200', url: 'https://www.canescountry.com/rss/current.xml',          type: 'atom'   },
    { id: 'reddit-car',        name: 'r/canes',                color: '#cc2200', url: 'https://www.reddit.com/r/canes/new.json',                type: 'reddit' },
  ],
  CHI: [
    { id: 'reddit-chi',        name: 'r/hawks',                color: '#cf0a2c', url: 'https://www.reddit.com/r/hawks/new.json',                type: 'reddit' },
  ],
  COL: [
    { id: 'milehighhockey',    name: 'Mile High Hockey',       color: '#6f263d', url: 'https://www.milehighhockey.com/rss/current.xml',        type: 'atom'   },
    { id: 'reddit-col',        name: 'r/coloradoavalanche',    color: '#6f263d', url: 'https://www.reddit.com/r/coloradoavalanche/new.json',    type: 'reddit' },
  ],
  CBJ: [
    { id: 'reddit-cbj',        name: 'r/BlueJackets',          color: '#002654', url: 'https://www.reddit.com/r/BlueJackets/new.json',          type: 'reddit' },
  ],
  DAL: [
    { id: 'reddit-dal',        name: 'r/DallasStars',          color: '#006847', url: 'https://www.reddit.com/r/DallasStars/new.json',          type: 'reddit' },
  ],
  DET: [
    { id: 'reddit-det',        name: 'r/DetroitRedWings',      color: '#ce1126', url: 'https://www.reddit.com/r/DetroitRedWings/new.json',      type: 'reddit' },
  ],
  EDM: [
    { id: 'oilersnation',      name: 'Oilers Nation',          color: '#fc4c02', url: 'https://oilersnation.com/feed/',                        type: 'rss'    },
    { id: 'reddit-edm',        name: 'r/EdmontonOilers',       color: '#fc4c02', url: 'https://www.reddit.com/r/EdmontonOilers/new.json',       type: 'reddit' },
  ],
  FLA: [
    { id: 'reddit-fla',        name: 'r/FloridaPanthers',      color: '#c8102e', url: 'https://www.reddit.com/r/FloridaPanthers/new.json',      type: 'reddit' },
  ],
  LAK: [
    { id: 'reddit-lak',        name: 'r/losangeleskings',      color: '#111111', url: 'https://www.reddit.com/r/losangeleskings/new.json',      type: 'reddit' },
  ],
  MIN: [
    { id: 'reddit-min',        name: 'r/wildhockey',           color: '#154734', url: 'https://www.reddit.com/r/wildhockey/new.json',           type: 'reddit' },
  ],
  MTL: [
    { id: 'reddit-mtl',        name: 'r/Habs',                 color: '#af1e2d', url: 'https://www.reddit.com/r/Habs/new.json',                 type: 'reddit' },
  ],
  NSH: [
    { id: 'reddit-nsh',        name: 'r/predators',            color: '#ffb81c', url: 'https://www.reddit.com/r/predators/new.json',            type: 'reddit' },
  ],
  NJD: [
    { id: 'allaboutthejersey', name: 'All About The Jersey',   color: '#ce1126', url: 'https://www.allaboutthejersey.com/rss/current.xml',     type: 'atom'   },
    { id: 'reddit-njd',        name: 'r/devils',               color: '#ce1126', url: 'https://www.reddit.com/r/devils/new.json',               type: 'reddit' },
  ],
  NYI: [
    { id: 'lighthousehockey',  name: 'Lighthouse Hockey',      color: '#00539b', url: 'https://www.lighthousehockey.com/rss/current.xml',      type: 'atom'   },
    { id: 'reddit-nyi',        name: 'r/NewYorkIslanders',     color: '#00539b', url: 'https://www.reddit.com/r/NewYorkIslanders/new.json',     type: 'reddit' },
  ],
  NYR: [
    { id: 'reddit-nyr',        name: 'r/rangers',              color: '#0038a8', url: 'https://www.reddit.com/r/rangers/new.json',              type: 'reddit' },
  ],
  OTT: [
    { id: 'reddit-ott',        name: 'r/OttawaSenators',       color: '#c52128', url: 'https://www.reddit.com/r/OttawaSenators/new.json',       type: 'reddit' },
  ],
  PHI: [
    { id: 'reddit-phi',        name: 'r/flyers',               color: '#f74902', url: 'https://www.reddit.com/r/flyers/new.json',               type: 'reddit' },
  ],
  PIT: [
    { id: 'pensburgh',         name: 'PensBurgh',              color: '#fcb514', url: 'https://www.pensburgh.com/rss/current.xml',             type: 'atom'   },
    { id: 'reddit-pit',        name: 'r/penguins',             color: '#fcb514', url: 'https://www.reddit.com/r/penguins/new.json',             type: 'reddit' },
  ],
  SEA: [
    { id: 'reddit-sea',        name: 'r/SeattleKraken',        color: '#001628', url: 'https://www.reddit.com/r/SeattleKraken/new.json',        type: 'reddit' },
  ],
  SJS: [
    { id: 'reddit-sjs',        name: 'r/SanJoseSharks',        color: '#006d75', url: 'https://www.reddit.com/r/SanJoseSharks/new.json',        type: 'reddit' },
  ],
  STL: [
    { id: 'reddit-stl',        name: 'r/stlouisblues',         color: '#003087', url: 'https://www.reddit.com/r/stlouisblues/new.json',         type: 'reddit' },
  ],
  TBL: [
    { id: 'reddit-tbl',        name: 'r/TampaBayLightning',    color: '#002868', url: 'https://www.reddit.com/r/TampaBayLightning/new.json',    type: 'reddit' },
  ],
  TOR: [
    { id: 'reddit-tor',        name: 'r/leafs',                color: '#003e7e', url: 'https://www.reddit.com/r/leafs/new.json',                type: 'reddit' },
  ],
  UTA: [
    { id: 'reddit-uta',        name: 'r/UtahMammoth',          color: '#69b3e7', url: 'https://www.reddit.com/r/UtahMammoth/new.json',          type: 'reddit' },
  ],
  VAN: [
    { id: 'reddit-van',        name: 'r/canucks',              color: '#00843d', url: 'https://www.reddit.com/r/canucks/new.json',              type: 'reddit' },
  ],
  VGK: [
    { id: 'reddit-vgk',        name: 'r/goldenknights',        color: '#b4975a', url: 'https://www.reddit.com/r/goldenknights/new.json',        type: 'reddit' },
  ],
  WSH: [
    { id: 'reddit-wsh',        name: 'r/caps',                 color: '#041e42', url: 'https://www.reddit.com/r/caps/new.json',                 type: 'reddit' },
  ],
  WPG: [
    { id: 'reddit-wpg',        name: 'r/winnipegjets',         color: '#041e42', url: 'https://www.reddit.com/r/winnipegjets/new.json',         type: 'reddit' },
  ],
};

// Build a regex filter string for a team used to filter league-wide feeds
// (Athletic, Bleacher Report) down to relevant articles.
// Uses the explicit keywords array from TEAM_CONFIGS — nicknames, city,
// and key player names — so articles like "Canes edge Capitals" or
// "Bedard scores twice" match rather than just the full display name.
function teamFilterKeywords(teamAbbr) {
  const cfg = TEAM_CONFIGS[teamAbbr];
  if (!cfg) return teamAbbr.toLowerCase();
  return (cfg.keywords || cfg.displayName.toLowerCase().split(' ').filter(w => w.length > 3)).join('|');
}

// Build the active news source list for a given team abbr.
// Clones Athletic and BR entries with a team-specific filter injected —
// the shared NHL_NEWS_SOURCES constants are never mutated.
function getNewsSources(teamAbbr) {
  const keywords = teamFilterKeywords(teamAbbr);
  const leagueSources = NHL_NEWS_SOURCES.map(src =>
    src.filterKey === 'team' ? { ...src, filter: keywords } : src
  );
  return [
    ...(TEAM_NEWS_SOURCES[teamAbbr] || []),
    ...leagueSources,
  ];
}

// Parse standard RSS <item> feeds
// ── News fetching ───────────────────────────────────────────

async function fetchNews(env, teamAbbr = TEAM_ABBR) {
  const allItems = [];
  const sources  = getNewsSources(teamAbbr);

  for (const source of sources) {
    // Reddit and SBNation atom feeds are fetched by GitHub Actions
    // (CF Workers IPs are blocked). GH Actions POSTs to /reddit/ingest
    // and /atom/ingest every 30 minutes.
    if (source.type === 'reddit' || source.type === 'atom') continue;
    try {
      console.log(`News: fetching ${source.id} from ${source.url}`);
      const res = await fetch(source.url, {
        headers: {
          'User-Agent': 'EyeWall-Analytics/1.0',
          'Accept': source.type === 'nhl'
            ? 'application/json'
            : 'application/rss+xml,text/xml,*/*',
        },
        cf: { cacheTtl: 0 },
      });
      console.log(`News: ${source.id} status=${res.status} type=${res.headers.get('content-type')}`);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`News: ${source.id} failed ${res.status}: ${body.slice(0,100)}`);
        continue;
      }
      let parsed = [];
      if (source.type === 'nhl') {
        const data = await res.json();
        parsed = parseNHLNews(data);
      } else if (source.type === 'atom') {
        const xml = await res.text();
        console.log(`News: ${source.id} atom length=${xml.length}`);
        parsed = parseAtom(xml, source);
      } else if (source.type === 'reddit') {
        const data = await res.json();
        console.log(`News: ${source.id} posts=${data?.data?.children?.length}`);
        parsed = parseReddit(data, source);
      } else if (source.type === 'sportsnet') {
        const xml = await res.text();
        parsed = parseSportsnet(xml, source);
      } else if (source.type === 'gnews') {
        const xml = await res.text();
        console.log(`News: ${source.id} gnews length=${xml.length}`);
        parsed = parseGoogleNews(xml, source);
      } else if (source.type === 'espn') {
        const xml = await res.text();
        parsed = parseESPN(xml, source);
      } else {
        const xml = await res.text();
        parsed = parseRSS(xml, source);
      }
      allItems.push(...parsed);
      console.log(`News: ${source.id} → ${parsed.length} items`);
    } catch (err) {
      console.warn(`News: ${source.id} error: ${err.message} ${err.stack?.slice(0,100)}`);
    }
  }

  // Deduplicate by ID and title prefix, sort newest first
  const seenIds    = new Set();
  const seenTitles = new Set();
  const deduped = allItems.filter(item => {
    if (seenIds.has(item.id)) return false;
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (seenTitles.has(key)) return false;
    seenIds.add(item.id);
    seenTitles.add(key);
    return true;
  }).sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  await kvPut(env, `news:${teamAbbr}`, deduped, 1800); // 30min TTL
  console.log(`News: cached ${deduped.length} items for ${teamAbbr}`);
  return deduped;
}

// ── Odds Persistence Writer (2026-07) ──────────────────────────
// See ODDS_PERSISTENCE_WRITER_SCOPE.md for the full design. Replaces the
// old odds:nhl KV write (confirmed dead -- nothing ever read it back,
// grepped across all three repos before removing it here) with a
// Supabase-persisted table serving both live frontend display and future
// backtests. Reuses fetchOdds()'s existing 7-day-window season gate and
// 401/429 backoff unchanged -- both already did exactly what this needed.

// Full team display name (lowercased) -> abbr, built once from
// TEAM_CONFIGS -- needed because the Odds API identifies teams by name
// ("Carolina Hurricanes"), not abbreviation, and this has to resolve all
// 32 teams, not just this app's own default team.
const TEAM_NAME_TO_ABBR = Object.fromEntries(
  Object.values(TEAM_CONFIGS).map(t => [t.displayName.toLowerCase(), t.abbr])
);

function matchOddsToTeams(oddsEntry) {
  const home = TEAM_NAME_TO_ABBR[oddsEntry.home_team?.toLowerCase()];
  const away = TEAM_NAME_TO_ABBR[oddsEntry.away_team?.toLowerCase()];
  return (home && away) ? { home, away } : null;
}

// Same bookmaker-preference order as the frontend's extractMoneyline()
// (nhlApi.js), generalized to any team pair instead of "car vs. opponent".
function extractMoneylineForGame(oddsEntry, homeAbbr, awayAbbr) {
  if (!oddsEntry?.bookmakers?.length) return null;
  const preferred = ['draftkings', 'fanduel', 'betmgm', 'williamhill'];
  const book = oddsEntry.bookmakers.find(b => preferred.includes(b.key)) || oddsEntry.bookmakers[0];
  const market = book.markets?.find(m => m.key === 'h2h');
  if (!market?.outcomes?.length) return null;

  const homeName = TEAM_CONFIGS[homeAbbr]?.displayName?.toLowerCase();
  const awayName = TEAM_CONFIGS[awayAbbr]?.displayName?.toLowerCase();
  const homeOut = market.outcomes.find(o => o.name?.toLowerCase() === homeName);
  const awayOut = market.outcomes.find(o => o.name?.toLowerCase() === awayName);
  if (!homeOut || !awayOut) return null;

  return { moneylineHome: homeOut.price, moneylineAway: awayOut.price, book: book.title || book.key };
}

// home_abbr/away_abbr/commence_time, not game_id -- resolving a definitive
// game_id here would need a genuinely multi-day, all-32-teams schedule
// fetch (the /score/now scoreboard this reuses for the pregame-proximity
// check below is today-only). Deferred to read time instead (join against
// game_log by date + team abbrevs) -- simpler, no new multi-day fetch
// added to the write path. See docs/nhl_odds_table.sql.
async function persistOddsToSupabase(oddsData, season) {
  const rows = [];
  for (const entry of oddsData) {
    const teams = matchOddsToTeams(entry);
    if (!teams) continue;
    const ml = extractMoneylineForGame(entry, teams.home, teams.away);
    if (!ml) continue;
    rows.push({
      season,
      home_abbr: teams.home,
      away_abbr: teams.away,
      commence_time: entry.commence_time,
      moneyline_home: ml.moneylineHome,
      moneyline_away: ml.moneylineAway,
      book: ml.book,
      fetched_at: new Date().toISOString(),
    });
  }
  if (!rows.length) return 0;
  await sbUpsert('nhl_odds', rows, 'season,home_abbr,away_abbr,commence_time');
  return rows.length;
}

// todaysGames: the league-wide /score/now scoreboard poll() already
// fetches every cycle (see below) -- reused here for the pregame-proximity
// check rather than re-fetching, and deliberately NOT the single-team
// `schedule` used for the 7-day gate below, since this needs to catch
// ANY team's game being close, not just this app's default team.
async function fetchOdds(env, todaysGames) {
  if (!env.ODDS_API_KEY) return; // silently skip if key not configured

  // Skip entirely when there are no upcoming games within 7 days.
  // Avoids burning API quota during offseason and prevents 401 spam
  // when the key is over cap — no games means odds aren't needed anyway.
  const season   = await resolveNHLSeason(env);
  const schedule = await kvGet(env, scheduleKey(TEAM_ABBR, season)) || [];
  const now      = Date.now();
  const week     = 7 * 24 * 60 * 60 * 1000;
  const hasUpcoming = schedule.some(g => {
    const t = new Date(g.startTimeUTC || g.gameDate).getTime();
    return t > now && t < now + week;
  });
  if (!hasUpcoming) {
    console.log('Odds: no upcoming games within 7 days — skipping');
    return;
  }

  // Backoff: if we got a 401 recently, skip silently for 6 hours to avoid log spam.
  // Resets automatically when the KV key expires.
  const backoff = await kvGet(env, 'odds:backoff');
  if (backoff) return; // silently skip during backoff window

  // Throttle: a safety-net fetch at least once every ~12h, plus an extra
  // fetch when any NHL game is starting within the next ~3h -- fresher
  // lines close to puck-drop, when they're most informative. A blind
  // "widen the TTL to 12h" would only give ~2 fetches/day at arbitrary,
  // wall-clock-drifting times with no guarantee either one lands near an
  // actual game -- this checks real game start times for the second one
  // instead of just counting hours since the last fetch.
  const SAFETY_NET_HOURS = 12;
  const PREGAME_WINDOW_HOURS = 3;
  const lastFetchedAt = await kvGet(env, 'odds:lastFetchedAt');
  const hoursSinceLastFetch = lastFetchedAt ? (now - lastFetchedAt) / 3_600_000 : Infinity;
  const pregameWindowMs = PREGAME_WINDOW_HOURS * 3_600_000;
  const hasGameSoon = (todaysGames || []).some(g => {
    const t = new Date(g.startTimeUTC || g.gameDate).getTime();
    return t > now && t < now + pregameWindowMs;
  });
  const dueForSafetyNet   = hoursSinceLastFetch >= SAFETY_NET_HOURS;
  const dueForPregameFetch = hasGameSoon && hoursSinceLastFetch >= PREGAME_WINDOW_HOURS;
  if (!dueForSafetyNet && !dueForPregameFetch) return; // still fresh enough

  try {
    const url = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds/` +
      `?apiKey=${env.ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401 || res.status === 429) {
        // Over quota or unauthorized — back off for 6 hours
        await kvPut(env, 'odds:backoff', 1, 6 * 3600);
        console.warn(`Odds API ${res.status} — backing off for 6h`);
      } else {
        console.warn(`Odds API ${res.status} — skipping`);
      }
      return;
    }
    const data = await res.json();
    await kvPut(env, 'odds:lastFetchedAt', now, SAFETY_NET_HOURS * 3600);
    const persisted = await persistOddsToSupabase(data, season);
    console.log(`Odds: persisted ${persisted} of ${data.length} games (${dueForPregameFetch ? 'pregame-proximity' : 'safety-net'} fetch)`);
  } catch (err) {
    console.warn('Odds fetch error:', err.message);
  }
}

// ── Main poll ─────────────────────────────────────────────────


// ── Main poll (scheduled every 60s) ────────────────────────

// Derives a July 1 cutoff from the resolved season's END year (e.g.
// '20252026' → July 1, 2026), replacing what used to be an identical
// hardcoded Date literal copy-pasted into all 32 TEAM_CONFIGS entries.
// July 1 is a deliberately generous buffer past the latest realistic
// Cup Final date — this only needs to be "safely after the season can
// possibly still be running," not exact to the day.
function seasonEndFor(seasonId) {
  const endYear = parseInt(String(seasonId).slice(4), 10) || (new Date().getFullYear() + 1);
  return new Date(`${endYear}-07-01`);
}

export async function poll(env, _ctx) {
  const season = await resolveNHLSeason(env);
  if (new Date().getTime() > seasonEndFor(season).getTime()) { console.log('Season over'); return; }

  // 1. Schedule — still just this app's own default team specifically.
  // Pre-warms its cache; every other team's schedule is fetched on-demand
  // by its own /schedule request already (getTeamConfig() resolves a real
  // per-request team), so this doesn't need to become a 32-team loop.
  const scheduleData = await nhlGet(`${NHL_BASE}/club-schedule-season/${TEAM_ABBR}/${season}`);
  const games = scheduleData?.games || [];
  await kvPut(env, scheduleKey(TEAM_ABBR, season), games, CURRENT_SCHEDULE_TTL);

  // 2. League-wide scoreboard — one call covers every team's game today,
  // live or finished, the same way pollPWHLGame() (pwhl.js) gets all of
  // today's PWHL games from one query. Replaces the old per-CAR-schedule
  // live check, which could only ever detect CAR's own live/just-ended
  // game — this app's push notifications now work for any of the 32 teams
  // a user might actually be subscribed to, not just CAR.
  const scoreboard     = await nhlGet(`${NHL_BASE}/score/now`);
  const todaysGames    = scoreboard?.games || [];
  const liveGames      = todaysGames.filter(g => g.gameState === 'LIVE' || g.gameState === 'CRIT');
  const completedToday = todaysGames.filter(isCompleted);

  await kvPut(env, 'live:gameIds', liveGames.map(g => g.id), 60);
  // Back-compat for /health, which has always reported this app's own live
  // game specifically, not the full league-wide set computed above.
  const ownLiveGame = liveGames.find(g => g.homeTeam?.abbrev === TEAM_ABBR || g.awayTeam?.abbrev === TEAM_ABBR);
  await kvPut(env, 'live:gameId', ownLiveGame?.id || null, 60);

  // 3. Live PBP + boxscore + push notifications, once per live game
  for (const liveGame of liveGames) {
    const liveId = liveGame.id;
    const [pbpRes, bsRes] = await Promise.allSettled([
      nhlGet(`${NHL_BASE}/gamecenter/${liveId}/play-by-play`),
      nhlGet(`${NHL_BASE}/gamecenter/${liveId}/boxscore`),
    ]);
    if (pbpRes.status === 'fulfilled') {
      const pbpData = pbpRes.value;
      await kvPut(env, `pbp:${liveId}`, pbpData, 60);
      // Detect goals + events and send push notifications
      if (env.VAPID_PRIVATE_KEY) {
        await detectAndNotify(env, liveGame, pbpData).catch(e =>
          console.error(`Push notification error (game ${liveId}):`, e.message)
        );
      }
    }
    if (bsRes.status === 'fulfilled') {
      await kvPut(env, `boxscore:${liveId}`, bsRes.value, 60);
    }
  }

  // Game-over notifications — every game that finished today, any team.
  // notifyGameOver() already dedups per game_id via push:gameover:${id},
  // so calling it again for an already-notified game on every later cycle
  // is a cheap no-op, not a re-send.
  if (env.VAPID_PRIVATE_KEY) {
    for (const game of completedToday) {
      await notifyGameOver(env, game).catch(e =>
        console.error(`Game over notification error (game ${game.id}):`, e.message)
      );
    }
  }

  // Cache this app's own most recent completed game's PBP — unchanged
  // from before this refactor, and deliberately not tied to the
  // league-wide game-over loop above; still just CAR's own schedule.
  const justEnded = [...games]
    .filter(g => isCompleted(g))
    .sort((a, b) => new Date(b.gameDate).getTime() - new Date(a.gameDate).getTime())[0];
  if (justEnded) {
    const existing = await kvGet(env, `pbp:${justEnded.id}`);
    if (!existing) {
      const [p, b] = await Promise.allSettled([
        nhlGet(`${NHL_BASE}/gamecenter/${justEnded.id}/play-by-play`),
        nhlGet(`${NHL_BASE}/gamecenter/${justEnded.id}/boxscore`),
      ]);
      if (p.status === 'fulfilled') await kvPut(env, `pbp:${justEnded.id}`, p.value, 3600);
      if (b.status === 'fulfilled') await kvPut(env, `boxscore:${justEnded.id}`, b.value, 3600);
    }
  }

  // 4. Standings
  const standings = await nhlGet(`${NHL_BASE}/standings/now`);
  await kvPut(env, 'standings', standings?.standings || [], 300);

  // 5. Team stats
  const exp = `gameTypeId=2 and seasonId=${season} and teamId=${TEAM_ID}`;
  const teamSummary = await nhlGet(
    `${STATS_BASE}/team/summary?isAggregate=false&isGame=false&sort=wins&limit=1&cayenneExp=${encodeURIComponent(exp)}`
  ).catch(() => null);
  if (teamSummary) await kvPut(env, `teamstats:${TEAM_ABBR}`, teamSummary?.data?.[0] || null, 600);

  // 6. Odds — throttled safety-net (~12h) + pregame-proximity (~3h) fetch,
  // persisted to Supabase (nhl_odds); see fetchOdds()'s own comments.
  await fetchOdds(env, todaysGames).catch(e => console.warn('Odds fetch failed:', e.message));

  // 7. News (every 30min — TTL handles rate limiting)
  const newsAge = await env.CACHE.getWithMetadata(`news:${TEAM_ABBR}`);
  if (!newsAge.value) await fetchNews(env).catch(e => console.warn('News fetch failed:', e.message));

  // MoneyPuck analytics are populated via POST /moneypuck/ingest from GitHub Actions.
  // Cloudflare Workers IPs are blocked by MoneyPuck; GH-hosted runners are not.
  // The cron no longer attempts to fetch — it would always 403.
  {
    const staleTeams = (
      await Promise.all(
        Object.keys(TEAM_CONFIGS).map(async abbr => {
          const val = await env.CACHE.get(`moneypuck:skaters:${abbr}`);
          return val ? null : abbr;
        })
      )
    ).filter(Boolean);
    if (staleTeams.length > 0) {
      console.log(`MoneyPuck: ${staleTeams.length} teams awaiting next GH Actions ingest: ${staleTeams.slice(0, 5).join(', ')}${staleTeams.length > 5 ? '...' : ''}`);
    }
  }

  console.log(`Poll done. Live: ${liveGames.length}. Completed today: ${completedToday.length}.`);
}

// ── PP/PK unit refresh ──────────────────────────────────────

export async function refreshPPUnits(env) {
  const season = await resolveNHLSeason(env);
  const r = await fetch(
    `${SB_URL}/rest/v1/special_teams_units` +
    `?season=eq.${season}&select=team,unit_type,unit_number,player_ids&limit=256`,
    {
      headers: {
        'apikey':        SB_ANON,
        'Authorization': `Bearer ${SB_ANON}`,
      },
    }
  );
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  const rows = await r.json();

  // Build nested map: { CAR: { PP: { 1: [...], 2: [...] }, PK: { ... } } }
  const map = {};
  for (const row of rows) {
    if (!map[row.team]) map[row.team] = { PP: {}, PK: {} };
    map[row.team][row.unit_type][row.unit_number] = row.player_ids;
  }

  await kvPut(env, 'pp_units:all', map, 4 * 60 * 60); // 4 hour TTL
  return map;
}


export async function handleNHL(request, env, ctx, url) {

  // Manual news refresh (protected)
  if (url.pathname === '/news/refresh') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const tc    = await getTeamConfig(request, env);
    const items = await fetchNews(env, tc.abbr);
    return json({ ok: true, count: items.length, team: tc.abbr });
  }

  // GET /news — serve news for any team, fetching on-demand if cache is cold.
  // This is how non-default teams get their news populated: the first visitor
  // triggers a background fetch which populates the 30min KV cache for all
  // subsequent requests. Without this, only the cron-polled default team (CAR)
  // would ever have a warm news cache.
  if (url.pathname === '/news' && request.method === 'GET') {
    const tc      = await getTeamConfig(request, env);
    const cached  = await kvGet(env, `news:${tc.abbr}`);
    if (cached) return json(cached);
    // Cache is cold — fetch in the background and return empty for now so the
    // client doesn't hang. Next request (after ~5s) will get real data.
    ctx.waitUntil(fetchNews(env, tc.abbr).catch(e => console.warn(`News bg fetch ${tc.abbr}:`, e.message)));
    return json([]);
  }

  // On-demand schedule for any team.
  //
  // ?season= (optional) selects a specific season, e.g. "20232024" — same
  // 8-digit shape the upstream NHL API takes. Defaults to the live-resolved
  // current season when omitted, preserving existing callers' behavior.
  // Historical (non-current) seasons get a long TTL since a finished
  // season's schedule never changes; current season keeps the short TTL.
  //
  // Current season: mirrors the /news pattern (warm: serve from KV; cold:
  // fetch in background, return [] immediately, next request ~2s later
  // gets real data) — appropriate here since the current season is
  // requested constantly and cron already keeps CAR's copy warm.
  //
  // Historical season: fetched and cached SYNCHRONOUSLY on a cold miss
  // instead — same shape as PWHL's /pwhl/schedule route (`pwhl.js`). A
  // past season is a single one-off upstream call that then sits on a
  // 60-day TTL; the fire-and-forget "empty now, retry later" pattern has
  // no natural retry trigger once a user has already picked that season
  // chip and is looking at an empty game row, so it isn't the right shape
  // here the way it is for a page the user reloads/polls anyway.
  if (url.pathname === '/schedule' && request.method === 'GET') {
    const tc     = await getTeamConfig(request, env);
    const season = url.searchParams.get('season') || String(tc.season);
    const isCurrent = season === String(tc.season);
    const cached = await kvGet(env, scheduleKey(tc.abbr, season));
    if (cached) return json(cached);

    if (!isCurrent) {
      try {
        const data  = await nhlGet(`${NHL_BASE}/club-schedule-season/${tc.abbr}/${season}`);
        const games = data?.games || [];
        await kvPut(env, scheduleKey(tc.abbr, season), games, HISTORICAL_SCHEDULE_TTL);
        return json(games);
      } catch (e) {
        console.warn(`Schedule fetch (historical) ${tc.abbr} season ${season}: ${e.message}`);
        return json([]);
      }
    }

    ctx.waitUntil((async () => {
      try {
        const data  = await nhlGet(`${NHL_BASE}/club-schedule-season/${tc.abbr}/${season}`);
        const games = data?.games || [];
        await kvPut(env, scheduleKey(tc.abbr, season), games, CURRENT_SCHEDULE_TTL);
        console.log(`Schedule bg fetch: ${tc.abbr} season ${season} (${games.length} games)`);
      } catch (e) {
        console.warn(`Schedule bg fetch ${tc.abbr} season ${season}: ${e.message}`);
      }
    })());
    return json([]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Direct-Supabase-read proxies (Session 44) — replace
  // eyewall-analytics/src/utils/supabaseClient.js's direct-to-Supabase
  // fetches (embedded anon key, no caching, bypassed this Worker entirely
  // — cross-repo audit finding). Same tables/filters/columns as before,
  // just server-side now with KV caching. These return raw Supabase rows;
  // the frontend keeps its existing row-shaping/transform logic and just
  // fetches from here instead of Supabase directly.
  // ══════════════════════════════════════════════════════════════════════

  // GET /nhl/odds — moneyline odds from the persisted nhl_odds table
  // (Odds Persistence Writer), replacing the frontend's old direct-to-
  // Odds-API call. Already flattened/matched by team abbr server-side
  // (see fetchOdds()/persistOddsToSupabase() above) — no team-name fuzzy
  // matching needed client-side anymore. Brief edge cache since the
  // underlying data only changes on fetchOdds()'s own ~12h/~3h cadence.
  if (url.pathname === '/nhl/odds') {
    const season = await resolveNHLSeason(env);
    const kvKey  = `nhl:odds:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    try {
      const rows = await sbRows(
        `nhl_odds?season=eq.${season}&commence_time=gte.${new Date().toISOString()}` +
        `&select=home_abbr,away_abbr,commence_time,moneyline_home,moneyline_away,book` +
        `&order=commence_time.asc`
      );
      await kvPut(env, kvKey, rows, 300); // 5min — matches the old odds:nhl KV TTL this replaces
      return json(rows);
    } catch (e) {
      console.error('nhl_odds fetch failed:', e);
      return json([]);
    }
  }

  if (url.pathname === '/player-analytics') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const kvKey  = `nhl:player-analytics:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const ANA_COLS = 'player_id,team,war,ev_off_pct,ev_def_inv,pp_xgf60,pk_xga60_inv,pp_icetime,pk_icetime,' +
      'finishing,goals_per60,a1_per60,xgf_per60,penalties_per60,competition,teammates,game_score,' +
      'pct_ev_off,pct_ev_def,pct_pp,pct_pk,pct_finishing,pct_goals,pct_a1,' +
      'pct_penalties,pct_competition,pct_teammates,games_played,' +
      'xga_per60,hdca_per60,hits,blocked_shots,takeaways,giveaways,' +
      // Session 56 -- both null below eyewall-pipeline's moneypuck.py
      // RESULTS_VS_PROCESS_MIN_GP (25 GP) guardrail; the frontend should
      // treat "null" as "not enough games yet," not re-derive a GP number.
      'on_ice_gf_pct,results_vs_process_diff,' +
      // PLAYER_CARD_PERCENTILE_DISPLAY_BRIEF -- 11 new PR #56 league-wide
      // percentile categories (raw box-score stats, ranked directly rather
      // than a per-60 rate) plus conference/division-scoped variants for
      // all 16 tile-facing categories: pp/goals/a1/penalties/finishing
      // (already selected above, tile-mapped via STAT_PCT_MAP) plus these
      // 11 new ones. pct_ev_off/pct_ev_def/pct_pk/pct_competition/
      // pct_teammates are radar-only (no backing tile) -- deliberately no
      // conf/div added for those, nothing would consume it.
      'pct_games_played,pct_plus_minus,pct_sh_goals,pct_gw_goals,pct_shots,' +
      'pct_toi_per_game,pct_faceoff_win_pct,pct_hits,pct_blocked_shots,' +
      'pct_takeaways,pct_giveaways,' +
      'pct_goals_conf,pct_goals_div,pct_a1_conf,pct_a1_div,' +
      'pct_pp_conf,pct_pp_div,pct_penalties_conf,pct_penalties_div,' +
      'pct_finishing_conf,pct_finishing_div,' +
      'pct_games_played_conf,pct_games_played_div,' +
      'pct_plus_minus_conf,pct_plus_minus_div,' +
      'pct_sh_goals_conf,pct_sh_goals_div,' +
      'pct_gw_goals_conf,pct_gw_goals_div,' +
      'pct_shots_conf,pct_shots_div,' +
      'pct_toi_per_game_conf,pct_toi_per_game_div,' +
      'pct_faceoff_win_pct_conf,pct_faceoff_win_pct_div,' +
      'pct_hits_conf,pct_hits_div,' +
      'pct_blocked_shots_conf,pct_blocked_shots_div,' +
      'pct_takeaways_conf,pct_takeaways_div,' +
      'pct_giveaways_conf,pct_giveaways_div';
    const DEF_COLS = 'player_id,hits,blocked_shots,takeaways,giveaways';

    async function fetchAnalytics(forSeason) {
      const [rows, poRows] = await Promise.all([
        sbRows(`player_seasons?season=eq.${forSeason}&game_type=eq.2&war=not.is.null&select=${ANA_COLS}&limit=2000`),
        sbRows(`player_seasons?season=eq.${forSeason}&game_type=eq.3&select=${DEF_COLS}&limit=2000`).catch(() => []),
      ]);
      return { rows, poRows };
    }

    let rows, poRows;
    try {
      ({ rows, poRows } = await fetchAnalytics(season));
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    // Whole-season-empty fallback (Session 66, same shape as
    // /players-search-index's team lookup): the live season can be flipped
    // ahead of any real games (schedule released before puck drop), leaving
    // `war=not.is.null` match nothing at all for it -- not a per-player gap,
    // the pct_* percentiles this route serves are already computed
    // position-grouped (fwd/def pools, moneypuck.py) for whichever season's
    // rows they came from, so falling back to a whole prior season's rows
    // preserves that grouping automatically; no per-request regrouping
    // needed here. Flagged via statsStale/statsSeason (mirrors teamStale/
    // teamSeason), not silent -- the frontend should label it "as of last
    // season," not present a rookie's now-stale sophomore-year percentiles
    // as current. A player with no prior-season row either (true rookie)
    // still surfaces as absent from `rows`, same explicit-nothing shape as
    // today, not a fabricated stale entry.
    let statsStale = false;
    let statsSeason = null;
    if (rows.length === 0) {
      const priorSeason = String(Number(season) - 10001); // 20262027 -> 20252026
      try {
        const fallback = await fetchAnalytics(priorSeason);
        if (fallback.rows.length > 0) {
          rows = fallback.rows;
          poRows = fallback.poRows;
          statsStale = true;
          statsSeason = priorSeason;
        }
      } catch {
        // Fallback query itself failed -- degrade to the empty live-season
        // result rather than failing the whole request over it.
      }
    }

    const result = { rows, poRows, statsStale, statsSeason };
    await kvPut(env, kvKey, result, 3600);
    return json(result);
  }

  if (url.pathname === '/player-shots') {
    const playerId = url.searchParams.get('playerId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const team     = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    if (!playerId) return new Response(JSON.stringify({ error: 'playerId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:player-shots:${playerId}:${season}:${team}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    // No car_game filter: that column only means "Carolina played in this
    // game" (see eyewall-pipeline's shot_events.py), so filtering on it here
    // silently restricted every non-CAR player's shots to games against
    // Carolina. player_id + team already scope correctly on their own — a
    // player only shoots for one team per row.
    let rows;
    try {
      rows = await sbRows(
        `shot_events?player_id=eq.${playerId}&season=eq.${season}` +
        `&team=eq.${team}` +
        `&select=x,y,event_type,period,time_in_period,shot_type&limit=2000`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // GET /nhl/shots?team=CAR&season=20252026
  // Season-wide shots for the shot map's "All N" chip -- both teams' shots
  // from every game `team` played, matching what extractShotEvents(pbp)
  // already returns for a single game (not just `team`'s own shots).
  //
  // shot_events.car_game only ever means "Carolina played in this game"
  // (see eyewall-pipeline's shot_events.py) -- it can't be used to scope to
  // an arbitrary requested team the way special_teams.py's car_game bug
  // taught us. So instead of trusting that column, this resolves `team`'s
  // own completed game_ids directly from the NHL schedule API first, then
  // filters shot_events by that game_id list -- same fix shape as
  // special_teams.py's fetch_game_ids_for_team(), just sourced from the
  // live NHL API here instead of Supabase's game_log (the Worker doesn't
  // otherwise read game_log).
  if (url.pathname === '/nhl/shots') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const kvKey  = `nhl:shots:${team}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let gameIds;
    try {
      const schedule = await nhlGet(`${NHL_BASE}/club-schedule-season/${team}/${season}`);
      gameIds = (schedule?.games || []).filter(isCompleted).map(g => g.id);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }
    if (!gameIds.length) {
      await kvPut(env, kvKey, [], 3600);
      return json([]);
    }

    const PAGE = 1000;
    const allRows = [];
    let offset = 0;
    while (true) {
      const r = await fetch(
        `${SB_URL}/rest/v1/shot_events?game_id=in.(${gameIds.join(',')})&season=eq.${season}` +
        `&select=game_id,team,x,y,event_type,period,time_in_period,shot_type&order=game_id.asc`,
        {
          headers: {
            'apikey':        SB_ANON,
            'Authorization': `Bearer ${SB_ANON}`,
            'Range':         `${offset}-${offset + PAGE - 1}`,
            'Range-Unit':    'items',
            'Prefer':        'count=none',
          },
        }
      );
      if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
      const rows = await r.json();
      allRows.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    await kvPut(env, kvKey, allRows, 3600);
    console.log(`NHL shots: team=${team} season=${season} games=${gameIds.length} total=${allRows.length}`);
    return json(allRows);
  }

  if (url.pathname === '/goalie-shots') {
    const goalieId = url.searchParams.get('goalieId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    if (!goalieId) return new Response(JSON.stringify({ error: 'goalieId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:goalie-shots:${goalieId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `shot_events?goalie_id=eq.${goalieId}&season=eq.${season}` +
        `&select=x,y,event_type,period,time_in_period,shot_type,team&limit=2000`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/goalie-analytics') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const kvKey  = `nhl:goalie-analytics:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `goalie_seasons?season=eq.${season}&game_type=eq.2` +
        `&gsax=not.is.null` +
        `&select=player_id,team,games_played,gsax,gsax_per60,qs_pct,qs,` +
        `ev_sv_pct,hd_sv_pct,md_sv_pct,pk_sv_pct,` +
        `pct_gsax,pct_gsax60,pct_ev_sv,pct_hd_sv,pct_md_sv,pct_pk_sv`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/team-lines') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const kvKey  = `nhl:team-lines:${team}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `line_combinations?team=eq.${team}&season=eq.${season}` +
        `&order=unit_type.asc,rank.asc` +
        `&select=unit_type,rank,name_a,name_b,name_c,pos_a,pos_b,pos_c,toi_secs,xgf_pct`
      );
    } catch {
      rows = []; // matches supabaseClient.js's own .catch(() => []) — frontend falls back to static lines
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/game-xg') {
    const gameId = url.searchParams.get('gameId');
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:game-xg:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(`game_xg?game_id=eq.${gameId}&situation=eq.5on5&select=team,xgf,xga,xgf_pct`);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 1800);
    return json(rows);
  }

  // Serves both getGameLogInsights and getTeamGameLog on the frontend —
  // same table+filter (team+season), union of both callers' select columns.
  if (url.pathname === '/game-log') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const limit  = url.searchParams.get('limit'); // optional passthrough — omitted means unlimited
    const kvKey  = `nhl:game-log:${team}:${season}:${limit || 'all'}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `game_log?season=eq.${season}&team=eq.${team}&order=game_id.asc` +
        `&select=game_id,game_date,opponent,team_score,opp_score,home_team,` +
        `team_scored_first,pp_goals,pp_opps,pk_goals_against,pk_opps,game_type` +
        (limit ? `&limit=${limit}` : '')
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/xg-trend') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const kvKey  = `nhl:xg-trend:${team}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `game_xg?team=eq.${team}&season=eq.${season}&situation=eq.5on5` +
        `&select=game_id,xgf_pct&limit=999`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/team-seasons') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const kvKey  = `nhl:team-seasons:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    // magic_number/tragic_number/clinched/eliminated are playoff_race.py's
    // nightly forecast (Session 57). Deliberately not selecting
    // team_seasons.clinch_indicator here — the frontend already gets the
    // live, real-time clinchIndicator per team from /cache/standings (see
    // getStandings() in nhlApi.js), which is the NHL's own ground truth and
    // updates far more often than this nightly-batched table. Mixing a
    // second, staler clinch_indicator into this route's response would just
    // invite the two to disagree. Per playoff_race.py's docstring, once the
    // live indicator is populated for a team it wins outright; these
    // computed numbers are a pre-clinch/pre-elimination estimate only, and
    // that precedence is a frontend-merge concern, not this route's.
    // hits/penalties (Session 82) -- season totals from nhl_stats.py's
    // game_log rollup (PR #56), for the Shot Map "All N" cards. Selected
    // team's own season total only, no opponent aggregate -- matches how
    // ShotMapView.jsx's FO%/PP%/PK% cards already drop the opponent
    // comparison in All-N mode (see that PR/eyewallanalytics#64). An
    // opponent-side total would need a game_id join against every team this
    // one played, same as /pwhl/team-season-summary does -- deliberately
    // out of scope here.
    let rows;
    try {
      rows = await sbRows(
        `team_seasons?season=eq.${season}&game_type=eq.2` +
        `&select=team,xgf_pct,roster_war_score,games_played,` +
        `magic_number,tragic_number,clinched,eliminated,hits,penalties&limit=32`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // Season-over-season team comparison (Session 64) -- box-score fields
  // only (wins/losses/points/goals-for-against/PP%/PK%), deliberately NOT
  // the advanced-metric columns /team-seasons above selects (xgf_pct,
  // roster_war_score) -- those are null across every NHL season right now,
  // not just older ones (confirmed via direct query, SESSION_63_FINDINGS.md),
  // so there's nothing real to compare yet. Distinct route rather than a
  // param on /team-seasons: that route is single-season, current-season-
  // shaped (falls back to resolveNHLSeason()); this one is explicitly
  // multi-season and requires both params -- no "current season" default,
  // since a comparison with no seasons specified isn't a comparison.
  // Missing seasons for the requested team (e.g. an expansion team with no
  // row for an old season) are simply absent from the response array --
  // the frontend already knows which seasons it asked for and renders the
  // gap as its own "not yet available" state rather than this route
  // guessing at placeholder zeros.
  if (url.pathname === '/team-seasons/compare') {
    const team    = url.searchParams.get('team');
    const seasons = (url.searchParams.get('seasons') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!team || seasons.length === 0) {
      return badRequest('team and seasons (comma-separated) are required');
    }

    const kvKey  = `nhl:team-seasons:compare:${team}:${seasons.slice().sort().join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `team_seasons?team=eq.${team}&season=in.(${seasons.join(',')})&game_type=eq.2` +
        `&select=season,games_played,wins,losses,ot_losses,points,goals_for,goals_against,pp_pct,pk_pct`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // Two-team, same-season comparison (Session 86, Team vs Team Mode 1) --
  // same box-score fields as /team-seasons/compare, keyed by team instead
  // of season. A missing team's row for the requested season (e.g. an
  // expansion team, or a season before a team existed) is simply absent
  // from the response array -- same "gap is the frontend's job to render"
  // convention as /team-seasons/compare above, not this route's job to
  // guess at.
  if (url.pathname === '/team-seasons/compare-teams') {
    const teams  = (url.searchParams.get('teams') || '').split(',').map(s => s.trim()).filter(Boolean);
    const season = url.searchParams.get('season');
    if (teams.length !== 2 || !season) {
      return badRequest('teams (exactly two, comma-separated) and season are required');
    }

    const kvKey  = `nhl:team-seasons:compare-teams:${teams.slice().sort().join(',')}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `team_seasons?team=in.(${teams.join(',')})&season=eq.${season}&game_type=eq.2` +
        `&select=team,season,games_played,wins,losses,ot_losses,points,goals_for,goals_against,pp_pct,pk_pct`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // All-time head-to-head between two teams, across every season on record
  // (Session 88, Team vs Team Mode 2). game_log is one row per team per
  // game with an `opponent` column already on it (see nhl_stats.py) --
  // filtering team=A&opponent=B directly returns every A-vs-B meeting from
  // A's own perspective, no need to also fetch B's mirrored rows. No
  // season/game_type filter, deliberately unlike /team-seasons/compare* --
  // "all meetings across all seasons" includes playoff meetings, and
  // there's no team_seasons-style uniqueness-key reason to exclude them
  // here the way Mode 1's box-score comparison did.
  //
  // Derived insights are computed here, not left to the frontend, so
  // there's exactly one definition of "recent window"/"current streak" --
  // recentWindow deliberately isn't a hardcoded "last 14"; it's
  // min(10, totalMeetings), reusing this app's existing L10 convention
  // (Trends tab) rather than inventing a new magic number, and it
  // naturally collapses to the full history for a pair with few meetings
  // (e.g. a 2026-27 expansion matchup) instead of claiming a "last 10"
  // sample that doesn't exist.
  if (url.pathname === '/team-seasons/head-to-head') {
    const teams = (url.searchParams.get('teams') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (teams.length !== 2) {
      return badRequest('teams (exactly two, comma-separated) are required');
    }
    const [teamA, teamB] = teams;

    const kvKey  = `nhl:team-seasons:head-to-head:${teams.slice().sort().join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let games;
    try {
      games = await sbRows(
        `game_log?team=eq.${teamA}&opponent=eq.${teamB}` +
        `&select=game_id,season,game_date,team_score,opp_score,home_team` +
        `&order=season.asc,game_id.asc`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    const payload = buildHeadToHeadPayload(teamA, teamB, games.map(g => ({
      gameId: g.game_id, season: g.season, gameDate: g.game_date,
      teamAWon: g.team_score > g.opp_score,
      teamAScore: g.team_score, teamBScore: g.opp_score, homeTeam: g.home_team ? teamA : teamB,
    })));

    await kvPut(env, kvKey, payload, 3600);
    return json(payload);
  }

  // AI narrative layer on top of the head-to-head stats above (Session 90
  // fast-follow to Session 88's templated record/window/streak). Client
  // posts the payload it already fetched from /team-seasons/head-to-head
  // plus display names -- this route doesn't refetch/recompute anything,
  // same pattern as /summary/narrative's client-supplied stats payload
  // below. Prompt is hand-rolled here rather than shared with pwhl.js's
  // version of this route -- there's no existing precedent for sharing AI
  // prompt text across the two leagues in this file (see /summary/narrative
  // vs pwhl.js's /pwhl/summary/narrative, which have stayed independent
  // despite being structurally close), and each league's narrative voice
  // has already diverged (this file has no "Sticks" persona; pwhl.js does).
  if (url.pathname === '/team-seasons/head-to-head/narrative' && request.method === 'POST') {
    const limited = await checkAiRateLimit(env, request, 'h2h-narrative');
    if (limited) return limited;

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders() });
    }
    const {
      teamA, teamB, teamADisplay, teamBDisplay,
      totalMeetings, allTimeRecord, recentWindow, currentStreak, isThinSample,
    } = body || {};
    if (!teamA || !teamB || !totalMeetings || !allTimeRecord || !recentWindow) {
      return json({ narrative: null });
    }

    const kvKey  = `nhl:h2h-narrative:${[teamA, teamB].slice().sort().join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const aDisplay = teamADisplay || teamA;
    const bDisplay = teamBDisplay || teamB;
    const streakLine = currentStreak
      ? `Current streak: ${currentStreak.holder === 'A' ? aDisplay : bDisplay} has won ${currentStreak.count} straight.`
      : 'No active streak.';
    // Thin-sample guardrail: buildHeadToHeadPayload already flags <=4
    // meetings as isThinSample -- the templated UI qualifies its language
    // for this case (see TeamComparisonPopup.jsx), so the AI narrative
    // needs the same discipline or it undoes that work with confident prose.
    const thinSampleNote = isThinSample
      ? `\nIMPORTANT: Only ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'} exist between these teams. Do not describe this as a "trend," "rivalry," or "dominance" -- that's too small a sample to support it. It's fine to note the limited history plainly.`
      : '';

    const prompt = `You are EyeWall, a neutral hockey analytics assistant. Write a punchy 2-3 sentence head-to-head summary for ${aDisplay} vs ${bDisplay}.

All-time record (since 2023-24): ${aDisplay} ${allTimeRecord.teamAWins}-${allTimeRecord.teamBWins} ${bDisplay}, across ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'}.
Last ${recentWindow.size}: ${aDisplay} ${recentWindow.teamAWins}-${recentWindow.teamBWins} ${bDisplay}.
${streakLine}
${thinSampleNote}
Only reference the two teams named above and the numbers given -- no player names, no invented stats or games. Plain text only, no markdown, no bullet points.`;

    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages:   [{ role: 'user', content: prompt }],
        max_tokens: 100,
      });
      const narrative = (aiResponse.response || '').trim();
      if (!narrative) return json({ narrative: null });

      const result = { narrative };
      await kvPut(env, kvKey, result, 24 * 3600);
      return json(result);
    } catch (e) {
      console.error('[NHL] head-to-head narrative AI error:', e);
      return new Response(JSON.stringify({ error: 'AI generation failed' }), { status: 502, headers: corsHeaders() });
    }
  }

  // Serves both getPowerRankingsNarrative (limit=1) and getPowerRankingsHistory
  // (limit=28) on the frontend — same table/filter/order, different limit.
  if (url.pathname === '/power-rankings') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '28', 10) || 28, 100);
    const kvKey  = `nhl:power-rankings:${team}:${season}:${limit}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `power_rankings_narratives?team=eq.${team}&season=eq.${season}` +
        `&order=generated_date.desc&limit=${limit}` +
        `&select=narrative,rank,prior_rank,generated_date`
      );
    } catch {
      rows = [];
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // Serves both getGameMatchup and getGamePrediction on the frontend —
  // same table/filter/row, different text field.
  if (url.pathname === '/game-predictions') {
    const gameId = url.searchParams.get('gameId');
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:game-predictions:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `game_predictions?game_id=eq.${gameId}` +
        `&select=matchup_text,prediction_text,generated_at&limit=1`
      );
    } catch {
      rows = [];
    }

    await kvPut(env, kvKey, rows, 1800);
    return json(rows);
  }

  if (url.pathname === '/game-summary') {
    const gameId = url.searchParams.get('gameId');
    const team   = url.searchParams.get('team')?.toUpperCase();
    if (!gameId || !team) return new Response(JSON.stringify({ error: 'gameId and team required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:game-summary:${gameId}:${team}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `game_summaries?game_id=eq.${gameId}&team=eq.${team}` +
        `&select=summary_text,card_text,generated_at&limit=1`
      );
    } catch {
      rows = [];
    }

    await kvPut(env, kvKey, rows, 1800);
    return json(rows);
  }

  if (url.pathname === '/player-scouting') {
    const playerId = url.searchParams.get('playerId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    if (!playerId) return new Response(JSON.stringify({ error: 'playerId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:player-scouting:${playerId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `player_scouting?player_id=eq.${playerId}&season=eq.${season}` +
        `&select=scouting_text,generated_at&limit=1`
      );
    } catch {
      rows = [];
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/player-results-vs-process') {
    // Session 56 -- mirrors /player-scouting's shape exactly (single-player,
    // single-season lookup) rather than joining into /player-analytics's
    // bulk 2000-row response: the frontend only ever needs one player's
    // blurb at a time (player popup), so a light second lookup fits with
    // less disruption than a bulk join nobody would otherwise use.
    const playerId = url.searchParams.get('playerId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    if (!playerId) return new Response(JSON.stringify({ error: 'playerId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `nhl:player-results-vs-process:${playerId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `player_narratives?player_id=eq.${playerId}&season=eq.${season}` +
        `&narrative_type=eq.results_vs_process` +
        `&select=narrative_text,generated_at&limit=1`
      );
    } catch {
      rows = [];
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  if (url.pathname === '/team-skaters') {
    const team     = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const gameType = url.searchParams.get('gameType') || '2';
    const kvKey    = `nhl:team-skaters:${team}:${season}:${gameType}`;
    const cached   = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let rows;
    try {
      rows = await sbRows(
        `player_seasons?team=eq.${team}&season=eq.${season}&game_type=eq.${gameType}` +
        `&select=player_id,games_played,goals,assists,primary_assists,secondary_assists,` +
        `points,plus_minus,pim,pp_goals,sh_goals,gw_goals,shots,shooting_pct,` +
        `toi_per_game&order=points.desc.nullslast`
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // Full players id/name/position list — paginated server-side the same
  // way supabaseClient.js's fetchAllPlayers() used to do it client-side
  // (Supabase caps responses at 1000 rows; the table has 1346+).
  // Long TTL: names/positions rarely change mid-season.
  if (url.pathname === '/players-list') {
    const kvKey  = 'nhl:players-list';
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const pageSize = 1000;
    const all = [];
    let offset = 0;
    while (true) {
      const r = await fetch(`${SB_URL}/rest/v1/players?select=id,name,position`, {
        headers: {
          'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}`,
          'Range-Unit': 'items', 'Range': `${offset}-${offset + pageSize - 1}`,
        },
      });
      if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    await kvPut(env, kvKey, all, 21600); // 6hr
    return json(all);
  }

  // PP/PK unit compositions — pp_units:all is already kept warm by
  // refreshPPUnits() on every scheduled() tick, so this is normally a
  // pure KV read. Falls back to an inline refresh only if that cache is
  // somehow cold (first deploy, KV namespace wiped, etc).
  if (url.pathname === '/special-teams') {
    let map = await kvGet(env, 'pp_units:all');
    if (!map) {
      try {
        map = await refreshPPUnits(env);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
      }
    }
    return json(map);
  }

  // Health
  if (url.pathname === '/health') {
    const liveId   = await kvGet(env, 'live:gameId');
    const liveIds  = await kvGet(env, 'live:gameIds');
    const subs     = (await kvGet(env, 'push:subs')) || [];
    return json({
      ok: true,
      liveGameId:  liveId,        // this app's own team's live game, if any (back-compat)
      liveGameIds: liveIds || [], // every live NHL game right now, any team
      subscribers: subs.length,
      timestamp:   new Date().toISOString(),
    });
  }

  // KV cache read — on a schedule miss, trigger background population
  // so the next request gets real data without a frontend change.
  if (url.pathname.startsWith('/cache/')) {
    const key = decodeURIComponent(url.pathname.slice('/cache/'.length));
    const val = await kvGet(env, key);
    if (val === null) {
      // Background-populate schedule for non-CAR teams (or historical
      // seasons) on cache miss. Key shape is now `schedule:{abbr}:{season}`
      // — fall back to the live-resolved current season if a caller hits
      // this with the older 2-part `schedule:{abbr}` shape.
      if (key.startsWith('schedule:')) {
        const [, abbr, requestedSeason] = key.split(':');
        const tc = TEAM_CONFIGS[abbr];
        if (tc) {
          ctx.waitUntil((async () => {
            try {
              const currentSeason = String(await resolveNHLSeason(env));
              const season = requestedSeason || currentSeason;
              const data  = await nhlGet(`${NHL_BASE}/club-schedule-season/${tc.abbr}/${season}`);
              const games = data?.games || [];
              const ttl   = season === currentSeason ? CURRENT_SCHEDULE_TTL : HISTORICAL_SCHEDULE_TTL;
              await kvPut(env, scheduleKey(tc.abbr, season), games, ttl);
              console.log(`Schedule bg fetch (cache miss): ${tc.abbr} season ${season} (${games.length} games)`);
            } catch (e) {
              console.warn(`Schedule bg fetch ${abbr}: ${e.message}`);
            }
          })());
        }
      }
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    }
    return json(val);
  }

  // Push subscribe
  if (url.pathname === '/push/subscribe' && request.method === 'POST') {
    const body = await request.json();
    const subs = (await kvGet(env, 'push:subs')) || [];

    // Build subscription object — include teamAbbr and prefs
    // Prefix league if not already present: 'CAR' → 'NHL:CAR', 'PWHL:MTL' stays
    const rawTeam = body.teamAbbr || 'CAR';
    const teamAbbr = rawTeam.includes(':') ? rawTeam : `NHL:${rawTeam}`;
    const newSub = {
      endpoint: body.endpoint,
      keys:     body.keys,
      teamAbbr,
      prefs:    body.prefs || null,
    };

    // Update existing or add new (deduplicate by endpoint)
    const idx = subs.findIndex(s => s.endpoint === body.endpoint);
    if (idx >= 0) {
      subs[idx] = newSub; // update team/prefs on re-subscribe
    } else {
      subs.push(newSub);
    }
    await kvPut(env, 'push:subs', subs, 365 * 24 * 3600);
    console.log(`Subscriber upserted: ${newSub.teamAbbr} prefs=${JSON.stringify(newSub.prefs)}. Total: ${subs.length}`);
    return json({ ok: true, total: subs.length });
  }

  // Push unsubscribe
  if (url.pathname === '/push/unsubscribe' && request.method === 'POST') {
    const { endpoint } = await request.json();
    const subs  = (await kvGet(env, 'push:subs')) || [];
    const after = subs.filter(s => s.endpoint !== endpoint);
    await kvPut(env, 'push:subs', after, 365 * 24 * 3600);
    return json({ ok: true, total: after.length });
  }

  // Manual poll
  if (url.pathname === '/poll') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    await poll(env, ctx);
    return json({ ok: true, polled: new Date().toISOString() });
  }

  // Manual social post test (protected)
  if (url.pathname === '/social/test') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const testSummary = {
      won: true, carScore: 4, oppScore: 2, oppAbbr: 'BOS',
      isHome: true, cfPct: 58, narrative: 'The Canes controlled this one from the drop of the puck.',
      topScorer: 'Sebastian Aho', carGoalie: { name: 'Pyotr Kochetkov', saves: 28, shots: 30 },
      goals: [{ period: 1 }, { period: 2 }, { period: 2 }, { period: 3 }],
    };
    const testGame = { id: 'test-001', gameType: 2 };
    const text = buildGamePost(testGame, testSummary);
    // Post for real if ?post=1 is passed, otherwise just preview
    if (url.searchParams.get('post') === '1') {
      const tweetId = await postToX(env, text);
      return json({ ok: true, tweetId, text });
    }
    return json({ ok: true, preview: text, length: text.length });
  }

  // Refresh MoneyPuck for ALL 32 teams — useful after season URL updates.
  // Fires waitUntil for each team so they all compute in parallel without blocking.
  if (url.pathname === '/moneypuck/refresh/all') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const teams = Object.keys(TEAM_CONFIGS);
    await env.CACHE.delete('moneypuck:raw'); // clear shared raw cache once
    for (const abbr of teams) {
      await env.CACHE.delete(`moneypuck:skaters:${abbr}`);
      ctx.waitUntil(
        fetchAndComputeMoneyPuck(env, abbr)
          .then(d => console.log(`MoneyPuck all: ${abbr} done (${Object.keys(d || {}).length} players)`))
          .catch(e => console.error(`MoneyPuck all: ${abbr} error: ${e.message}`))
      );
    }
    return json({ ok: true, teams, status: 'refreshing all 32 teams — check logs in ~60s' });
  }

  // POST /reddit/ingest — accepts bundled Reddit JSON from GitHub Actions runner.
  // Reddit blocks Cloudflare Workers IPs; GH-hosted runners are not blocked.
  // Workflow runs every 30 minutes, fetches all 32 subreddits, POSTs bundle here.
  // Body: JSON object { abbr: redditApiResponse, ... } for all 32 teams.
  // Merges parsed posts into existing news:abbr KV entries alongside RSS/Athletic/BR.
  if (url.pathname === '/reddit/ingest' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    let bundle;
    try {
      bundle = await request.json();
      if (!bundle || typeof bundle !== 'object') throw new Error('Expected JSON object');
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }
    const TTL = 35 * 60; // 35 min — slightly longer than the 30min run interval
    let processed = 0;
    const results = {};
    for (const [abbr, redditData] of Object.entries(bundle)) {
      const cfg = TEAM_CONFIGS[abbr.toUpperCase()];
      if (!cfg) continue;
      // Find the reddit source config for this team to get id/name/color
      // getNewsSources() takes the abbr string, not the config object — passing
      // cfg here threw (TEAM_CONFIGS[cfg] is undefined, then cfg.toLowerCase()
      // inside teamFilterKeywords isn't a function), crashing this route on
      // every real ingest call (found via Session 48's route-test coverage).
      const sources = getNewsSources(abbr.toUpperCase());
      const redditSrc = sources.find(s => s.type === 'reddit');
      if (!redditSrc) continue;
      const posts = parseReddit(redditData, redditSrc);
      // Merge with existing non-reddit news items so we don't overwrite RSS/Athletic/BR
      const existing = (await kvGet(env, `news:${abbr.toUpperCase()}`)) || [];
      const nonReddit = existing.filter(item => !item.id.startsWith('reddit-'));
      const merged = [...posts, ...nonReddit]
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, 30);
      await kvPut(env, `news:${abbr.toUpperCase()}`, merged, TTL);
      results[abbr] = posts.length;
      processed++;
    }
    console.log(`Reddit ingest: ${processed} teams processed`);
    return json({ ok: true, processed, results });
  }

  // POST /atom/ingest — accepts bundled SBNation/atom feed XML from GitHub Actions.
  // SBNation blogs block Cloudflare datacenter IPs; GH-hosted runners are not blocked.
  // Body: JSON object { sourceId: xmlText, ... } for all atom feeds.
  // Merges parsed articles into existing news:ABBR KV alongside Reddit posts.
  if (url.pathname === '/atom/ingest' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    let bundle;
    try {
      bundle = await request.json();
      if (!bundle || typeof bundle !== 'object') throw new Error('Expected JSON object');
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }
    // Build reverse lookup: sourceId → { abbr, sourceConfig }
    const sourceToTeam = {};
    for (const [abbr, sources] of Object.entries(TEAM_NEWS_SOURCES)) {
      for (const src of sources) {
        if (src.type === 'atom') sourceToTeam[src.id] = { abbr, src };
      }
    }
    const TTL = 25 * 3600; // 25hr — refreshed daily
    const results = {};
    for (const [sourceId, xml] of Object.entries(bundle)) {
      if (!xml || typeof xml !== 'string' || xml.length < 50) continue;
      const entry = sourceToTeam[sourceId];
      if (!entry) continue;
      const { abbr, src } = entry;
      try {
        const parsed = parseAtom(xml, src);
        if (!parsed.length) continue;
        // Merge with existing news — keep non-atom items intact
        const existing = (await kvGet(env, `news:${abbr}`)) || [];
        const nonAtom = existing.filter(item => !item.source || item.source !== sourceId);
        const merged = [...parsed, ...nonAtom]
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
          .slice(0, 30);
        await kvPut(env, `news:${abbr}`, merged, TTL);
        results[sourceId] = parsed.length;
      } catch (e) {
        console.warn(`Atom ingest: ${sourceId} parse error: ${e.message}`);
        results[sourceId] = 0;
      }
    }
    const total = Object.values(results).reduce((s, n) => s + n, 0);
    console.log(`Atom ingest: ${Object.keys(results).length} feeds, ${total} articles`);
    return json({ ok: true, results });
  }

  // POST /moneypuck/ingest — accepts raw CSV text from GitHub Actions runner.
  // Cloudflare Workers IPs are blocked by MoneyPuck; GitHub-hosted runners are not.
  // GitHub Actions fetches the CSV and POSTs it here once daily.
  if (url.pathname === '/moneypuck/ingest' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    let csvText;
    try {
      csvText = await request.text();
      if (!csvText || csvText.length < 100) throw new Error('Empty or too-short body');
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }
    const rows = parseCSV(csvText);
    if (!rows.length) return new Response('CSV parsed to 0 rows', { status: 400 });
    // Store raw rows (25hr TTL — refreshed daily by GH Actions)
    await kvPut(env, 'moneypuck:raw', rows, 25 * 3600);
    // Clear per-team caches so next access recomputes from fresh rows
    const teams = Object.keys(TEAM_CONFIGS);
    for (const abbr of teams) {
      await env.CACHE.delete(`moneypuck:skaters:${abbr}`);
    }
    // Kick off background computation for all 32 teams
    for (const abbr of teams) {
      ctx.waitUntil(
        computeMoneyPuckAnalytics(env, rows, abbr)
          .then(d => console.log(`MoneyPuck ingest: ${abbr} done (${Object.keys(d || {}).length} players)`))
          .catch(e => console.error(`MoneyPuck ingest: ${abbr} error: ${e.message}`))
      );
    }
    console.log(`MoneyPuck ingest: received ${rows.length} rows, computing all 32 teams`);
    return json({ ok: true, rows: rows.length, teams: teams.length, status: 'computing — check logs in ~60s' });
  }

  // Refresh MoneyPuck for a single team (default: team from ?team= param)
  // Generate summary for most recent completed game (protected, for testing)
  // MoneyPuck analytics endpoint
  if (url.pathname === '/moneypuck/refresh') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const tc = await getTeamConfig(request, env);
    await env.CACHE.delete(`moneypuck:skaters:${tc.abbr}`);
    await env.CACHE.delete('moneypuck:raw');
    ctx.waitUntil(
      fetchAndComputeMoneyPuck(env, tc.abbr)
        .then(data => console.log(`MoneyPuck done: ${Object.keys(data || {}).length} players`))
        .catch(e => console.error('MoneyPuck error:', e.message))
    );
    return json({ ok: true, team: tc.abbr, status: `refreshing — check /cache/moneypuck:skaters:${tc.abbr} in ~15s` });
  }

  // Refresh PP/PK unit compositions from Supabase → KV
  if (url.pathname === '/pp-units/refresh') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    ctx.waitUntil(
      refreshPPUnits(env)
        .then(map => console.log(`PP units done: ${Object.keys(map).length} teams`))
        .catch(e => console.error('PP units error:', e.message))
    );
    return json({ ok: true, status: 'refreshing — check /cache/pp_units:all in ~5s' });
  }

  if (url.pathname === '/summary/generate') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const tc       = await getTeamConfig(request, env);
    const schedule = await kvGet(env, scheduleKey(tc.abbr, tc.season));
    const recent   = (schedule || [])
      .filter(g => isCompleted(g))
      .sort((a, b) => new Date(b.gameDate).getTime() - new Date(a.gameDate).getTime())[0];
    if (!recent) return json({ error: 'No completed games found' });
    // Ensure PBP is cached first
    const pbp = await kvGet(env, `pbp:${recent.id}`);
    if (!pbp) {
      const [p, b] = await Promise.allSettled([
        nhlGet(`${NHL_BASE}/gamecenter/${recent.id}/play-by-play`),
        nhlGet(`${NHL_BASE}/gamecenter/${recent.id}/boxscore`),
      ]);
      if (p.status === 'fulfilled') await kvPut(env, `pbp:${recent.id}`, p.value, 3600);
      if (b.status === 'fulfilled') await kvPut(env, `boxscore:${recent.id}`, b.value, 3600);
    }
    // Force regenerate by deleting existing summary
    const forceRegen = url.searchParams.get('force') === '1';
    if (forceRegen) await env.CACHE.delete(`summary:${recent.id}`);
    await generateGameSummary(env, recent);
    const summary = await kvGet(env, `summary:${recent.id}`);
    return json({ ok: true, gameId: recent.id, summary });
  }

  // ── Pre-game prediction analysis ─────────────────────────────
  // GET /prediction/analyze?gameId=XXX — public, billed-AI route; rate-limited below (no secret check — this is called directly from the frontend)
  if (url.pathname === '/prediction/analyze') {
    const limited = await checkAiRateLimit(env, request, 'prediction-analyze');
    if (limited) return limited;
    const gameId    = url.searchParams.get('gameId');
    const forceRegen = url.searchParams.get('force') === '1';
    if (!gameId) return json({ error: 'gameId required' });
    const tc = await getTeamConfig(request, env);

    const kvKey = `prediction:${gameId}`;

    // Serve from cache if available and not forced
    if (!forceRegen) {
      const cached = await kvGet(env, kvKey);
      if (cached) return json(cached);
    }

    // Fetch standings for both teams
    const standings = await kvGet(env, 'standings') || [];
    const schedule  = await kvGet(env, scheduleKey(tc.abbr, tc.season)) || [];

    // Find this game
    const game = schedule.find(g => String(g.id) === String(gameId));
    if (!game) return json({ error: 'Game not found in schedule' });

    const isHome    = game.homeTeam?.abbrev === tc.abbr;
    const oppAbbr   = isHome ? game.awayTeam?.abbrev : game.homeTeam?.abbrev;
    const isPlayoff = game.gameType === 3;

    // NHL's /standings/now stays pinned to last season's final standings
    // until real games exist for the new one (confirmed live) — the
    // frontend already guards against this exact scenario (ScheduleView.jsx's
    // standingsAreStale), but this route pulls straight from the 'standings'
    // KV key with no season check, so without this it would happily generate
    // a confident-sounding prediction off finished, stale data and label it
    // as current form. Only reject on an EXPLICIT mismatch — an absent
    // seasonId isn't evidence of staleness, the real NHL API always includes it.
    const standingsSeasonId = standings[0]?.seasonId;
    if (standingsSeasonId != null && String(standingsSeasonId) !== String(tc.season)) {
      // No real current-season standings yet -- this used to just error
      // here. Route to the validated preseason fallback (prior-season
      // scorecard + continuity dampening) instead of blocking the user,
      // per COMBINED_CALIBRATION_IMPLEMENTATION.md's regime pipeline.
      return buildPreseasonFallback(env, tc, oppAbbr, isHome, isPlayoff, gameId, kvKey);
    }

    // Find standings for both teams
    const findTeam = abbr => standings.find(s =>
      s.teamAbbrev?.default === abbr || s.teamAbbrev === abbr
    );
    const carTeam = findTeam(tc.abbr);
    const oppTeam = findTeam(oppAbbr);

    if (!carTeam || !oppTeam) return json({ error: 'Team standings not found' });

    // Calculate key metrics
    const carGp  = carTeam.gamesPlayed || 1;
    const oppGp  = oppTeam.gamesPlayed || 1;
    const carGpg = (carTeam.goalFor ?? 0) / carGp;
    const oppGpg = (oppTeam.goalFor ?? 0) / oppGp;
    const carGag = (carTeam.goalAgainst ?? 0) / carGp;
    const oppGag = (oppTeam.goalAgainst ?? 0) / oppGp;
    const carSF  = carTeam.shotsForPerGame  || 0;
    const oppSF  = oppTeam.shotsForPerGame  || 0;
    const carSA  = carTeam.shotsAgainstPerGame || 0;
    const oppSA  = oppTeam.shotsAgainstPerGame || 0;

    // Real Corsi (shot-attempt share: goals+shots+blocked+missed), from
    // team_seasons — replaces the SOG-share-only proxy this route used to
    // compute inline (Session 52; that proxy ignored blocked/missed shots
    // entirely). Prefers the 5v5-filtered column over all-situations, over
    // the old SOG-share proxy as a last resort — unlike PWHL's own
    // /pwhl/prediction (pwhl.js), which is still all-situations only since
    // PWHL's strength-state reconstruction is a separate, harder problem
    // (see eyewall-pipeline's pwhl_strength_state.py); NHL's shot_events
    // already carries a real situation_code natively, so 5v5 costs nothing
    // extra here. team_seasons.corsi_for_pct[_5v5] are stored as 0-1
    // fractions, same convention as this table's existing xgf_pct column
    // — scaled to a percentage below like every frontend xgf_pct reader
    // already does (see LeagueView.jsx).
    let carCF = null, oppCF = null, corsiSource = 'sog_share_proxy';
    try {
      const season = await resolveNHLSeason(env);
      const teamRows = await sbRows(
        `team_seasons?team=in.(${tc.abbr},${oppAbbr})&season=eq.${season}&game_type=eq.2` +
        `&select=team,corsi_for_pct,corsi_for_pct_5v5`
      );
      const carRow = teamRows.find(r => r.team === tc.abbr);
      const oppRow = teamRows.find(r => r.team === oppAbbr);
      if (carRow?.corsi_for_pct_5v5 != null && oppRow?.corsi_for_pct_5v5 != null) {
        carCF = (carRow.corsi_for_pct_5v5 * 100).toFixed(1);
        oppCF = (oppRow.corsi_for_pct_5v5 * 100).toFixed(1);
        corsiSource = '5v5';
      } else if (carRow?.corsi_for_pct != null && oppRow?.corsi_for_pct != null) {
        carCF = (carRow.corsi_for_pct * 100).toFixed(1);
        oppCF = (oppRow.corsi_for_pct * 100).toFixed(1);
        corsiSource = 'all_situations';
      }
    } catch (e) {
      console.error('team_seasons Corsi fetch failed, falling back to SOG-share proxy:', e);
    }
    if (carCF === null || oppCF === null) {
      // Fallback: team_seasons rows/columns not populated yet for this
      // season (e.g. before moneypuck.py's nightly Corsi rollup has run,
      // or before docs/session52_new_columns.sql has been applied).
      carCF = carSF + oppSA > 0 ? (carSF / (carSF + oppSA) * 100).toFixed(1) : null;
      oppCF = oppSF + carSA > 0 ? (oppSF / (oppSF + carSA) * 100).toFixed(1) : null;
      corsiSource = 'sog_share_proxy';
    }
    const corsiCaveat = corsiSource === '5v5'
      ? '5-on-5 shot-attempt share (goals+shots+blocked+missed).'
      : corsiSource === 'all_situations'
        ? 'All-situations shot-attempt share (goals+shots+blocked+missed), not 5-on-5 filtered.'
        : 'Shots-on-goal share only (blocked/missed shots not counted) — real Corsi data unavailable for this team/season yet.';
    const corsiLabel = corsiSource === 'sog_share_proxy' ? 'Corsi proxy (SOG share)' : 'Corsi (real shot-attempt share)';

    // PDO proxy

    // Recent form
    const carStreak = carTeam.streakCode && carTeam.streakCount
      ? `${carTeam.streakCode}${carTeam.streakCount}`
      : 'unknown';
    const oppStreak = oppTeam.streakCode && oppTeam.streakCount
      ? `${oppTeam.streakCode}${oppTeam.streakCount}`
      : 'unknown';

    // Head-to-head this season from schedule
    const h2h = schedule.filter(g => {
      const isCompleted = ['OFF','FINAL','F','FINAL_OVERTIME','FINAL_SHOOTOUT'].includes(g.gameState);
      if (!isCompleted) return false;
      const teams = [g.homeTeam?.abbrev, g.awayTeam?.abbrev];
      return teams.includes(tc.abbr) && teams.includes(oppAbbr);
    });
    const h2hCarWins = h2h.filter(g => {
      const carIsHome = g.homeTeam?.abbrev === tc.abbr;
      const carScore  = carIsHome ? g.homeTeam?.score : g.awayTeam?.score;
      const oppScore  = carIsHome ? g.awayTeam?.score : g.homeTeam?.score;
      return carScore > oppScore;
    }).length;
    const h2hRecord = h2h.length > 0 ? `${h2hCarWins}-${h2h.length - h2hCarWins}` : 'no prior meetings';

    // Pythagorean expected goals
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const homeAdj = isHome ? 0.12 : -0.12;
    const expCar  = clamp(Math.sqrt(Math.max(carGpg,0.5) * Math.max(oppGag,0.5)) + homeAdj, 1.5, 5.0).toFixed(1);
    const expOpp  = clamp(Math.sqrt(Math.max(oppGpg,0.5) * Math.max(carGag,0.5)) - homeAdj, 1.5, 5.0).toFixed(1);

    // Win probability (model-only, no odds available in Worker)
    let carScore = 0, oppScore = 0;
    if (!isPlayoff) { // Points only matter in regular season
      const ptsDiff = (carTeam.points ?? 0) - (oppTeam.points ?? 0);
      carScore += ptsDiff > 0 ? Math.min(ptsDiff / 20, 1) : 0;
      oppScore += ptsDiff < 0 ? Math.min(-ptsDiff / 20, 1) : 0;
    }
    if (carGpg > oppGpg) carScore += 0.6; else oppScore += 0.6;
    if (carGag < oppGag) carScore += 0.6; else oppScore += 0.6;
    if ((carTeam.powerPlayPct ?? 22) > (oppTeam.powerPlayPct ?? 22)) carScore += 0.4;
    else oppScore += 0.4;
    if (carSF > oppSF) carScore += 0.5; else oppScore += 0.5; // possession
    if (carTeam.streakCode === 'W') carScore += 0.3;
    if (oppTeam.streakCode === 'W') oppScore += 0.3;
    const total = carScore + oppScore || 1;
    // Isotonic calibration applied to the raw fraction BEFORE rounding —
    // matches exactly what was fit/validated (Brier -23%, log loss -71%
    // on a true 2025-26 holdout, see combined_calibration_part_a_b_results.md).
    // Only the in-season branch gets this correction — the preseason
    // fallback below uses continuity dampening instead, never both.
    const carWinPct = Math.round(isotonicCalibrate(carScore / total) * 100);

    const prompt = `You are EyeWall Analytics, a ${tc.displayName} hockey analytics assistant. Write a sharp, data-driven pre-game analysis for ${tc.displayName} fans. 2-3 sentences only. Be specific about the numbers. No filler. No "In this matchup" opener.

Game: ${tc.abbr} (${isHome ? 'HOME' : 'AWAY'}) vs ${oppAbbr}
Context: ${isPlayoff ? 'PLAYOFFS' : 'Regular Season'}

${tc.abbr} stats:
- Record: ${carTeam.wins}-${carTeam.losses}-${carTeam.otLosses} (${carTeam.points} pts)
- GF/GA per game: ${carGpg.toFixed(2)} / ${carGag.toFixed(2)}
- PP%: ${(carTeam.powerPlayPct ?? 0).toFixed(1)}% · PK%: ${(carTeam.penaltyKillPct ?? 0).toFixed(1)}%
- SOG/GP: ${carSF.toFixed(1)} for / ${carSA.toFixed(1)} against
- ${corsiLabel}: ${carCF ?? '—'}%
- Current streak: ${carStreak}

${oppAbbr} stats:
- Record: ${oppTeam.wins}-${oppTeam.losses}-${oppTeam.otLosses} (${oppTeam.points} pts)
- GF/GA per game: ${oppGpg.toFixed(2)} / ${oppGag.toFixed(2)}
- PP%: ${(oppTeam.powerPlayPct ?? 0).toFixed(1)}% · PK%: ${(oppTeam.penaltyKillPct ?? 0).toFixed(1)}%
- SOG/GP: ${oppSF.toFixed(1)} for / ${oppSA.toFixed(1)} against
- ${corsiLabel}: ${oppCF ?? '—'}%
- Current streak: ${oppStreak}

Head-to-head this season: ${tc.abbr} ${h2hRecord}
Expected score (Pythagorean): ${tc.abbr} ${expCar} - ${oppAbbr} ${expOpp}
Model win probability: ${tc.abbr} ${carWinPct}%${isPlayoff ? '\n\nNote: This is a playoff game. Ignore regular season points — focus on possession, goaltending, and recent form.' : ''}

${corsiSource === 'sog_share_proxy' ? 'Note: the Corsi figure above is a shots-on-goal-only proxy (real shot-attempt data unavailable) — describe it as "shot share," not "Corsi" or "possession," in your analysis.' : `Note: the Corsi figure above is ${corsiCaveat} Describe it as "shot-attempt share" or "Corsi," accurately reflecting that scope.`}

Write the analysis now. Mention the single most decisive factor, one risk or concern, and a concrete expected-score range.`;

    const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
    });
    const narrative = aiResponse.response?.trim() || '';
    if (!narrative) return json({ error: 'Empty response' });

    const result = {
      gameId,
      oppAbbr,
      isHome,
      isPlayoff,
      carWinPct,
      expCar:    parseFloat(expCar),
      expOpp:    parseFloat(expOpp),
      narrative,
      h2hRecord,
      carStreak,
      oppStreak,
      carCF,
      corsiForPct: { car: carCF != null ? parseFloat(carCF) : null, opp: oppCF != null ? parseFloat(oppCF) : null },
      corsiCaveat,
      generatedAt: new Date().toISOString(),
      regime: 'in-season',
      correction: 'isotonic-calibrated',
    };

    // Cache for 24hr (pre-game analysis refreshes daily in case of lineup changes)
    await kvPut(env, kvKey, result, 24 * 3600);
    console.log(`Prediction analysis generated for game ${gameId}`);
    return json(result);
  }

  // Send a test notification (protected)
  if (url.pathname === '/push/test') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    await broadcast(env, {
      title: '🚨 Test Notification',
      body:  'EyeWall Analytics push notifications are working!',
      tag:   'test',
      url:   '/',
    });
    return json({ ok: true });
  }

  // ── Period narrative (cached per game+period, shared across all users) ──
  // Public, billed-AI route; rate-limited below (no secret check — called directly from the frontend)
  if (url.pathname === '/summary/narrative') {
    const limited = await checkAiRateLimit(env, request, 'summary-narrative');
    if (limited) return limited;
    const gameId = url.searchParams.get('gameId');
    const period = url.searchParams.get('period'); // 'game' or period number
    if (!gameId || !period) return json({ error: 'gameId and period required' });
    // Key includes carAbbr so each team gets its own cached perspective
    const carAbbrKey = (url.searchParams.get('carAbbr') || 'UNK').toUpperCase();
    const kvKey  = `narrative:${period}:${gameId}:${carAbbrKey}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    // Stats payload sent by the client
    let stats;
    try { stats = await request.json(); } catch { return json({ error: 'Invalid body' }); }

    const isGame   = period === 'game';
    const oppAbbr  = stats.oppAbbr || 'OPP';
    const carAbbr  = stats.carAbbr || 'CAR';
    const isPlayoff = stats.isPlayoff || false;

    const goalsSummary = (stats.goals || []).map(g =>
      `${g.isCar ? carAbbr : oppAbbr} goal by ${g.scorerName || 'unknown'} at ${g.time || '—'} (${(g.strength || 'EV').toUpperCase()})`
    ).join('; ') || 'no goals';

    // Build explicit allowed-names list from goal scorer data only
    const confirmedNames = [...new Set(
      (stats.goals || [])
        .map(g => g.scorerName)
        .filter(n => n && n !== 'unknown' && n !== 'Unknown')
    )];
    if (stats.primaryGoalieName) confirmedNames.push(stats.primaryGoalieName);
    const allowedNamesNote = confirmedNames.length > 0
      ? `Players you may name: ${confirmedNames.join(', ')}. Do not name any other player — not linemates, not defensemen, not anyone not listed here.`
      : `No confirmed player names — refer to teams by abbreviation only (${carAbbr}, ${oppAbbr}).`;

    const playoffNote = isPlayoff
      ? '\n\nNote: This is a PLAYOFF game. Do not mention points, standings, or "escaping with a point". Overtime is full 20-minute periods, not 3v3. Focus on possession, goaltending, and series context.'
      : '';

    const prompt = isGame
      ? `You are EyeWall, an analytics assistant for ${carAbbr} hockey fans.
  Write a sharp 3-4 sentence final game summary for ${carAbbr} vs ${oppAbbr}.
  Tone: analytical, knowledgeable fan. No fluff. No bullet points.

  Game stats:
  - Final: ${carAbbr} ${stats.carGoals} - ${stats.oppGoals} ${oppAbbr}
  - Game Corsi For%: ${stats.corsiForPct}%
  - CAR shots: ${stats.carSOG}, OPP shots: ${stats.oppSOG}
  - CAR high danger chances: ${stats.carHDCF} vs OPP ${stats.oppHDCF}
  - Best period for CAR: P${stats.bestPeriod?.period} (${stats.bestPeriod?.corsiForPct}% CF)
  - Worst period: P${stats.worstPeriod?.period} (${stats.worstPeriod?.corsiForPct}% CF)
  - CAR hits: ${stats.carHits}, CAR faceoffs: ${stats.carFOPct}%
  - Goals: ${goalsSummary}

  ${allowedNamesNote}

  Summarize how the game went, key turning points, and whether the result matched the underlying play. Under 80 words.${playoffNote}`
      : `You are EyeWall, an analytics assistant for ${carAbbr} hockey fans.
  Write a tight 2-3 sentence period summary for ${stats.periodLabel} of a ${carAbbr} vs ${oppAbbr} game.
  Tone: sharp, analytical, knowledgeable fan. No fluff. No bullet points. Just sentences.

  Stats:
  - CAR Corsi For%: ${stats.corsiForPct}%
  - CAR shots on goal: ${stats.carSOG}, OPP shots on goal: ${stats.oppSOG}
  - CAR goals: ${stats.carGoals}, OPP goals: ${stats.oppGoals}
  - CAR hits: ${stats.carHits}
  - Penalties: ${stats.penaltyCount} total (${stats.carPenaltyCount} against ${carAbbr})
  - Goals: ${goalsSummary}

  ${allowedNamesNote}

  Focus on what mattered most — possession dominance, momentum, key goals. Under 60 words.${playoffNote}`;

    // For game summaries, also generate a short card caption in parallel
    const cardPrompt = isGame
      ? prompt.replace(
          'Summarize how the game went, key turning points, and whether the result matched the underlying play. Under 80 words.',
          'Write a 2-3 sentence shareable card caption. Hit the key result, one standout moment, and the underlying play if telling. Under 50 words. Plain text only.'
        )
      : null;

    const [aiResponse, cardResponse] = await Promise.all([
      env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages: [{ role: 'user', content: prompt }],
      }),
      cardPrompt
        ? env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
            messages: [{ role: 'user', content: cardPrompt }],
          })
        : Promise.resolve(null),
    ]);

    const narrative     = aiResponse.response?.trim() || '';
    const cardNarrative = cardResponse?.response?.trim() || null;
    if (!narrative) return json({ error: 'Empty response' });

    const result = { narrative, cardNarrative, gameId, period, generatedAt: new Date().toISOString() };
    // Cache 30 days — narratives never change for a completed period
    await kvPut(env, kvKey, result, 30 * 24 * 3600);
    console.log(`Narrative cached: ${kvKey}`);
    return json(result);
  }

  // ── Draft rankings — serves NHL Central Scouting data from Supabase ──────────
  // GET /draft/rankings?category=1   (1=NA Skater, 2=Intl Skater, 3=NA Goalie, 4=Intl Goalie)
  // GET /draft/rankings              (returns all 4 categories, keyed by category_id)
  if (url.pathname === '/draft/rankings') {
    const category = url.searchParams.get('category');
    const kvKey    = category ? `draft:rankings:2026:${category}` : 'draft:rankings:2026:all';

    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const filter = category
      ? `?category_id=eq.${category}&order=final_rank.asc&limit=300`
      : `?order=category_id.asc,final_rank.asc&limit=600`;

    const r = await fetch(`${SB_URL}/rest/v1/draft_rankings_2026${filter}`, {
      headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` },
    });
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();

    // If fetching all, group by category_id for convenient frontend consumption
    let result;
    if (!category) {
      result = { 1: [], 2: [], 3: [], 4: [] };
      for (const row of rows) result[row.category_id].push(row);
    } else {
      result = rows;
    }

    // Rankings are stable — cache 24hr
    await kvPut(env, kvKey, result, 24 * 3600);
    return json(result);
  }

  // ── Draft picks — live during draft, stored forever in Supabase ───────────────
  // GET /draft/picks              — all picks (post-draft: full board)
  // GET /draft/picks?team=CAR     — filtered by team
  // GET /draft/picks?round=1      — filtered by round
  if (url.pathname === '/draft/picks') {
    const team  = url.searchParams.get('team')?.toUpperCase();
    const round = url.searchParams.get('round');

    const kvKey  = `draft:picks:2026:${team || 'all'}:${round || 'all'}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let filter = '?order=pick_overall.asc&limit=300';
    if (team)  filter += `&team_abbrev=eq.${team}`;
    if (round) filter += `&round=eq.${round}`;

    const r = await fetch(`${SB_URL}/rest/v1/draft_picks_2026${filter}`, {
      headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` },
    });
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();

    // Short TTL while draft is in progress or unresolved (including zero
    // results, e.g. a round that hasn't happened yet — this must NOT get
    // the 24hr branch or a snapshot taken before picks exist gets pinned
    // in KV for a full day). Long TTL only once we've actually seen all
    // 224 picks.
    const ttl = rows.length >= 224 ? 24 * 3600 : 60;
    await kvPut(env, kvKey, rows, ttl);
    return json(rows);
  }

  // ── Draft pick order — projected slots pre-draft ──────────────────────────────
  // GET /draft/order              — full R1 order (all 32 teams)
  // GET /draft/order?team=CAR     — just this team's known slots
  if (url.pathname === '/draft/order') {
    const team   = url.searchParams.get('team')?.toUpperCase();
    const kvKey  = `draft:order:2026:${team || 'all'}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let filter = '?order=pick_overall.asc&limit=32';
    if (team) filter += `&team_abbrev=eq.${team}`;

    const r = await fetch(`${SB_URL}/rest/v1/draft_pick_order_2026${filter}`, {
      headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` },
    });
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();

    await kvPut(env, kvKey, rows, 24 * 3600);
    return json(rows);
  }

  // ── Milestones — hat tricks, shutouts, SH goals, season/career thresholds ─────
  // GET /milestones               — recent milestones, NHL only (feed default)
  // GET /milestones?team=CAR      — filtered to one team
  // GET /milestones?sport=pwhl    — PWHL milestones instead of NHL
  // GET /milestones?limit=20      — override default limit (default 50, max 100)
  // Populated nightly by milestones.py (NHL) / pwhl_milestones.py (PWHL), both
  // writing into the same shared `milestones` table distinguished by is_pwhl.
  // Defaults to NHL (is_pwhl=false) for backwards compat with the existing
  // frontend — sport=pwhl must be passed explicitly.
  if (url.pathname === '/milestones') {
    const team  = url.searchParams.get('team')?.toUpperCase();
    const sport = url.searchParams.get('sport')?.toLowerCase();
    const isPwhl = sport === 'pwhl';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);

    const kvKey  = `milestones:${sport || 'nhl'}:${team || 'all'}:${limit}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let filter = `?order=game_date.desc,id.desc&limit=${limit}&is_pwhl=eq.${isPwhl}`;
    if (team) filter += `&team=eq.${team}`;

    const r = await fetch(`${SB_URL}/rest/v1/milestones${filter}`, {
      headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` },
    });
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // NOTE: /pwhl/player/landing lives in pwhl.js, not here — worker.js
  // routes every /pwhl/* path to handlePWHL. An earlier version of this
  // endpoint was mistakenly added to this file and was dead code (never
  // reachable), which is why the frontend got CORS errors: the request
  // fell through pwhl.js's own routing to its no-CORS-headers 200
  // fallback response, never touching this file at all.

  // ── Player landing — proxy for PlayerPopup lookups (e.g. from milestone taps) ──
  // GET /player/landing?id=8483548
  // Browser can't hit api-web.nhle.com directly (no CORS headers on their
  // side), so this proxies through the Worker like every other NHL API
  // call in this app.
  if (url.pathname === '/player/landing') {
    const playerId = url.searchParams.get('id');
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `player:landing:${playerId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let data;
    try {
      data = await nhlGet(`${NHL_BASE}/player/${playerId}/landing`);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    await kvPut(env, kvKey, data, 3600);
    return json(data);
  }

  // ── Draft pick AI analysis ────────────────────────────────────────────────────
  // POST /draft/analyze  (secret-protected, called by draft_ingest.py on draft day)
  // Body: { prompt: string }
  // Returns: { analysis: string }
  if (url.pathname === '/draft/analyze' && request.method === 'POST') {
    const secret = request.headers.get('X-Poll-Secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });

    let body;
    try {
      body = await request.json();
      if (!body?.prompt) throw new Error('prompt required');
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }

    const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content: `You are Sticks, the EyeWall Analytics draft analyst. You give sharp, specific 2-3 sentence pick analyses. Focus on value relative to rank, team fit, and player type. No filler. No "This is a great pick" openers. Be direct.`,
        },
        { role: 'user', content: body.prompt },
      ],
    });

    const analysis = aiResponse.response?.trim() || '';
    if (!analysis) return new Response(JSON.stringify({ error: 'Empty AI response' }), { status: 502, headers: corsHeaders() });

    console.log(`Draft analyze: ${analysis.slice(0, 80)}...`);
    return json({ analysis });
  }

  return new Response('Not found', { status: 404, headers: corsHeaders() });
}
