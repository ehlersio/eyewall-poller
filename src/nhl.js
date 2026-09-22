/**
 * nhl.js — EyeWall Analytics Worker
 *
 * NHL poll loop, push notifications, and all /nhl/* + /poll/* HTTP endpoints.
 * Scheduled trigger calls poll() every 60s during the season.
 */

import { kvGet, kvPut, json, cachedJson, sbRows, sbHeaders, errorJson, badRequest, unauthorized, corsHeaders, SB_URL, parseRSS, parseESPN, parseAtom, parseSportsnet, parseGoogleNews, parseNHLNews, sendPush, sendLiveActivityPush, subId, checkAiRateLimit, buildHeadToHeadPayload, generateText, recordHealth, requestLocale, localizePrompt, localeKeySuffix } from './shared.js';
import { resolveNHLSeason, resolvePWHLSeason } from './seasons.js';
import { pairTransactions, TRANSACTIONS_LIMIT } from './transactions.js';
import { fetchTradeTree } from './trades.js';
import { summarizeScratches } from './scratches.js';
import { summarizeNextGames, isPlayoffOddsStale } from './playoffOdds.js';
import { summarizeInjuryLeague } from './injuryImpact.js';
import { summarizeStarters } from './probableStarters.js';
import { summarizeProjectedLines } from './projectedLines.js';
import { summarizeScorecard } from './scorecard.js';

const NHL_BASE   = 'https://api-web.nhle.com/v1';

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

// 1 hour — rosters change rarely (trades/waivers aside) most of the
// season, but this app also gets hit hardest during training camp
// (Sept), when the roster genuinely can change day to day as players
// get cut/signed. 1hr balances real resilience against a slow/rate-
// limited upstream call against not sitting on a stale camp roster too
// long — matches milestones' own 1hr TTL for the same "hot but not
// truly live" shape. Bustable manually via /cache if a trade needs to
// show up faster than that.
const ROSTER_TTL = 3600;
function rosterKey(abbr) {
  return `roster:${abbr}`;
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

// Current-season schedule for a team, fetching live and caching on a miss
// instead of assuming the cache is already warm. CAR's copy stays warm
// forever via poll()'s own cron refresh (TEAM_ABBR-scoped, runs every
// 60s); every other team's cache depends entirely on a recent
// /schedule?team=X request having already populated it -- /schedule's
// own current-season path even deliberately returns [] on a cold miss
// (fire-and-forget background fetch, fine for a page the frontend
// re-polls). A caller that needs the schedule for a one-shot answer
// (can't just tell the user to reload) can't tolerate that gap: found
// live in production as "Game not found in schedule" for every non-CAR
// team whenever nothing had recently warmed that team's cache -- /prediction/analyze
// was reading the cache passively (`kvGet(...) || []`) instead of ever
// fetching. This fetches synchronously so the very first request for a
// cold team succeeds instead of erroring once and only working on retry.
async function scheduleWithFetch(env, abbr, season) {
  const cached = await kvGet(env, scheduleKey(abbr, season));
  if (cached) return cached;
  try {
    const data  = await nhlGet(`${NHL_BASE}/club-schedule-season/${abbr}/${season}`);
    const games = data?.games || [];
    await kvPut(env, scheduleKey(abbr, season), games, CURRENT_SCHEDULE_TTL);
    return games;
  } catch (e) {
    console.warn(`scheduleWithFetch(${abbr}, ${season}): ${e.message}`);
    return [];
  }
}

// Server-side Supabase REST read, for the /player-analytics etc. proxy
// routes below. Takes a table path and throws on failure (the message names
// the status and path, and several routes pass it through in their 502) --
// unlike shared.js's sbRows(), which takes a full URL and returns the 502
// Response instead.
async function sbRowsOrThrow(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${path}`);
  return r.json();
}

// Prediction win-probability model (2026-09: Elo, see below) — both
// /prediction/analyze branches (in-season and true-preseason) used to run
// a hand-tuned scorecard (fixed weights on points/GF-GA/PP%/possession/
// streak, never fit against real data) plus, in-season only, a separately
// fitted isotonic calibration layer patched on top after the raw scorecard
// was found badly overconfident at the extremes (see
// eyewall-pipeline/docs/combined_calibration_part_a_b_results.md — now
// superseded). Both are gone, replaced by a single Elo model validated in
// eyewall-pipeline/docs/elo_prediction_model_results.md to beat the old
// two-regime system on every metric, in both regimes, with no separate
// calibration step needed (Elo's logistic formula is calibrated by
// construction).

// League-average PP% -- the one shared fallback value for a missing
// team_seasons.pp_pct in buildPreseasonFallback (used identically by both
// the AI prompt text there and the in-season branch's own PP% display;
// see PP_PCT_BACKFILL_GAP_INVESTIGATION.md).
const PP_PCT_DEFAULT = 22;

// e.g. 20252026 -> 20242025. Mirrors rapm.py's prior_season() exactly —
// keep in sync if that ever changes.
function priorSeason(season) {
  const endYear = season % 10000;
  const startYear = Math.floor(season / 10000);
  return (startYear - 1) * 10000 + (endYear - 1);
}

// Elo win probability -- see eyewall-pipeline/docs/elo_prediction_model_results.md
// for the backtest (beats both the scorecard-based in-season branch and
// this file's own prior continuity-dampened preseason fallback, on every
// metric, in both regimes). Ratings live in Supabase (team_elo_ratings,
// eyewall-pipeline's elo_ratings.py updates them nightly via a full
// chronological replay of game_log, including a regression-to-mean step
// applied once at each season boundary) -- so a single rating lookup is
// correct for BOTH branches below; the preseason regime needs no separate
// dampening logic anymore, since the pipeline-side regression-to-mean
// already IS the season-boundary "roster probably changed some" discount,
// done from real outcomes instead of a hand-set TOI-retention fraction.
const ELO_HOME_ADVANTAGE = 35; // FiveThirtyEight's published NHL value; matches eyewall-pipeline/elo.py exactly

async function fetchEloRatings(tc, oppAbbr) {
  const rows = await sbRowsOrThrow(`team_elo_ratings?team=in.(${tc.abbr},${oppAbbr})&select=team,rating`);
  // 1500 (Elo's neutral starting rating) for a team with no row yet -- same
  // graceful default elo_ratings.py itself uses for a team's first-ever
  // appearance (true expansion, or the table simply hasn't been populated
  // for this team yet). Never a hard error -- a missing rating shouldn't
  // block a prediction the way missing prior-season team_seasons data
  // used to.
  const car = rows.find(r => r.team === tc.abbr)?.rating ?? 1500;
  const opp = rows.find(r => r.team === oppAbbr)?.rating ?? 1500;
  return { car, opp };
}

// Returns tc's win probability (0-1), applying home advantage to whichever
// side is actually playing at home -- unless the game is at a neutral site
// (e.g. a Global Series game), where neither side gets it. Mirrors
// eyewall-pipeline's playoff_odds.home_win_prob() exactly (elo.py's
// expected_prob(rating_home + HOME_ADVANTAGE, rating_away), no advantage when
// neutral) -- the number win_probs.py logs for the public scorecard -- just
// reoriented to answer "does tc win" regardless of which side tc is on.
function eloWinProb(carRating, oppRating, isHome, neutral = false) {
  const homeRating = isHome ? carRating : oppRating;
  const awayRating = isHome ? oppRating : carRating;
  const advantage = neutral ? 0 : ELO_HOME_ADVANTAGE;
  const homeWinProb = 1 / (1 + Math.pow(10, (awayRating - (homeRating + advantage)) / 400));
  return isHome ? homeWinProb : 1 - homeWinProb;
}

// Called from /prediction/analyze when standings are still pinned to last
// season (no real current-season data yet). Win probability comes from
// team_elo_ratings (see above); everything else here is descriptive
// context for the AI narrative and the Pythagorean expected-score display
// — last season's box-score rates, since this season's don't exist yet.
async function buildPreseasonFallback(env, tc, oppAbbr, isHome, isPlayoff, gameId, kvKey, neutral = false, locale = 'en') {
  const prior = priorSeason(tc.season);

  let teamSeasonRows, eloRatings;
  try {
    [teamSeasonRows, eloRatings] = await Promise.all([
      sbRowsOrThrow(`team_seasons?team=in.(${tc.abbr},${oppAbbr})&season=eq.${prior}&game_type=eq.2` +
        `&select=team,points,goals_for_pg,goals_ag_pg,pp_pct,corsi_for_pct,corsi_for_pct_5v5`),
      fetchEloRatings(tc, oppAbbr),
    ]);
  } catch (e) {
    return errorJson(502, { error: e.message });
  }

  const carRow = teamSeasonRows.find(r => r.team === tc.abbr);
  const oppRow = teamSeasonRows.find(r => r.team === oppAbbr);
  if (!carRow || !oppRow) {
    return errorJson(404, { error: `No prior-season (${prior}) data available for ${tc.abbr} or ${oppAbbr} — cannot generate a preseason estimate yet.` });
  }

  const carGpg = carRow.goals_for_pg ?? 0;
  const oppGpg = oppRow.goals_for_pg ?? 0;
  const carGag = carRow.goals_ag_pg ?? 0;
  const oppGag = oppRow.goals_ag_pg ?? 0;

  // League-average default (22%) when a team's prior-season pp_pct is
  // missing from team_seasons -- only feeds the narrative text now (the
  // win% no longer comes from a scorecard that also needed this default),
  // kept so the prompt never silently prints a bare 0%.
  if (carRow.pp_pct == null) console.error(`buildPreseasonFallback: ${tc.abbr} ${prior} pp_pct missing, defaulting to league-average ${PP_PCT_DEFAULT}%`);
  if (oppRow.pp_pct == null) console.error(`buildPreseasonFallback: ${oppAbbr} ${prior} pp_pct missing, defaulting to league-average ${PP_PCT_DEFAULT}%`);
  const carPP = carRow.pp_pct ?? PP_PCT_DEFAULT;
  const oppPP = oppRow.pp_pct ?? PP_PCT_DEFAULT;

  const carWinPct = Math.round(eloWinProb(eloRatings.car, eloRatings.opp, isHome, neutral) * 100);

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

  const prompt = `You are EyeWall Analytics, a ${tc.displayName} hockey analytics assistant. Write a sharp, data-driven PRESEASON analysis for ${tc.displayName} fans — no games have been played yet this season. The win probability below is from a live-updated Elo rating (carries over from last season, so it already reflects each team's recent trajectory); everything else is last season's (${prior}) final numbers for context. 2-3 sentences only. Be specific about the numbers and be clear this is a preseason estimate, not current form. No filler. No "In this matchup" opener.

Game: ${tc.abbr} (${isHome ? 'HOME' : 'AWAY'}) vs ${oppAbbr}
Context: Preseason estimate

${tc.abbr} last season (${prior}): ${carRow.points ?? '—'} pts, GF/GA per game: ${carGpg.toFixed(2)} / ${carGag.toFixed(2)}, PP%: ${carPP.toFixed(1)}%
${oppAbbr} last season (${prior}): ${oppRow.points ?? '—'} pts, GF/GA per game: ${oppGpg.toFixed(2)} / ${oppGag.toFixed(2)}, PP%: ${oppPP.toFixed(1)}%

Expected score (Pythagorean, from last season's rates): ${tc.abbr} ${expCar} - ${oppAbbr} ${expOpp}
Model win probability (Elo): ${tc.abbr} ${carWinPct}%

Write the analysis now. Mention the single most decisive factor from last season and a concrete expected-score range.`;

  let aiResponse;
  try {
    aiResponse = await generateText(env, {
      messages: [{ role: 'user', content: localizePrompt(prompt, locale) }],
    });
  } catch (e) {
    console.error('buildPreseasonFallback AI error:', e);
    return errorJson(502, { error: 'AI generation failed' });
  }
  const narrative = aiResponse.response?.trim() || '';
  if (!narrative) return errorJson(502, { error: 'Empty response' });

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
    correction: 'elo',
    isFallback: true,
    dataSeason: prior,
  };

  await kvPut(env, kvKey, result, 24 * 3600);
  console.log(`Preseason prediction analysis generated for game ${gameId} (data season ${prior})`);
  return json(result);
}


// ── Scoreboard (/nhl/today) ───────────────────────────────────
// Today's date where the league lives, not the viewer's and not UTC: an
// 8pm PT game is still "today" at 04:00 UTC the next morning.
function etDateString(now = new Date()) {
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    .toISOString().slice(0, 10);
}

// NHL's /score/now is NOT "today" — in the offseason it jumps to whatever
// date it considers current (2026-09-15: it served Sept 29's regular-season
// opener, skipping the Sept 19 preseason games entirely). So ask for a date
// explicitly, and when that date has no games, walk forward to the next one
// that does, via /schedule's gameWeek (which does include preseason).
// Returns the scoreboard payload for whichever date was chosen; its games
// each carry their own gameDate, so the caller never has to assume "today".
async function nhlScoreboardForDisplay(dateStr) {
  const today = await nhlGet(`${NHL_BASE}/score/${dateStr}`);
  if (today?.games?.length) return today;

  let nextDate;
  try {
    const week = await nhlGet(`${NHL_BASE}/schedule/${dateStr}`);
    const withGames = (week?.gameWeek || []).find(d => (d.numberOfGames ?? d.games?.length ?? 0) > 0);
    nextDate = withGames?.date || week?.nextStartDate || null;
  } catch (e) {
    console.warn(`nhl/today: schedule lookahead failed: ${e.message}`);
    return today;
  }
  if (!nextDate || nextDate === dateStr) return today;
  return nhlGet(`${NHL_BASE}/score/${nextDate}`);
}

// One scoreboard card's worth of a game. gameDate is what lets the client
// say "Today" only when it means it; period/clock are what make a live card
// readable at a glance (the clock is a snapshot, not a ticking one — this
// response is KV-cached 60s and the client polls every 30s).
function normalizeScoreboardGame(g) {
  const live = g.gameState === 'LIVE' || g.gameState === 'CRIT';
  const final = isCompleted(g);
  return {
    gameId:       g.id,
    gameDate:     g.gameDate || null,
    startTimeUTC: g.startTimeUTC || null,
    gameType:     g.gameType ?? null,   // 1 preseason, 2 regular, 3 playoffs
    homeTeamCode: g.homeTeam?.abbrev,
    awayTeamCode: g.awayTeam?.abbrev,
    homeScore:    g.homeTeam?.score,
    awayScore:    g.awayTeam?.score,
    status:       final ? 'final' : live ? 'live' : 'pre',
    period:         live ? (g.periodDescriptor?.number ?? g.period ?? null) : null,
    periodType:     live ? (g.periodDescriptor?.periodType || null) : null,
    clock:          live ? (g.clock?.timeRemaining || null) : null,
    inIntermission: live ? !!g.clock?.inIntermission : false,
    // "OT"/"SO" for a game that didn't end in regulation, else null.
    endedIn: final
      ? (g.gameOutcome?.lastPeriodType && g.gameOutcome.lastPeriodType !== 'REG'
          ? g.gameOutcome.lastPeriodType : null)
      : null,
    broadcasts: scoreboardBroadcasts(g.tvBroadcasts),
  };
}

// TV networks for a scoreboard card, national first, then away, then home
// (the order a viewer outside either market would care about them), one
// entry per network name. `market` is NHL's own N/A/H code; countryCode
// lets the card tell a US national (NHLN) from a Canadian one (SN).
const BROADCAST_MARKET_ORDER = { N: 0, A: 1, H: 2 };
export function scoreboardBroadcasts(tvBroadcasts) {
  const seen = new Set();
  return (tvBroadcasts || [])
    .filter(b => b?.network)
    .sort((a, b) =>
      (BROADCAST_MARKET_ORDER[a.market] ?? 3) - (BROADCAST_MARKET_ORDER[b.market] ?? 3)
      || (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))
    .filter(b => !seen.has(b.network) && seen.add(b.network))
    .map(b => ({ network: b.network, market: b.market || null, countryCode: b.countryCode || null }));
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

  // Prune expired subs from full list. subId() covers both Web Push
  // (endpoint-keyed) and native iOS (token-keyed) subscribers -- endpoint
  // alone used to miss every expired iOS sub silently.
  const expiredIds = new Set(
    targets.filter((_, i) => results[i] === 'expired').map(subId)
  );
  if (expiredIds.size > 0) {
    const active = subs.filter(s => !expiredIds.has(subId(s)));
    await kvPut(env, 'push:subs', active, 365 * 24 * 3600);
    console.log(`broadcast: removed ${expiredIds.size} expired subscription(s)`);
  }
  console.log(`broadcast results: ${results.join(', ')}`);
}

// Body of the goal-against push, for the team that conceded. Framed by what
// the goal did to the game, which needs the score before it too: a goal that
// puts a team up 3-1 used to read "FLA takes the lead" whatever the score was
// going in, even when FLA had led all along.
export function oppGoalBody(scoringAbbr, scoringScore, otherScore, scoringScoreBefore) {
  if (scoringScore === otherScore) return `${scoringAbbr} ties it up — stay sharp!`;
  if (scoringScore < otherScore) return 'Still leading — hold the line!';
  if (scoringScoreBefore > otherScore) {
    return scoringScore - otherScore >= 3
      ? `${scoringAbbr} is pulling away. Time to push back!`
      : `${scoringAbbr} extends their lead. Time to push back!`;
  }
  return `${scoringAbbr} takes the lead. Time to push back!`;
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
  // Sent when the intermission starts. It used to wait for the NEXT period
  // to begin (the first moment periodDescriptor moved on), so "End of P1"
  // landed ~18 minutes late, alongside "P2 Starting". Still sent then as a
  // fallback, if no poll happened to catch the intermission itself.
  const periodEndSent = lastState.periodEndSent ?? 0;
  let endedPeriod = null;
  if (lastState.started && periodEndSent < period && periodIsOver(pbp, period, game, homeScore, awayScore)) {
    endedPeriod = period;
  } else if (lastState.started && lastState.period > periodEndSent && period > lastState.period) {
    endedPeriod = lastState.period;
  }
  if (endedPeriod) {
    for (const [abbr, myScore, oppScore, oppAbbr] of [
      [homeAbbr, homeScore, awayScore, awayAbbr],
      [awayAbbr, awayScore, homeScore, homeAbbr],
    ]) {
      await notify(abbr, {
        title: `🔔 End of ${periodLabel(endedPeriod)}`,
        body:  `${abbr} ${myScore}–${oppScore} ${oppAbbr} after ${periodLabel(endedPeriod)}`,
        tag:   `period-end-${liveId}-${endedPeriod}`,
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
      body:  oppGoalBody(scoringAbbr, scoringScore, otherScore, lastScoringScore),
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
    periodEndSent: Math.max(periodEndSent, endedPeriod || 0),
  }, 24 * 3600);
}

// Is `period` over, with play still to come (i.e. an intermission, not the
// end of the game)? Read off the feed's own period-end play for that period
// rather than clock.inIntermission, which doesn't say WHICH period ended. A
// period that ends the game is left to the win/loss push: regulation or OT
// ending with a leader, or a regular-season shootout.
export function periodIsOver(pbp, period, game, homeScore, awayScore) {
  const ended = (pbp?.plays || [])
    .some(p => p.typeDescKey === 'period-end' && p.periodDescriptor?.number === period);
  if (!ended) return false;
  if ((pbp?.plays || []).some(p => p.typeDescKey === 'game-end')) return false;
  if (period >= 3 && homeScore !== awayScore) return false;
  if (period >= 5 && game?.gameType !== 3) return false;
  return true;
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

  const aiResponse = await generateText(env, {
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
  {
    // RotoWire — league-wide transaction/injury feed, filtered per team at
    // runtime. Added 2026-09 after a tester reported a real trade (Devils
    // acquiring Luke Evangelista) missing from news: NHL.com's own RSS
    // feeds are dead (redirect to a 404 page, confirmed live), and this
    // was the only candidate of several checked whose live feed actually
    // carried that exact trade within hours -- it's built for fast,
    // granular per-player transaction items (trades/injuries/roster
    // moves), which is exactly the gap the other sources (built for full
    // articles, not one-line transaction bites) had.
    id:        'rotowire',
    name:      'RotoWire',
    color:     '#1a5fb4',
    url:       'https://www.rotowire.com/rss/news.php?sport=NHL',
    type:      'rss',
    filterKey: 'team',
  },
];

// Team-specific news sources — keyed by team abbrev. One beat/fan-blog per
// team where a real, working feed exists. Reddit was removed entirely
// (Session: news ingestion investigation) -- it blocks both Cloudflare
// Workers *and* GitHub Actions runner IPs (confirmed live against a real
// GH Actions runner: HTTP 403 bot-block page), so every reddit-type source
// that used to live here was permanently unfetched dead weight, not a
// working source with an occasional gap.
//
// Two delivery mechanisms:
//   type: 'rss'  — fetched directly by this Worker. Used for "Nation
//                  Network" blogs (flamesnation.ca, oilersnation.com,
//                  canucksarmy.com, theleafsnation.com, jetsnation.ca) --
//                  confirmed reachable from Cloudflare IPs.
//   type: 'atom' — NOT fetched by this Worker at all (see the `continue`
//                  in fetchNews() below); relies on GitHub Actions to fetch
//                  and POST to /atom/ingest instead. Used for every
//                  SBNation/Vox Media blog -- confirmed those block
//                  Cloudflare datacenter IPs but not GH-hosted runners.
//                  Despite the name, `type: 'atom'` sources can be either
//                  true Atom XML (the five original current.xml-path
//                  feeds) or plain RSS 2.0 (the newer /feed/-path ones) --
//                  /atom/ingest auto-detects which per source, see below.
//
// MIN, STL, SEA, and UTA have no working blog source (MIN's Hockey
// Wilderness site exists but its RSS path 404s; STL's St. Louis Game Time
// failed to connect from both a live GH Actions runner and local testing;
// SEA and UTA are too new for an established independent fan-blog
// network) -- these four fall back to the generic league-wide sources
// only, same as every team does for its non-blog news.
const TEAM_NEWS_SOURCES = {
  ANA: [
    { id: 'anaheimcalling',    name: 'Anaheim Calling',        color: '#f47a38', url: 'https://www.anaheimcalling.com/feed/',                  type: 'atom'   },
  ],
  BOS: [
    { id: 'stanleycupofchowder', name: 'Stanley Cup of Chowder', color: '#fcb514', url: 'https://www.stanleycupofchowder.com/rss/index.xml',   type: 'atom'   },
  ],
  BUF: [
    { id: 'diebytheblade',     name: 'Die by the Blade',       color: '#003e7e', url: 'https://www.diebytheblade.com/feed/',                   type: 'atom'   },
  ],
  CGY: [
    { id: 'flamesnation',      name: 'Flames Nation',          color: '#d2122e', url: 'https://flamesnation.ca/feed/',                         type: 'rss'    },
  ],
  CAR: [
    { id: 'canescountry',      name: 'Canes Country',          color: '#cc2200', url: 'https://www.canescountry.com/rss/current.xml',          type: 'atom'   },
  ],
  CHI: [
    { id: 'secondcityhockey',  name: 'Second City Hockey',     color: '#cf0a2c', url: 'https://www.secondcityhockey.com/feed/',                type: 'atom'   },
  ],
  COL: [
    { id: 'milehighhockey',    name: 'Mile High Hockey',       color: '#6f263d', url: 'https://www.milehighhockey.com/rss/current.xml',        type: 'atom'   },
  ],
  CBJ: [
    { id: 'jacketscannon',     name: 'The Cannon',             color: '#002654', url: 'https://www.jacketscannon.com/feed/',                   type: 'atom'   },
  ],
  DAL: [
    { id: 'defendingbigd',     name: 'Defending Big D',        color: '#006847', url: 'https://www.defendingbigd.com/feed/',                   type: 'atom'   },
  ],
  DET: [
    { id: 'wingingitinmotown', name: 'Winging It In Motown',   color: '#ce1126', url: 'https://www.wingingitinmotown.com/feed/',               type: 'atom'   },
  ],
  EDM: [
    { id: 'oilersnation',      name: 'Oilers Nation',          color: '#fc4c02', url: 'https://oilersnation.com/feed/',                        type: 'rss'    },
  ],
  FLA: [
    { id: 'litterboxcats',     name: 'Litter Box Cats',        color: '#c8102e', url: 'https://www.litterboxcats.com/feed/',                   type: 'atom'   },
  ],
  LAK: [
    { id: 'jewelsfromthecrown', name: 'Jewels From The Crown', color: '#111111', url: 'https://www.jewelsfromthecrown.com/feed/',              type: 'atom'   },
  ],
  MIN: [],
  MTL: [
    { id: 'eyesontheprize',    name: 'Eyes On The Prize',      color: '#af1e2d', url: 'https://www.eyesontheprize.com/rss/current.xml',        type: 'atom'   },
  ],
  NSH: [
    { id: 'ontheforecheck',    name: 'On the Forecheck',       color: '#ffb81c', url: 'https://www.ontheforecheck.com/feed/',                  type: 'atom'   },
  ],
  NJD: [
    { id: 'allaboutthejersey', name: 'All About The Jersey',   color: '#ce1126', url: 'https://www.allaboutthejersey.com/rss/current.xml',     type: 'atom'   },
  ],
  NYI: [
    { id: 'lighthousehockey',  name: 'Lighthouse Hockey',      color: '#00539b', url: 'https://www.lighthousehockey.com/rss/current.xml',      type: 'atom'   },
  ],
  NYR: [
    { id: 'blueshirtbanter',   name: 'Blueshirt Banter',       color: '#0038a8', url: 'https://www.blueshirtbanter.com/rss/',                  type: 'atom'   },
  ],
  OTT: [
    { id: 'silversevensens',   name: 'Silver Seven',           color: '#c52128', url: 'https://www.silversevensens.com/rss/',                  type: 'atom'   },
  ],
  PHI: [
    { id: 'broadstreethockey', name: 'Broad Street Hockey',    color: '#f74902', url: 'https://www.broadstreethockey.com/feed/',               type: 'atom'   },
  ],
  PIT: [
    { id: 'pensburgh',         name: 'PensBurgh',              color: '#fcb514', url: 'https://www.pensburgh.com/rss/current.xml',             type: 'atom'   },
  ],
  SEA: [],
  SJS: [
    { id: 'fearthefin',        name: 'Fear The Fin',           color: '#006d75', url: 'https://www.fearthefin.com/feed/',                      type: 'atom'   },
  ],
  STL: [],
  TBL: [
    { id: 'rawcharge',         name: 'Raw Charge',             color: '#002868', url: 'https://www.rawcharge.com/feed/',                       type: 'atom'   },
  ],
  TOR: [
    { id: 'theleafsnation',    name: 'The Leafs Nation',       color: '#003e7e', url: 'https://theleafsnation.com/feed',                       type: 'rss'    },
  ],
  UTA: [],
  VAN: [
    { id: 'canucksarmy',       name: 'Canucks Army',           color: '#00843d', url: 'https://canucksarmy.com/feed',                          type: 'rss'    },
  ],
  VGK: [
    { id: 'knightsonice',      name: 'Knights On Ice',         color: '#b4975a', url: 'https://www.knightsonice.com/feed/',                    type: 'atom'   },
  ],
  WSH: [
    { id: 'japersrink',        name: "Japers' Rink",           color: '#041e42', url: 'https://www.japersrink.com/feed/',                      type: 'atom'   },
  ],
  WPG: [
    { id: 'jetsnation',        name: 'Jets Nation',            color: '#041e42', url: 'https://jetsnation.ca/feed',                            type: 'rss'    },
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

export async function fetchNews(env, teamAbbr = TEAM_ABBR) {
  const allItems = [];
  const sources  = getNewsSources(teamAbbr);

  for (const source of sources) {
    // SBNation atom feeds are fetched by GitHub Actions (CF Workers IPs
    // are blocked there). GH Actions POSTs to /atom/ingest periodically.
    if (source.type === 'atom') continue;
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
        await recordHealth(env, `nhl:${source.id}`, false, { error: `HTTP ${res.status}` });
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
      await recordHealth(env, `nhl:${source.id}`, true, { itemCount: parsed.length });
    } catch (err) {
      console.warn(`News: ${source.id} error: ${err.message} ${err.stack?.slice(0,100)}`);
      await recordHealth(env, `nhl:${source.id}`, false, { error: err.message });
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

// ── Main poll ─────────────────────────────────────────────────


// ── Live Activities (iOS lock-screen game tracker) ───────────
// The app starts an activity for a game and registers its push token
// (POST /live-activity/register); poll() then pushes every change to it and
// ends it at the final. Tokens live per game in `la:tokens:{gameId}`.
const LA_TOKEN_TTL = 8 * 3600;
const LA_MAX_TOKENS = 1000;

function periodLabelFor(num, periodType, gameType) {
  if (!num) return '';
  if (num <= 3) return ['1st', '2nd', '3rd'][num - 1];
  if (periodType === 'SO' || (gameType !== 3 && num >= 5)) return 'SO';
  return num === 4 ? 'OT' : `${num - 3}OT`;
}

// The Live Activity's ContentState. Keys must match GameActivityAttributes
// .ContentState in eyewall-analytics (ios/App/EyeWallLiveActivity) -- the
// app decodes this JSON straight into it.
export function liveActivityState(game, pbp, { final = false } = {}) {
  const homeAbbr = game.homeTeam?.abbrev, awayAbbr = game.awayTeam?.abbrev;
  const homeId = game.homeTeam?.id;
  const pd = pbp?.periodDescriptor || game.periodDescriptor || {};
  const plays = pbp?.plays || [];
  const inIntermission = !final && !!pbp?.clock?.inIntermission;
  const periodLabel = periodLabelFor(pd.number, pd.periodType, game.gameType);

  const names = {};
  for (const r of pbp?.rosterSpots || []) names[r.playerId] = r.lastName?.default || '';
  const teamOf = p => (p.details?.eventOwnerTeamId === homeId ? homeAbbr : awayAbbr);

  let lastEvent = null;
  const last = [...plays].reverse().find(p => p.typeDescKey === 'goal' || p.typeDescKey === 'penalty');
  if (last) {
    const d = last.details || {};
    const when = `${periodLabelFor(last.periodDescriptor?.number, last.periodDescriptor?.periodType, game.gameType)} ${last.timeInPeriod || ''}`.trim();
    if (last.typeDescKey === 'goal') {
      const who = names[d.scoringPlayerId] || '';
      lastEvent = `GOAL · ${teamOf(last)} · ${who}${d.scoringPlayerTotal ? ` (${d.scoringPlayerTotal})` : ''} · ${when}`;
    } else {
      const who = names[d.committedByPlayerId] || names[d.servedByPlayerId] || '';
      const what = (d.descKey || 'penalty').replace(/-/g, ' ');
      lastEvent = `PEN · ${teamOf(last)}${who ? ` · ${who}` : ''} · ${d.duration || 2} min ${what}`;
    }
  }

  // Strength from the latest play's situationCode: [awayG][awayS][homeS][homeG]
  let strength = null;
  const sc = plays[plays.length - 1]?.situationCode;
  if (!final && !inIntermission && sc?.length === 4) {
    const awayG = sc[0] === '1', awayS = +sc[1], homeS = +sc[2], homeG = sc[3] === '1';
    if (!awayG) strength = `${awayAbbr} 6v5`;
    else if (!homeG) strength = `${homeAbbr} 6v5`;
    else if (homeS !== awayS) {
      const [pp, big, small] = homeS > awayS ? [homeAbbr, homeS, awayS] : [awayAbbr, awayS, homeS];
      strength = `${pp} PP${big - small >= 2 ? ` ${big}v${small}` : ''}`;
    }
  }

  return {
    homeScore: game.homeTeam?.score ?? 0,
    awayScore: game.awayTeam?.score ?? 0,
    periodLabel: final && game.gameOutcome?.lastPeriodType && game.gameOutcome.lastPeriodType !== 'REG'
      ? game.gameOutcome.lastPeriodType : periodLabel,
    clock: pbp?.clock?.timeRemaining || '',
    inIntermission,
    status: final ? 'final' : 'live',
    lastEvent,
    strength,
  };
}

// Pushes `state` to every activity registered for the game, if it changed.
// Score/period/event changes go at priority 10 (shown right away); a
// clock-only change goes at 5. Tokens Apple says are dead are dropped.
async function pushLiveActivities(env, gameId, state, { end = false } = {}) {
  const tokens = (await kvGet(env, `la:tokens:${gameId}`)) || [];
  if (!tokens.length) return;
  const lastKey = `la:last:${gameId}`;
  const last = await kvGet(env, lastKey);
  if (!end && last && JSON.stringify(last) === JSON.stringify(state)) return;
  const withoutClock = st => JSON.stringify({ ...st, clock: null });
  const priority = end || !last || withoutClock(state) !== withoutClock(last) ? 10 : 5;
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.all(tokens.map(t => sendLiveActivityPush(t, {
    event: end ? 'end' : 'update',
    state,
    priority,
    staleDate: end ? undefined : now + 5 * 60,
    dismissalDate: end ? now + 30 * 60 : undefined,
  }, env)));
  const alive = tokens.filter((_, i) => results[i] !== 'expired');
  if (alive.length !== tokens.length) await kvPut(env, `la:tokens:${gameId}`, alive, LA_TOKEN_TTL);
  await kvPut(env, lastKey, state, LA_TOKEN_TTL);
}

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

  // 3. Live PBP + boxscore + push notifications, once per live game.
  // TTL is three cron ticks, not one: at 60s (the cron's own interval) a
  // key could lapse just before the next tick rewrote it, and every open
  // app then fell back to fetching that game from the NHL directly. The
  // cron still overwrites it every minute, so it's never staler than that.
  const LIVE_GAME_TTL = 180;
  for (const liveGame of liveGames) {
    const liveId = liveGame.id;
    const [pbpRes, bsRes] = await Promise.allSettled([
      nhlGet(`${NHL_BASE}/gamecenter/${liveId}/play-by-play`),
      nhlGet(`${NHL_BASE}/gamecenter/${liveId}/boxscore`),
    ]);
    if (pbpRes.status === 'fulfilled') {
      const pbpData = pbpRes.value;
      await kvPut(env, `pbp:${liveId}`, pbpData, LIVE_GAME_TTL);
      await pushLiveActivities(env, liveId, liveActivityState(liveGame, pbpData)).catch(e =>
        console.error(`Live Activity push error (game ${liveId}):`, e.message)
      );
      // Detect goals + events and send push notifications
      if (env.VAPID_PRIVATE_KEY) {
        await detectAndNotify(env, liveGame, pbpData).catch(e =>
          console.error(`Push notification error (game ${liveId}):`, e.message)
        );
      }
    }
    if (bsRes.status === 'fulfilled') {
      await kvPut(env, `boxscore:${liveId}`, bsRes.value, LIVE_GAME_TTL);
    }
  }

  // Final PBP + boxscore for every game that finished today, once each.
  // Replaces the last live snapshot (which, at LIVE_GAME_TTL, would
  // otherwise be what the app read for up to three minutes after the
  // final), and keeps the finished game in KV for the post-game crowd
  // instead of every open app fetching it from the NHL.
  for (const game of completedToday) {
    const doneKey = `pbp:final:${game.id}`;
    if (await env.CACHE.get(doneKey)) continue;
    const [p, b] = await Promise.allSettled([
      nhlGet(`${NHL_BASE}/gamecenter/${game.id}/play-by-play`),
      nhlGet(`${NHL_BASE}/gamecenter/${game.id}/boxscore`),
    ]);
    if (p.status === 'fulfilled') await kvPut(env, `pbp:${game.id}`, p.value, 3600);
    if (b.status === 'fulfilled') await kvPut(env, `boxscore:${game.id}`, b.value, 3600);
    if (p.status === 'fulfilled' && b.status === 'fulfilled') await kvPut(env, doneKey, true, 24 * 3600);
    // Final score to any lock-screen Live Activity, which then ends
    await pushLiveActivities(env, game.id, liveActivityState(game, p.status === 'fulfilled' ? p.value : null, { final: true }), { end: true })
      .catch(e => console.error(`Live Activity end error (game ${game.id}):`, e.message));
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

  // 4. Standings — only once the 5-min cache has lapsed, not every tick.
  // They only move when a game ends, and a per-minute rewrite cost a KV
  // write a minute for nothing.
  if (!(await env.CACHE.get('standings'))) {
    const standings = await nhlGet(`${NHL_BASE}/standings/now`);
    await kvPut(env, 'standings', standings?.standings || [], 300);
  }

  // 5. (Team-stats fetch removed 2026-09 -- nothing ever read the
  // teamstats:{ABBR} key it wrote every minute.)

  // 6. (Sportsbook odds fetch removed 2026-09 -- the app shows no betting content.)

  // 7. News (every 30min — TTL handles rate limiting)
  const newsAge = await env.CACHE.getWithMetadata(`news:${TEAM_ABBR}`);
  if (!newsAge.value) await fetchNews(env).catch(e => console.warn('News fetch failed:', e.message));

  // MoneyPuck analytics are populated via POST /moneypuck/ingest from GitHub Actions.
  // Cloudflare Workers IPs are blocked by MoneyPuck; GH-hosted runners are not.
  // The cron no longer attempts to fetch — it would always 403.
  // Checked once an hour rather than every tick: it's 32 KV reads that
  // only feed this log line.
  if (new Date().getUTCMinutes() === 0) {
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

// Cache-first: scheduled() calls this every minute, but special_teams_units
// only changes when the nightly pipeline runs, so a warm pp_units:{season}
// is returned as-is instead of re-reading Supabase and rewriting KV each
// tick. { force: true } re-reads regardless (/pp-units/refresh, after a
// pipeline run).
//
// Season-scoped rather than the one flat pp_units:all key this used to
// write: the shot map can be showing a season other than the current one
// (its off-season fallback, or anything picked from the season chips), and
// the units it labels those games with have to be that season's -- one key
// can only ever hold one season. Callers that just want "now" omit
// `season` and get the resolved current one, as before.
export async function refreshPPUnits(env, { force = false, season } = {}) {
  const seasonId = season || String(await resolveNHLSeason(env));
  const key = `pp_units:${seasonId}`;
  if (!force) {
    const cached = await kvGet(env, key);
    if (cached) return cached;
  }
  const r = await fetch(
    `${SB_URL}/rest/v1/special_teams_units` +
    `?season=eq.${seasonId}&select=team,unit_type,unit_number,player_ids&limit=256`,
    { headers: sbHeaders() }
  );
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  const rows = await r.json();

  // Build nested map: { CAR: { PP: { 1: [...], 2: [...] }, PK: { ... } } }
  const map = {};
  for (const row of rows) {
    if (!map[row.team]) map[row.team] = { PP: {}, PK: {} };
    map[row.team][row.unit_type][row.unit_number] = row.player_ids;
  }

  await kvPut(env, key, map, 4 * 60 * 60); // 4 hour TTL
  return map;
}


export async function handleNHL(request, env, ctx, url) {

  // Manual news refresh (protected)
  if (url.pathname === '/news/refresh') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return unauthorized();
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

  // GET /roster?team=CAR
  // Proxies NHL's /roster/{team}/current, cached in KV. Synchronous
  // fetch-and-cache-on-miss (mirrors /schedule's historical-season branch
  // above, not its current-season fire-and-forget pattern) -- this is a
  // foreground page (the Players view's Roster tab), not a background
  // feed nothing else keeps warm, so a cold-miss user needs real data
  // now, not an empty response with a silent retry-later.
  //
  // Added after this exact endpoint's client-side equivalent
  // (eyewallanalytics's getRoster(), which calls /roster/{team}/current
  // directly with zero caching) was identified as the root cause of
  // repeated Cypress flakiness -- every CI run was a genuinely fresh
  // live NHL fetch for 4 teams, with nothing to fall back on but the
  // real API's own response time. getAllGames()/getStandings() already
  // had this KV-first protection; getRoster() was the one gap.
  if (url.pathname === '/roster' && request.method === 'GET') {
    const tc = await getTeamConfig(request, env);
    return cachedJson(env, rosterKey(tc.abbr), ROSTER_TTL, async () => {
      try {
        return await nhlGet(`${NHL_BASE}/roster/${tc.abbr}/current`);
      } catch (e) {
        console.warn(`Roster fetch ${tc.abbr}: ${e.message}`);
        return json({ forwards: [], defensemen: [], goalies: [] }); // not cached
      }
    });
  }

  // GET /nhl/today
  // Returns all NHL games scheduled for today with status pre/live/final.
  // Same normalized shape as /pwhl/today, /ahl/today, /echl/today, but
  // sourced straight from the league-wide score/now scoreboard (poll()'s
  // step 2 above) instead of a Supabase game_log table — the NHL API
  // already returns real team abbrevs and scores, no team-code map needed.
  if (url.pathname === '/nhl/today' && request.method === 'GET') {
    // 60s TTL — matches poll()'s live cadence
    return cachedJson(env, 'nhl:today', 60, async () => {
      let scoreboard;
      try {
        scoreboard = await nhlScoreboardForDisplay(etDateString());
      } catch (e) {
        return errorJson(502, { error: e.message });
      }
      const games = (scoreboard?.games || []).map(g => normalizeScoreboardGame(g));

      return games;
    });
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

  if (url.pathname === '/player-analytics') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    return cachedJson(env, `nhl:player-analytics:${season}`, 3600, async () => {
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
          sbRowsOrThrow(`player_seasons?season=eq.${forSeason}&game_type=eq.2&war=not.is.null&select=${ANA_COLS}&limit=2000`),
          sbRowsOrThrow(`player_seasons?season=eq.${forSeason}&game_type=eq.3&select=${DEF_COLS}&limit=2000`).catch(() => []),
        ]);
        return { rows, poRows };
      }

      let rows, poRows;
      try {
        ({ rows, poRows } = await fetchAnalytics(season));
      } catch (e) {
        return errorJson(502, { error: e.message });
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
      return result;
    });
  }

  if (url.pathname === '/player-shots') {
    const playerId = url.searchParams.get('playerId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const team     = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    if (!playerId) return badRequest('playerId required');

    return cachedJson(env, `nhl:player-shots:${playerId}:${season}:${team}`, 3600, async () => {
      // No car_game filter: that column only means "Carolina played in this
      // game" (see eyewall-pipeline's shot_events.py), so filtering on it here
      // silently restricted every non-CAR player's shots to games against
      // Carolina. player_id + team already scope correctly on their own — a
      // player only shoots for one team per row.
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `shot_events?player_id=eq.${playerId}&season=eq.${season}` +
          `&team=eq.${team}` +
          `&select=x,y,event_type,period,time_in_period,shot_type&limit=2000`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
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
    return cachedJson(env, `nhl:shots:${team}:${season}`, 3600, async () => {
      let gameIds;
      try {
        const schedule = await nhlGet(`${NHL_BASE}/club-schedule-season/${team}/${season}`);
        gameIds = (schedule?.games || []).filter(isCompleted).map(g => g.id);
      } catch (e) {
        return errorJson(502, { error: e.message });
      }
      if (!gameIds.length) return [];

      const PAGE = 1000;
      const allRows = [];
      let offset = 0;
      while (true) {
        const rows = await sbRows(
          `${SB_URL}/rest/v1/shot_events?game_id=in.(${gameIds.join(',')})&season=eq.${season}` +
          `&select=game_id,team,x,y,event_type,period,time_in_period,shot_type&order=game_id.asc`,
          { 'Range': `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items', 'Prefer': 'count=none' }
        );
        if (rows instanceof Response) return rows;
        allRows.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }

      console.log(`NHL shots: team=${team} season=${season} games=${gameIds.length} total=${allRows.length}`);
      return allRows;
    });
  }

  if (url.pathname === '/goalie-shots') {
    const goalieId = url.searchParams.get('goalieId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    if (!goalieId) return badRequest('goalieId required');

    return cachedJson(env, `nhl:goalie-shots:${goalieId}:${season}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `shot_events?goalie_id=eq.${goalieId}&season=eq.${season}` +
          `&select=x,y,event_type,period,time_in_period,shot_type,team&limit=2000`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
  }

  if (url.pathname === '/goalie-analytics') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    return cachedJson(env, `nhl:goalie-analytics:${season}`, 3600, async () => {
      const GOALIE_COLS = 'player_id,team,games_played,gsax,gsax_per60,qs_pct,qs,' +
        'ev_sv_pct,hd_sv_pct,md_sv_pct,pk_sv_pct,' +
        'pct_gsax,pct_gsax60,pct_ev_sv,pct_hd_sv,pct_md_sv,pct_pk_sv';

      async function fetchGoalieAnalytics(forSeason) {
        return sbRowsOrThrow(
          `goalie_seasons?season=eq.${forSeason}&game_type=eq.2&gsax=not.is.null&select=${GOALIE_COLS}`
        );
      }

      let rows;
      try {
        rows = await fetchGoalieAnalytics(season);
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      // Whole-season-empty fallback (mirrors /player-analytics's Session 66
      // fix, ported here 2026-08 -- this route never had it, which meant
      // EVERY goalie showed "analytics not yet available" for the entire
      // gap between a live season flip and that season's first real games,
      // not just goalies genuinely below the GP floor). Same reasoning: the
      // live season can resolve ahead of any real games (schedule released
      // before puck drop), leaving `gsax=not.is.null` match nothing for it --
      // not a per-goalie gap, so falling back to a whole prior season's rows
      // is correct. Flagged via statsStale/statsSeason, not silent.
      let statsStale = false;
      let statsSeason = null;
      if (rows.length === 0) {
        const priorSeason = String(Number(season) - 10001); // 20262027 -> 20252026
        try {
          const fallback = await fetchGoalieAnalytics(priorSeason);
          if (fallback.length > 0) {
            rows = fallback;
            statsStale = true;
            statsSeason = priorSeason;
          }
        } catch {
          // Fallback query itself failed -- degrade to the empty live-season
          // result rather than failing the whole request over it.
        }
      }

      const result = { rows, statsStale, statsSeason };
      return result;
    });
  }

  if (url.pathname === '/team-lines') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    return cachedJson(env, `nhl:team-lines:${team}:${season}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `line_combinations?team=eq.${team}&season=eq.${season}` +
          `&order=unit_type.asc,rank.asc` +
          `&select=unit_type,rank,name_a,name_b,name_c,pos_a,pos_b,pos_c,toi_secs,xgf_pct`
        );
      } catch {
        rows = []; // matches supabaseClient.js's own .catch(() => []) — frontend falls back to static lines
      }

      return rows;
    });
  }

  // GET /injuries?team=CAR
  // Proxies the pipeline's player_injuries table (injuries.py, ESPN's
  // injuries feed -- the NHL API itself has no injuries/scratches
  // endpoint at all, see that module's own docstring for the full
  // investigation). Same KV-cache-then-Supabase-read shape as
  // /team-lines above; unlike that route, not season-scoped -- injuries
  // aren't a per-season concept the way lines are, this table is always
  // just "current league-wide state," fully refreshed on every pipeline
  // run. Scoped to one team per call (not a league-wide dump) since the
  // one real consumer so far, the Scouting tab, always wants exactly two
  // teams' worth -- the user's and the opponent's -- fetched separately.
  // injury_type/injury_side/injury_detail/return_date come from ESPN's
  // per-entry `details` object (eyewall-pipeline's
  // docs/session_injury_details_history.sql) -- any of the four can be null.
  if (url.pathname === '/injuries') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    return cachedJson(env, `nhl:injuries:${team}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `player_injuries?team=eq.${team}` +
          `&select=player_id,player_name,status,comment,espn_updated_at,` +
          `injury_type,injury_side,injury_detail,return_date`
        );
      } catch {
        rows = []; // same "degrade to empty, don't 502" posture as /team-lines
      }

      return rows;
    });
  }

  // GET /transactions?team=CAR      -- that team's moves: its own entries, plus
  //                                    trades naming it that it has no entry for
  // GET /transactions?scope=league  -- league-wide recent moves
  // Proxies eyewall-pipeline's nhl_transactions table (transactions.py, from
  // ESPN's NHL transactions feed -- the NHL API has none). ESPN posts each side
  // of a trade as its own entry, so pairTransactions() (src/transactions.js)
  // merges the two halves into one { kind: 'trade' } item before responding.
  // 1hr KV cache, same class as /injuries. Unlike /injuries, a Supabase read
  // failure degrades to an empty list WITHOUT caching it, so a transient
  // outage doesn't pin an empty feed for the full hour. `team` is validated
  // before it's interpolated into the PostgREST `or=` filter string.
  if (url.pathname === '/transactions') {
    const scope = url.searchParams.get('scope') === 'league' ? 'league' : 'team';
    const team  = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    if (scope === 'team' && !/^[A-Z]{2,3}$/.test(team)) {
      return badRequest('invalid team');
    }
    const focusTeam = scope === 'team' ? team : null;
    const kvKey  = scope === 'league' ? 'nhl:transactions:league' : `nhl:transactions:team:${team}`;
    return cachedJson(env, kvKey, 3600, async () => {
      const select = 'id,tx_date,team,description,categories,primary_category,counterparties';
      const filter = scope === 'team' ? `&or=(team.eq.${team},counterparties.cs.%7B${team}%7D)` : '';
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `nhl_transactions?select=${select}${filter}&order=tx_date.desc,id.desc&limit=${TRANSACTIONS_LIMIT}`
        );
      } catch {
        return json({ scope, team: focusTeam, items: [] });
      }

      const data = { scope, team: focusTeam, items: pairTransactions(rows, { focusTeam }) };
      return data;
    });
  }

  // GET /trades/tree?tx=<nhl_transactions id>
  // The trade containing that transaction row (an id from /transactions'
  // items) and where every asset went next -- eyewall-pipeline's trades /
  // trade_assets (trade_trees.py, nightly: ESPN's trade text parsed, picks
  // resolved to the drafted player via the NHL's draft records, each asset
  // linked to the next trade it went out in). Walked by fetchTradeTree()
  // (src/trades.js), a few levels deep plus the trades that brought the
  // root's outgoing assets in. Response: { found, root, trades: { id: trade },
  // origins, truncated }. `tx` must be digits (400 otherwise -- it's
  // interpolated into the PostgREST filter). 1hr KV; neither a failed read
  // (`unavailable: true`) nor a not-found is cached.
  if (url.pathname === '/trades/tree') {
    const tx = url.searchParams.get('tx') || '';
    if (!/^\d{1,12}$/.test(tx)) {
      return badRequest('invalid tx');
    }
    return cachedJson(env, `nhl:trades:tree:${tx}`, 3600, async () => {
      let data;
      try {
        data = await fetchTradeTree(tx, sbRowsOrThrow);
      } catch {
        return json({ found: false, root: null, trades: {}, origins: [], truncated: false, unavailable: true });
      }
      return data.found ? data : json(data); // only a found tree is cached
    });
  }

  // GET /scratches?team=CAR[&season=20262027][&gameType=2]
  // Per-player scratch summary for one team-season, from eyewall-pipeline's
  // game_scratches table (scratches.py: the NHL's own right-rail scratch
  // lists, classified healthy/injured/suspended/unknown against that day's
  // player_injury_history snapshot). gameType 2 (regular season, default) or
  // 3 (playoffs) -- never pooled, since playoff lists run much longer (extra
  // reserve players are carried). With no explicit season and nothing yet
  // for the live one (every offseason/preseason day -- scratches.py skips
  // preseason), falls back to the prior season, flagged via stale/season --
  // the same "carry forward real data, label it" convention as
  // /player-analytics' statsStale. team/season/gameType are all validated
  // before being interpolated into the PostgREST query. 1hr KV; a failed
  // read returns an empty summary and is NOT cached.
  if (url.pathname === '/scratches') {
    const team        = (url.searchParams.get('team') || DEFAULT_TEAM_ABBR).toUpperCase();
    const seasonParam = url.searchParams.get('season');
    const gameType    = url.searchParams.get('gameType') || '2';
    if (!/^[A-Z]{2,3}$/.test(team) || (seasonParam && !/^\d{8}$/.test(seasonParam)) || !['2', '3'].includes(gameType)) {
      return badRequest('invalid team, season, or gameType');
    }
    const season = seasonParam || String(await resolveNHLSeason(env));
    return cachedJson(env, `nhl:scratches:${team}:${seasonParam || 'auto'}:${gameType}`, 3600, async () => {
      const fetchSeason = (s) => sbRowsOrThrow(
        `game_scratches?team=eq.${team}&season=eq.${s}&game_type=eq.${gameType}` +
        `&select=game_id,game_date,player_id,player_name,scratch_type&order=game_date.asc,id.asc&limit=1000`
      );
      let rows;
      let usedSeason = season;
      let stale = false;
      try {
        rows = await fetchSeason(season);
        if (rows.length === 0 && !seasonParam) {
          const prior = String(Number(season) - 10001); // 20262027 -> 20252026
          const fallback = await fetchSeason(prior);
          if (fallback.length > 0) {
            rows = fallback;
            usedSeason = prior;
            stale = true;
          }
        }
      } catch {
        return json({ team, season: Number(season), gameType: Number(gameType), stale: false, ...summarizeScratches([]) });
      }

      const data = { team, season: Number(usedSeason), gameType: Number(gameType), stale, ...summarizeScratches(rows) };
      return data;
    });
  }

  if (url.pathname === '/game-xg') {
    const gameId = url.searchParams.get('gameId');
    if (!gameId) return badRequest('gameId required');

    return cachedJson(env, `nhl:game-xg:${gameId}`, 1800, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(`game_xg?game_id=eq.${gameId}&situation=eq.5on5&select=team,xgf,xga,xgf_pct`);
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
  }

  // Serves both getGameLogInsights and getTeamGameLog on the frontend —
  // same table+filter (team+season), union of both callers' select columns.
  if (url.pathname === '/game-log') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const limit  = url.searchParams.get('limit'); // optional passthrough — omitted means unlimited
    return cachedJson(env, `nhl:game-log:${team}:${season}:${limit || 'all'}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `game_log?season=eq.${season}&team=eq.${team}&order=game_id.asc` +
          `&select=game_id,game_date,opponent,team_score,opp_score,home_team,` +
          `team_scored_first,pp_goals,pp_opps,pk_goals_against,pk_opps,game_type` +
          (limit ? `&limit=${limit}` : '')
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
  }

  if (url.pathname === '/xg-trend') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    return cachedJson(env, `nhl:xg-trend:${team}:${season}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `game_xg?team=eq.${team}&season=eq.${season}&situation=eq.5on5` +
          `&select=game_id,xgf_pct&limit=999`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
  }

  if (url.pathname === '/team-seasons') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    return cachedJson(env, `nhl:team-seasons:${season}`, 3600, async () => {
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
        rows = await sbRowsOrThrow(
          `team_seasons?season=eq.${season}&game_type=eq.2` +
          `&select=team,xgf_pct,roster_war_score,games_played,` +
          `magic_number,tragic_number,clinched,eliminated,hits,penalties&limit=32`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
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

    return cachedJson(env, `nhl:team-seasons:compare:${team}:${seasons.slice().sort().join(',')}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `team_seasons?team=eq.${team}&season=in.(${seasons.join(',')})&game_type=eq.2` +
          `&select=season,games_played,wins,losses,ot_losses,points,goals_for,goals_against,pp_pct,pk_pct`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
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

    return cachedJson(env, `nhl:team-seasons:compare-teams:${teams.slice().sort().join(',')}:${season}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `team_seasons?team=in.(${teams.join(',')})&season=eq.${season}&game_type=eq.2` +
          `&select=team,season,games_played,wins,losses,ot_losses,points,goals_for,goals_against,pp_pct,pk_pct`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
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

    return cachedJson(env, `nhl:team-seasons:head-to-head:${teams.slice().sort().join(',')}`, 3600, async () => {
      let games;
      try {
        games = await sbRowsOrThrow(
          `game_log?team=eq.${teamA}&opponent=eq.${teamB}` +
          `&select=game_id,season,game_date,team_score,opp_score,home_team` +
          `&order=season.asc,game_id.asc`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      const payload = buildHeadToHeadPayload(teamA, teamB, games.map(g => ({
        gameId: g.game_id, season: g.season, gameDate: g.game_date,
        teamAWon: g.team_score > g.opp_score,
        teamAScore: g.team_score, teamBScore: g.opp_score, homeTeam: g.home_team ? teamA : teamB,
      })));

      return payload;
    });
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
      return badRequest('Invalid JSON');
    }
    const {
      teamA, teamB, teamADisplay, teamBDisplay,
      totalMeetings, allTimeRecord, recentWindow, currentStreak, isThinSample,
    } = body || {};
    if (!teamA || !teamB || !totalMeetings || !allTimeRecord || !recentWindow) {
      return json({ narrative: null });
    }

    return cachedJson(env, `nhl:h2h-narrative:${[teamA, teamB].slice().sort().join(',')}`, 24 * 3600, async () => {
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
        const aiResponse = await generateText(env, {
          messages:   [{ role: 'user', content: prompt }],
          max_tokens: 100,
        });
        const narrative = (aiResponse.response || '').trim();
        if (!narrative) return json({ narrative: null });

        return { narrative };
      } catch (e) {
        console.error('[NHL] head-to-head narrative AI error:', e);
        return errorJson(502, { error: 'AI generation failed' });
      }
    });
  }

  // Serves both getPowerRankingsNarrative (limit=1) and getPowerRankingsHistory
  // (limit=28) on the frontend — same table/filter/order, different limit.
  if (url.pathname === '/power-rankings') {
    const team   = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const limit  = Math.min(parseInt(url.searchParams.get('limit') || '28', 10) || 28, 100);
    return cachedJson(env, `nhl:power-rankings:${team}:${season}:${limit}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `power_rankings_narratives?team=eq.${team}&season=eq.${season}` +
          `&order=generated_date.desc&limit=${limit}` +
          `&select=narrative,rank,prior_rank,generated_date`
        );
      } catch {
        rows = [];
      }

      return rows;
    });
  }

  // Serves both getGameMatchup and getGamePrediction on the frontend —
  // same table/filter/row, different text field.
  if (url.pathname === '/game-predictions') {
    const gameId = url.searchParams.get('gameId');
    if (!gameId) return badRequest('gameId required');
    // One row per (game_id, locale) since eyewall-pipeline's
    // docs/session_locale_predictions.sql -- without the filter, limit=1
    // would hand back whichever language Postgres returned first.
    const locale = requestLocale(url);

    return cachedJson(env, `nhl:game-predictions:${gameId}${localeKeySuffix(locale)}`, 1800, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `game_predictions?game_id=eq.${gameId}&locale=eq.${locale}` +
          `&select=matchup_text,prediction_text,generated_at&limit=1`
        );
      } catch {
        rows = [];
      }

      return rows;
    });
  }

  if (url.pathname === '/game-summary') {
    const gameId = url.searchParams.get('gameId');
    const team   = url.searchParams.get('team')?.toUpperCase();
    if (!gameId || !team) return badRequest('gameId and team required');
    // French/English localization, Track B Phase B2 -- defaults to 'en' for
    // any missing/unrecognized value rather than erroring, same posture as
    // this file's existing team/season param handling below. game_summaries
    // rows are keyed on (game_id, team, locale) as of Track B Phase B0/B1
    // (eyewall-pipeline), so this filter is required, not optional, once
    // both locales exist for the same game/team.
    const locale = url.searchParams.get('locale') === 'fr' ? 'fr' : 'en';

    return cachedJson(env, `nhl:game-summary:${gameId}:${team}:${locale}`, 1800, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `game_summaries?game_id=eq.${gameId}&team=eq.${team}&locale=eq.${locale}` +
          `&select=summary_text,card_text,generated_at&limit=1`
        );
      } catch {
        rows = [];
      }

      return rows;
    });
  }

  if (url.pathname === '/player-scouting') {
    const playerId = url.searchParams.get('playerId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    if (!playerId) return badRequest('playerId required');
    const locale = url.searchParams.get('locale') === 'fr' ? 'fr' : 'en'; // Track B Phase B2

    return cachedJson(env, `nhl:player-scouting:${playerId}:${season}:${locale}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `player_scouting?player_id=eq.${playerId}&season=eq.${season}&locale=eq.${locale}` +
          `&select=scouting_text,generated_at&limit=1`
        );
      } catch {
        rows = [];
      }

      return rows;
    });
  }

  if (url.pathname === '/player-results-vs-process') {
    // Session 56 -- mirrors /player-scouting's shape exactly (single-player,
    // single-season lookup) rather than joining into /player-analytics's
    // bulk 2000-row response: the frontend only ever needs one player's
    // blurb at a time (player popup), so a light second lookup fits with
    // less disruption than a bulk join nobody would otherwise use.
    const playerId = url.searchParams.get('playerId');
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    if (!playerId) return badRequest('playerId required');
    const locale = url.searchParams.get('locale') === 'fr' ? 'fr' : 'en'; // Track B Phase B2

    return cachedJson(env, `nhl:player-results-vs-process:${playerId}:${season}:${locale}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `player_narratives?player_id=eq.${playerId}&season=eq.${season}` +
          `&narrative_type=eq.results_vs_process&locale=eq.${locale}` +
          `&select=narrative_text,generated_at&limit=1`
        );
      } catch {
        rows = [];
      }

      return rows;
    });
  }

  if (url.pathname === '/team-skaters') {
    const team     = url.searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
    const season   = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    const gameType = url.searchParams.get('gameType') || '2';
    return cachedJson(env, `nhl:team-skaters:${team}:${season}:${gameType}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `player_seasons?team=eq.${team}&season=eq.${season}&game_type=eq.${gameType}` +
          `&select=player_id,games_played,goals,assists,primary_assists,secondary_assists,` +
          `points,plus_minus,pim,pp_goals,sh_goals,gw_goals,shots,shooting_pct,` +
          `toi_per_game&order=points.desc.nullslast`
        );
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return rows;
    });
  }

  // Full players id/name/position list — paginated server-side the same
  // way supabaseClient.js's fetchAllPlayers() used to do it client-side
  // (Supabase caps responses at 1000 rows; the table has 1346+).
  // Long TTL: names/positions rarely change mid-season.
  if (url.pathname === '/players-list') {
    // 6hr
    return cachedJson(env, 'nhl:players-list', 21600, async () => {
      const pageSize = 1000;
      const all = [];
      let offset = 0;
      while (true) {
        const rows = await sbRows(`${SB_URL}/rest/v1/players?select=id,name,position`, {
          'Range-Unit': 'items', 'Range': `${offset}-${offset + pageSize - 1}`,
        });
        if (rows instanceof Response) return rows;
        if (!Array.isArray(rows) || rows.length === 0) break;
        all.push(...rows);
        if (rows.length < pageSize) break;
        offset += pageSize;
      }

      return all;
    });
  }

  // PP/PK unit compositions — pp_units:{season} is kept warm for the
  // CURRENT season by refreshPPUnits() on every scheduled() tick, so that
  // case is normally a pure KV read. The inline refresh below covers a
  // cold cache (first deploy, KV namespace wiped) and, now that ?season=
  // is accepted, any past season the ticker never warms — the first
  // request for one pays a single Supabase read and caches it for 4h.
  if (url.pathname === '/special-teams') {
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    let map = await kvGet(env, `pp_units:${season}`);
    if (!map) {
      try {
        map = await refreshPPUnits(env, { season });
      } catch (e) {
        return errorJson(502, { error: e.message });
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

  // Push subscribe — Web Push (endpoint+keys) or, as of 2026-09, native iOS
  // (platform: 'ios' + an APNs device token) share this one route and the
  // one push:subs KV array; sendPush()/broadcast() branch on sub.platform.
  // POST /live-activity/register { gameId, token } -- the iOS app's Live
  // Activity push token for one game (see pushLiveActivities()).
  if (url.pathname === '/live-activity/register' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return badRequest('invalid JSON'); }
    const gameId = Number(body?.gameId);
    const token = String(body?.token || '');
    if (!Number.isInteger(gameId) || gameId <= 0) return badRequest('gameId required');
    if (!/^[0-9a-f]{32,256}$/i.test(token)) return badRequest('token must be hex');
    const key = `la:tokens:${gameId}`;
    const tokens = (await kvGet(env, key)) || [];
    if (!tokens.includes(token)) {
      tokens.push(token);
      await kvPut(env, key, tokens.slice(-LA_MAX_TOKENS), LA_TOKEN_TTL);
    }
    return json({ ok: true, count: tokens.length });
  }

  if (url.pathname === '/push/subscribe' && request.method === 'POST') {
    const body = await request.json();
    const subs = (await kvGet(env, 'push:subs')) || [];

    // Prefix league if not already present: 'CAR' → 'NHL:CAR', 'PWHL:MTL' stays
    const rawTeam = body.teamAbbr || 'CAR';
    const teamAbbr = rawTeam.includes(':') ? rawTeam : `NHL:${rawTeam}`;

    const isIOS = body.platform === 'ios';
    const newSub = isIOS
      ? { platform: 'ios', token: body.token, teamAbbr, prefs: body.prefs || null }
      : { endpoint: body.endpoint, keys: body.keys, teamAbbr, prefs: body.prefs || null };

    // Update existing or add new (dedupe by token for iOS, endpoint for Web Push)
    const idx = isIOS
      ? subs.findIndex(s => s.platform === 'ios' && s.token === body.token)
      : subs.findIndex(s => s.endpoint === body.endpoint);
    if (idx >= 0) {
      subs[idx] = newSub; // update team/prefs on re-subscribe
    } else {
      subs.push(newSub);
    }
    await kvPut(env, 'push:subs', subs, 365 * 24 * 3600);
    console.log(`Subscriber upserted: ${newSub.teamAbbr} (${isIOS ? 'ios' : 'web'}) prefs=${JSON.stringify(newSub.prefs)}. Total: ${subs.length}`);
    return json({ ok: true, total: subs.length });
  }

  // Push unsubscribe
  if (url.pathname === '/push/unsubscribe' && request.method === 'POST') {
    const { endpoint, token } = await request.json();
    const subs  = (await kvGet(env, 'push:subs')) || [];
    const after = token
      ? subs.filter(s => s.token !== token)
      : subs.filter(s => s.endpoint !== endpoint);
    await kvPut(env, 'push:subs', after, 365 * 24 * 3600);
    return json({ ok: true, total: after.length });
  }

  // Manual poll
  if (url.pathname === '/poll') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return unauthorized();
    await poll(env, ctx);
    return json({ ok: true, polled: new Date().toISOString() });
  }

  // Manual social post test (protected)
  if (url.pathname === '/social/test') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return unauthorized();
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
    if (secret !== env.POLL_SECRET) return unauthorized();
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

  // POST /atom/ingest — accepts bundled SBNation/Vox blog feed XML from
  // GitHub Actions (those sites block Cloudflare datacenter IPs but not
  // GH-hosted runners). Body: JSON object { sourceId: xmlText, ... }.
  //
  // Despite the route name, the bundled XML is a mix of two real formats
  // depending on which era of the Vox platform a given blog is on: true
  // Atom (<feed>/<entry>, the five original current.xml-path feeds) and
  // plain RSS 2.0 (<rss>/<item>, every /feed/-path blog added since --
  // Session: news ingestion investigation). Auto-detect per source rather
  // than assuming Atom for everything, which silently produced 0 parsed
  // items for every RSS-format feed when this route unconditionally
  // called parseAtom() on all of them.
  if (url.pathname === '/atom/ingest' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return unauthorized();
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
        const isTrueAtom = /<feed[\s>]/.test(xml.slice(0, 500));
        const parsed = isTrueAtom ? parseAtom(xml, src) : parseRSS(xml, src);
        results[sourceId] = parsed.length;
        await recordHealth(env, `nhl:${sourceId}`, true, { itemCount: parsed.length });
        if (!parsed.length) continue;
        // Merge with existing news — keep non-atom items intact
        const existing = (await kvGet(env, `news:${abbr}`)) || [];
        const nonAtom = existing.filter(item => !item.source || item.source !== sourceId);
        const merged = [...parsed, ...nonAtom]
          .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
          .slice(0, 30);
        await kvPut(env, `news:${abbr}`, merged, TTL);
      } catch (e) {
        console.warn(`Atom ingest: ${sourceId} parse error: ${e.message}`);
        results[sourceId] = 0;
        await recordHealth(env, `nhl:${sourceId}`, false, { error: e.message });
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
    if (secret !== env.POLL_SECRET) return unauthorized();
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
    if (secret !== env.POLL_SECRET) return unauthorized();
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
    if (secret !== env.POLL_SECRET) return unauthorized();
    const season = url.searchParams.get('season') || String(await resolveNHLSeason(env));
    ctx.waitUntil(
      refreshPPUnits(env, { force: true, season })
        .then(map => console.log(`PP units done (${season}): ${Object.keys(map).length} teams`))
        .catch(e => console.error('PP units error:', e.message))
    );
    return json({ ok: true, status: `refreshing — check /cache/pp_units:${season} in ~5s` });
  }

  if (url.pathname === '/summary/generate') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return unauthorized();
    const tc       = await getTeamConfig(request, env);
    const schedule = await kvGet(env, scheduleKey(tc.abbr, tc.season));
    const recent   = (schedule || [])
      .filter(g => isCompleted(g))
      .sort((a, b) => new Date(b.gameDate).getTime() - new Date(a.gameDate).getTime())[0];
    if (!recent) return errorJson(404, { error: 'No completed games found' });
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
    if (!gameId) return badRequest('gameId required');
    const tc = await getTeamConfig(request, env);

    // Team-scoped: the same gameId can legitimately be requested from
    // either side's perspective (e.g. a TOR fan and an NJD fan both
    // viewing the same TOR-vs-NJD game), and the response itself is
    // framed around tc.abbr (oppAbbr, isHome, carWinPct all relative to
    // it) -- a bare `prediction:${gameId}` key would let whichever team
    // requested it first silently determine what every other team's fan
    // sees for that same game. Same fix /summary/narrative already has
    // (`narrative:${period}:${gameId}:${carAbbrKey}`) -- this route just
    // hadn't been updated to match when this app went multi-team.
    // French gets its own key (':fr'); English keeps the original one.
    const locale = requestLocale(url);
    const kvKey = `prediction:${gameId}:${tc.abbr}${localeKeySuffix(locale)}`;

    // Serve from cache if available and not forced
    if (!forceRegen) {
      const cached = await kvGet(env, kvKey);
      if (cached) return json(cached);
    }

    // Fetch standings for both teams
    const standings = await kvGet(env, 'standings') || [];
    const schedule  = await scheduleWithFetch(env, tc.abbr, tc.season);

    // Find this game
    const game = schedule.find(g => String(g.id) === String(gameId));
    if (!game) return errorJson(404, { error: 'Game not found in schedule' });

    const isHome    = game.homeTeam?.abbrev === tc.abbr;
    const oppAbbr   = isHome ? game.awayTeam?.abbrev : game.homeTeam?.abbrev;
    const isPlayoff = game.gameType === 3;
    const neutral   = !!game.neutralSite;

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
      // here. Route to the preseason fallback instead of blocking the
      // user -- it needs no current-season data at all now (Elo's own
      // rating, carried and regressed pipeline-side, works from game 1).
      return buildPreseasonFallback(env, tc, oppAbbr, isHome, isPlayoff, gameId, kvKey, neutral, locale);
    }

    // Find standings for both teams
    const findTeam = abbr => standings.find(s =>
      s.teamAbbrev?.default === abbr || s.teamAbbrev === abbr
    );
    const carTeam = findTeam(tc.abbr);
    const oppTeam = findTeam(oppAbbr);

    if (!carTeam || !oppTeam) return errorJson(404, { error: 'Team standings not found' });

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
      const teamRows = await sbRowsOrThrow(
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

    // powerPlayPct still needed below for the AI prompt's descriptive
    // stats, even though it no longer feeds a win% calculation directly.
    if (carTeam.powerPlayPct == null) console.error(`prediction/analyze in-season: ${tc.abbr} powerPlayPct missing, defaulting to league-average ${PP_PCT_DEFAULT}%`);
    if (oppTeam.powerPlayPct == null) console.error(`prediction/analyze in-season: ${oppAbbr} powerPlayPct missing, defaulting to league-average ${PP_PCT_DEFAULT}%`);
    const carPP = carTeam.powerPlayPct ?? PP_PCT_DEFAULT;
    const oppPP = oppTeam.powerPlayPct ?? PP_PCT_DEFAULT;

    // Win probability -- see eyewall-pipeline/docs/elo_prediction_model_results.md
    // for the backtest this replaces the former hand-tuned scorecard +
    // isotonic calibration with: beats it on every metric (Brier 0.242 vs
    // 0.321, log loss 0.677 vs 2.561, 56.5% vs 55.5% accuracy, 3,796 real
    // games). Same fetchEloRatings()/eloWinProb() helpers buildPreseasonFallback
    // uses above -- one consistent model for both regimes now.
    let eloRatings;
    try {
      eloRatings = await fetchEloRatings(tc, oppAbbr);
    } catch (e) {
      return errorJson(502, { error: e.message });
    }
    const carWinPct = Math.round(eloWinProb(eloRatings.car, eloRatings.opp, isHome, neutral) * 100);

    const prompt = `You are EyeWall Analytics, a ${tc.displayName} hockey analytics assistant. Write a sharp, data-driven pre-game analysis for ${tc.displayName} fans. 2-3 sentences only. Be specific about the numbers. No filler. No "In this matchup" opener.

Game: ${tc.abbr} (${isHome ? 'HOME' : 'AWAY'}) vs ${oppAbbr}
Context: ${isPlayoff ? 'PLAYOFFS' : 'Regular Season'}

${tc.abbr} stats:
- Record: ${carTeam.wins}-${carTeam.losses}-${carTeam.otLosses} (${carTeam.points} pts)
- GF/GA per game: ${carGpg.toFixed(2)} / ${carGag.toFixed(2)}
- PP%: ${carPP.toFixed(1)}% · PK%: ${(carTeam.penaltyKillPct ?? 0).toFixed(1)}%
- SOG/GP: ${carSF.toFixed(1)} for / ${carSA.toFixed(1)} against
- ${corsiLabel}: ${carCF ?? '—'}%
- Current streak: ${carStreak}

${oppAbbr} stats:
- Record: ${oppTeam.wins}-${oppTeam.losses}-${oppTeam.otLosses} (${oppTeam.points} pts)
- GF/GA per game: ${oppGpg.toFixed(2)} / ${oppGag.toFixed(2)}
- PP%: ${oppPP.toFixed(1)}% · PK%: ${(oppTeam.penaltyKillPct ?? 0).toFixed(1)}%
- SOG/GP: ${oppSF.toFixed(1)} for / ${oppSA.toFixed(1)} against
- ${corsiLabel}: ${oppCF ?? '—'}%
- Current streak: ${oppStreak}

Head-to-head this season: ${tc.abbr} ${h2hRecord}
Expected score (Pythagorean): ${tc.abbr} ${expCar} - ${oppAbbr} ${expOpp}
Model win probability: ${tc.abbr} ${carWinPct}%${isPlayoff ? '\n\nNote: This is a playoff game. Ignore regular season points — focus on possession, goaltending, and recent form.' : ''}

${corsiSource === 'sog_share_proxy' ? 'Note: the Corsi figure above is a shots-on-goal-only proxy (real shot-attempt data unavailable) — describe it as "shot share," not "Corsi" or "possession," in your analysis.' : `Note: the Corsi figure above is ${corsiCaveat} Describe it as "shot-attempt share" or "Corsi," accurately reflecting that scope.`}

Write the analysis now. Mention the single most decisive factor, one risk or concern, and a concrete expected-score range.`;

    let aiResponse;
    try {
      aiResponse = await generateText(env, {
        messages: [{ role: 'user', content: localizePrompt(prompt, locale) }],
      });
    } catch (e) {
      console.error('prediction/analyze AI error:', e);
      return errorJson(502, { error: 'AI generation failed' });
    }
    const narrative = aiResponse.response?.trim() || '';
    if (!narrative) return errorJson(502, { error: 'Empty response' });

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
      correction: 'elo',
    };

    // Cache for 24hr (pre-game analysis refreshes daily in case of lineup changes)
    await kvPut(env, kvKey, result, 24 * 3600);
    console.log(`Prediction analysis generated for game ${gameId}`);
    return json(result);
  }

  // Send a test notification (protected)
  if (url.pathname === '/push/test') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return unauthorized();
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
    if (!gameId || !period) return badRequest('gameId and period required');
    // Key includes carAbbr so each team gets its own cached perspective
    const carAbbrKey = (url.searchParams.get('carAbbr') || 'UNK').toUpperCase();
    const kvKey  = `narrative:${period}:${gameId}:${carAbbrKey}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    // Stats payload sent by the client
    let stats;
    try { stats = await request.json(); } catch { return badRequest('Invalid body'); }

    const isGame   = period === 'game';
    const oppAbbr  = stats.oppAbbr || 'OPP';
    const carAbbr  = stats.carAbbr || 'CAR';
    const isPlayoff = stats.isPlayoff || false;

    // Game summaries span all 3+ periods, so a goal's period matters for
    // an accurate narrative -- without it, both Gemma and DeepSeek were
    // confirmed (side-by-side test, 2026-09) to just invent one ("the
    // decisive strike in the third", "second-period strike") rather than
    // admit they didn't know. The client already sends g.period (see
    // PeriodSummary.jsx's statsPayload) -- this was available and simply
    // wasn't being read. Omitted for period-level narratives, where every
    // goal in this same list is already understood to be from the one
    // period the prompt names (stats.periodLabel below).
    const goalsSummary = (stats.goals || []).map(g => {
      const when = isGame && g.period != null ? `P${g.period} ${g.time || '—'}` : (g.time || '—');
      return `${g.isCar ? carAbbr : oppAbbr} goal by ${g.scorerName || 'unknown'} at ${when} (${(g.strength || 'EV').toUpperCase()})`;
    }).join('; ') || 'no goals';

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

    let aiResponse, cardResponse;
    try {
      [aiResponse, cardResponse] = await Promise.all([
        generateText(env, {
          messages: [{ role: 'user', content: prompt }],
        }),
        cardPrompt
          ? generateText(env, {
              messages: [{ role: 'user', content: cardPrompt }],
            })
          : Promise.resolve(null),
      ]);
    } catch (e) {
      console.error('[NHL] narrative AI error:', e);
      return errorJson(502, { error: 'AI generation failed' });
    }

    const narrative     = aiResponse.response?.trim() || '';
    const cardNarrative = cardResponse?.response?.trim() || null;
    if (!narrative) return errorJson(502, { error: 'Empty response' });

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
    // Rankings are stable — cache 24hr
    return cachedJson(env, kvKey, 24 * 3600, async () => {
      const filter = category
        ? `?category_id=eq.${category}&order=final_rank.asc&limit=300`
        : `?order=category_id.asc,final_rank.asc&limit=600`;

      const rows = await sbRows(`${SB_URL}/rest/v1/draft_rankings_2026${filter}`);
      if (rows instanceof Response) return rows;

      // If fetching all, group by category_id for convenient frontend consumption
      let result;
      if (!category) {
        result = { 1: [], 2: [], 3: [], 4: [] };
        for (const row of rows) result[row.category_id].push(row);
      } else {
        result = rows;
      }

      return result;
    });
  }

  // ── Draft picks — live during draft, stored forever in Supabase ───────────────
  // GET /draft/picks              — all picks (post-draft: full board)
  // GET /draft/picks?team=CAR     — filtered by team
  // GET /draft/picks?round=1      — filtered by round
  if (url.pathname === '/draft/picks') {
    const team  = url.searchParams.get('team')?.toUpperCase();
    const round = url.searchParams.get('round');

    // Short TTL while draft is in progress or unresolved (including zero
    // results, e.g. a round that hasn't happened yet — this must NOT get
    // the 24hr branch or a snapshot taken before picks exist gets pinned
    // in KV for a full day). Long TTL only once we've actually seen all
    // 224 picks.
    const ttl = (rows) => (rows.length >= 224 ? 24 * 3600 : 60);
    return cachedJson(env, `draft:picks:2026:${team || 'all'}:${round || 'all'}`, ttl, async () => {
      let filter = '?order=pick_overall.asc&limit=300';
      if (team)  filter += `&team_abbrev=eq.${team}`;
      if (round) filter += `&round=eq.${round}`;

      const rows = await sbRows(`${SB_URL}/rest/v1/draft_picks_2026${filter}`);
      if (rows instanceof Response) return rows;

      return rows;
    });
  }

  // ── Draft pick order — projected slots pre-draft ──────────────────────────────
  // GET /draft/order              — full R1 order (all 32 teams)
  // GET /draft/order?team=CAR     — just this team's known slots
  if (url.pathname === '/draft/order') {
    const team   = url.searchParams.get('team')?.toUpperCase();
    return cachedJson(env, `draft:order:2026:${team || 'all'}`, 24 * 3600, async () => {
      let filter = '?order=pick_overall.asc&limit=32';
      if (team) filter += `&team_abbrev=eq.${team}`;

      const rows = await sbRows(`${SB_URL}/rest/v1/draft_pick_order_2026${filter}`);
      if (rows instanceof Response) return rows;

      return rows;
    });
  }

  // ── Draft pick history — where a team's recent picks came from / went ────────
  // GET /draft/pick-history?team=CAR
  // From eyewall-pipeline's draft_pick_history (draft_history.py -- the NHL
  // records API's draft data, each pick's teamPickHistory parsed into
  // pick_chain, original owner first, drafting team last). Two lists over the
  // last PICK_HISTORY_DRAFTS drafts, newest first:
  //   made       -- picks this team used (pick_chain = where each came from)
  //   tradedAway -- this team's own original picks another team used
  // 6hr KV: draft history only changes at the draft (and as prospects get NHL
  // ids). A failed read returns empty lists and is NOT cached. `team` is
  // validated before it's interpolated into the PostgREST filter.
  if (url.pathname === '/draft/pick-history') {
    const PICK_HISTORY_DRAFTS = 5;
    const team = (url.searchParams.get('team') || DEFAULT_TEAM_ABBR).toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(team)) {
      return badRequest('invalid team');
    }
    const sinceYear = new Date().getUTCFullYear() - (PICK_HISTORY_DRAFTS - 1);
    return cachedJson(env, `draft:pick-history:${team}:${sinceYear}`, 6 * 3600, async () => {
      const select = 'draft_year,round,pick_in_round,overall_pick,team,original_team,pick_chain,times_traded,player_id,player_name,position';
      const base   = `draft_pick_history?select=${select}&draft_year=gte.${sinceYear}&order=draft_year.desc,overall_pick.asc`;
      let made;
      let tradedAway;
      try {
        [made, tradedAway] = await Promise.all([
          sbRowsOrThrow(`${base}&team=eq.${team}`),
          sbRowsOrThrow(`${base}&original_team=eq.${team}&team=neq.${team}`),
        ]);
      } catch {
        return json({ team, sinceYear, made: [], tradedAway: [] });
      }

      const data = { team, sinceYear, made, tradedAway };
      return data;
    });
  }

  // ── Playoff odds — simulated playoff chances, and why they moved ──────────────
  // GET /playoff-odds?team=CAR[&season=20262027]
  // From eyewall-pipeline's playoff_odds.py (nightly: the rest of the regular
  // season simulated from team Elo ratings). Without `season`, the season of
  // the team's most recent run -- no resolveNHLSeason() call, since odds only
  // exist once the pipeline has run for a season anyway. Response:
  //   latest    -- that run's row, incl. `change` (why it moved since the
  //                previous run; null on a season's first run)
  //   history   -- [{ run_date, playoff_pct }] for that season, oldest first
  //   nextGames -- the team's odds under each result of the next game-day's
  //                games (summarizeNextGames(): own games, then the biggest
  //                swings elsewhere)
  //   stale     -- no run for PLAYOFF_ODDS_STALE_DAYS (season over, or the
  //                nightly stopped) -- labeled by the frontend, not hidden
  // 1hr KV. A failed read returns `unavailable: true` and is NOT cached;
  // neither is an empty result, so the season's first run shows up at once.
// A team's own "win division" number says nothing about who it's behind.
// This returns the whole division from the same simulation run, so the
// card can show where the team actually sits rather than a bare percentage.
// Division membership comes from the cached NHL standings (their
// divisionName), the same source the standings tab already trusts; if that
// is missing the card simply renders without this block.
async function divisionOdds(env, team, latest) {
  try {
    const standings = await kvGet(env, 'standings') || [];
    const abbrOf = r => (r.teamAbbrev?.default || r.teamAbbrev);
    const own = standings.find(r => abbrOf(r) === team);
    if (!own?.divisionName) return null;

    const peers = standings.filter(r => r.divisionName === own.divisionName).map(abbrOf).filter(Boolean);
    if (peers.length < 2) return null;

    const rows = await sbRowsOrThrow(
      `playoff_odds?select=team,division_pct,playoff_pct,proj_points` +
      `&season=eq.${latest.season}&run_date=eq.${latest.run_date}&team=in.(${peers.join(',')})`
    );
    if (!rows.length) return null;

    const teams = rows
      .map(r => ({
        team: r.team,
        divisionPct: r.division_pct,
        playoffPct: r.playoff_pct,
        projPoints: r.proj_points,
      }))
      .sort((a, b) => (b.divisionPct ?? -1) - (a.divisionPct ?? -1));
    const rank = teams.findIndex(r => r.team === team) + 1;

    return { name: own.divisionName, teams, rank: rank || null, of: teams.length };
  } catch (e) {
    console.warn(`playoff-odds: division context unavailable: ${e.message}`);
    return null;
  }
}

  if (url.pathname === '/playoff-odds') {
    const HISTORY_MAX = 250; // > one regular season of nightly runs
    const team   = (url.searchParams.get('team') || DEFAULT_TEAM_ABBR).toUpperCase();
    const season = url.searchParams.get('season');
    if (!/^[A-Z]{2,3}$/.test(team) || (season && !/^\d{8}$/.test(season))) {
      return badRequest('invalid team or season');
    }
    return cachedJson(env, `nhl:playoff-odds:${team}:${season || 'latest'}`, 3600, async () => {
      const empty = { team, season: season ? Number(season) : null, runDate: null, stale: false, latest: null, history: [], nextGames: [] };
      const bySeason = season ? `&season=eq.${season}` : '';
      const cols = 'season,run_date,playoff_pct,division_pct,proj_points,points_p10,points_p90,current_points,games_played,games_remaining,elo_rating,sims,change';
      let latest;
      let history;
      let nextGames;
      try {
        const [latestRows, historyRows] = await Promise.all([
          sbRowsOrThrow(`playoff_odds?select=${cols}&team=eq.${team}${bySeason}&order=run_date.desc&limit=1`),
          sbRowsOrThrow(`playoff_odds?select=season,run_date,playoff_pct&team=eq.${team}${bySeason}&order=run_date.desc&limit=${HISTORY_MAX}`),
        ]);
        latest = latestRows[0] || null;
        if (!latest) return json(empty);
        history = historyRows
          .filter(r => r.season === latest.season)
          .reverse()
          .map(({ run_date, playoff_pct }) => ({ run_date, playoff_pct }));
        const impacts = await sbRowsOrThrow(
          `playoff_odds_game_impacts?select=game_id,game_date,home_team,away_team,outcome,playoff_pct` +
          `&season=eq.${latest.season}&run_date=eq.${latest.run_date}&team=eq.${team}`
        );
        nextGames = summarizeNextGames(impacts, team);
      } catch {
        return json({ ...empty, unavailable: true });
      }

      const division = await divisionOdds(env, team, latest);

      const data = {
        team, season: latest.season, runDate: latest.run_date,
        stale: isPlayoffOddsStale(latest.run_date), latest, history, nextGames, division,
      };
      return data;
    });
  }

  // ── Injury impact — man-games and WAR lost to injury this season ──────────────
  // GET /injury-impact?team=CAR[&season=20262027]
  // From eyewall-pipeline's injury_impact.py (nightly: a player on the day's
  // injury report who didn't dress = a man-game lost, valued at his WAR per
  // game). Without `season`, the team's most recent season row. Response:
  //   impact -- the team_injury_impact row: games_played, man_games_lost,
  //             war_lost, players_injured, rank_man_games / rank_war_lost
  //             (1 = most lost), players [{ player_id, player_name, games,
  //             war_lost, last_date, status, injury_type }], updated_at
  //   league -- summarizeInjuryLeague() over every team's row that season
  // Injury history starts 2026-09-12, so there are no rows before the
  // 2026-27 regular season: impact is null. 1hr KV. A failed read returns
  // `unavailable: true` and is NOT cached; neither is an empty result, so
  // the first game night shows up at once.
  if (url.pathname === '/injury-impact') {
    const team   = (url.searchParams.get('team') || DEFAULT_TEAM_ABBR).toUpperCase();
    const season = url.searchParams.get('season');
    if (!/^[A-Z]{2,3}$/.test(team) || (season && !/^\d{8}$/.test(season))) {
      return badRequest('invalid team or season');
    }
    return cachedJson(env, `nhl:injury-impact:${team}:${season || 'latest'}`, 3600, async () => {
      const empty = { team, season: season ? Number(season) : null, impact: null, league: null };
      const bySeason = season ? `&season=eq.${season}` : '';
      const cols = 'season,team,games_played,man_games_lost,war_lost,players_injured,rank_man_games,rank_war_lost,players,updated_at';
      let impact;
      let leagueRows;
      try {
        const rows = await sbRowsOrThrow(`team_injury_impact?select=${cols}&team=eq.${team}${bySeason}&order=season.desc&limit=1`);
        impact = rows[0] || null;
        if (!impact) return json(empty);
        leagueRows = await sbRowsOrThrow(`team_injury_impact?select=team,games_played,man_games_lost,war_lost&season=eq.${impact.season}`);
      } catch {
        return json({ ...empty, unavailable: true });
      }

      const data = { team, season: impact.season, impact, league: summarizeInjuryLeague(leagueRows) };
      return data;
    });
  }

  // ── Probable starters — who's likely to start in goal for a game ──────────────
  // GET /probable-starters?game=2026020001
  // From eyewall-pipeline's starting_goalie.py (nightly: for each team's next
  // regular-season game once it's within 2 days, the probability each healthy
  // roster goalie starts -- a model of the team's own pattern, since the NHL
  // publishes no probable starters). Response: { gameId, gameDate, runDate,
  // teams: { ABBR: [{ goalie_id, goalie_name, start_prob, factors }] } }, each
  // team's goalies most likely first (summarizeStarters(),
  // src/probableStarters.js). teams is {} until the game is inside the window
  // (or for a team skipped as still carrying a camp roster). 1hr KV; neither a
  // failed read (`unavailable: true`) nor an empty result is cached, so the
  // first nightly write shows up at once. `game` must be a 10-digit NHL id.
  if (url.pathname === '/probable-starters') {
    const gameId = url.searchParams.get('game') || '';
    if (!/^\d{10}$/.test(gameId)) {
      return badRequest('invalid game');
    }
    return cachedJson(env, `nhl:probable-starters:${gameId}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `goalie_start_probs?select=team,goalie_id,goalie_name,start_prob,factors,game_date,run_date&game_id=eq.${gameId}`
        );
      } catch {
        return json({ gameId: Number(gameId), gameDate: null, runDate: null, teams: {}, unavailable: true });
      }

      const data = { gameId: Number(gameId), ...summarizeStarters(rows) };
      return Object.keys(data.teams).length ? data : json(data); // an empty result isn't cached
    });
  }

  // ── Projected lines — who plays with whom in a team's next game ──────────────
  // GET /projected-lines?team=CAR
  // From eyewall-pipeline's projected_lines.py (nightly: each team's projected
  // forward lines and D pairs for its next game -- last game's pairings
  // in-season, pooled preseason pairings before a team's first game; see that
  // module and its docs/projected_lines_backtest_results.md). Response:
  // { team, basis: 'last_game' | 'preseason' | null, basisGameId, basisGames,
  // generatedAt, lines, pairs } -- see summarizeProjectedLines(),
  // src/projectedLines.js. Different from /team-lines (the season's most-used
  // units, with xGF%). 1hr KV; neither a failed read (`unavailable: true`) nor
  // an empty result (no projection yet) is cached, so the first nightly write
  // shows up at once. `team` is validated before it's interpolated into the
  // PostgREST filter.
  if (url.pathname === '/projected-lines') {
    const team = (url.searchParams.get('team') || DEFAULT_TEAM_ABBR).toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(team)) {
      return badRequest('invalid team');
    }
    return cachedJson(env, `nhl:projected-lines:${team}`, 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          `projected_lines?select=unit_type,rank,player_ids,names,positions,filled_ids,basis,basis_game_id,basis_games,generated_at` +
          `&team=eq.${team}&order=unit_type.asc,rank.asc`
        );
      } catch {
        return json({ team, ...summarizeProjectedLines([]), unavailable: true });
      }

      const data = { team, ...summarizeProjectedLines(rows) };
      return data.basis ? data : json(data); // an empty result isn't cached
    });
  }

  // ── Prediction scorecard — how the published predictions have done ────────────
  // GET /scorecard
  // From eyewall-pipeline's prediction_scorecard.py (nightly): one row per
  // model x kind x period -- game_winner / starting_goalie / playoff_odds, each
  // 'live' (graded predictions that were published beforehand, from 2026-27)
  // and 'backtest' (the model replayed on past seasons, labeled as such).
  // Response: { models: { <model>: { live, backtest } }, updatedAt } -- see
  // summarizeScorecard(), src/scorecard.js (the most recent live period per
  // model, so a new season's row takes over, plus its backtest). Plain
  // probabilities, no betting framing. 1hr KV; neither a failed read
  // (`unavailable: true`) nor an empty table is cached.
  if (url.pathname === '/scorecard') {
    return cachedJson(env, 'nhl:scorecard', 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow(
          'prediction_scorecard?select=model,kind,period,status,n,accuracy,brier,log_loss,' +
          'baseline,calibration,recent,note,updated_at'
        );
      } catch {
        return json({ models: {}, updatedAt: null, unavailable: true });
      }

      const data = summarizeScorecard(rows);
      return Object.keys(data.models).length ? data : json(data); // an empty table isn't cached
    });
  }

  // ── Elo ratings — every team's rating, for game win probabilities ─────────────
  // GET /elo/ratings
  // team_elo_ratings (eyewall-pipeline's elo_ratings.py, a nightly full replay)
  // plus the home advantage, so the frontend computes each matchup's win
  // probability with the exact formula /prediction/analyze (eloWinProb()) and
  // eyewall-pipeline's win_probs.py -- the morning log the public scorecard
  // grades -- use: P(home) = 1 / (1 + 10^((away - (home + homeAdvantage)) / 400)),
  // no advantage at a neutral site. One call covers the preview's win bar and
  // every game card on the schedule. Response: { ratings: { ABBR: rating },
  // homeAdvantage }. 1hr KV (ratings change once a night); a failed read
  // returns `unavailable: true`, and neither it nor an empty table is cached.
  if (url.pathname === '/elo/ratings') {
    return cachedJson(env, 'nhl:elo-ratings', 3600, async () => {
      let rows;
      try {
        rows = await sbRowsOrThrow('team_elo_ratings?select=team,rating');
      } catch {
        return json({ ratings: {}, homeAdvantage: ELO_HOME_ADVANTAGE, unavailable: true });
      }
      const data = {
        ratings: Object.fromEntries(rows.map(row => [row.team, Number(row.rating)])),
        homeAdvantage: ELO_HOME_ADVANTAGE,
      };
      return rows.length ? data : json(data); // an empty table isn't cached
    });
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
  //
  // Scoped to the live-resolved current season (added after a stale
  // 2025-26 CAR shutout sat as the ONLY NHL row in the table all
  // offseason -- with no newer rows to push it off, an unfiltered
  // "order by game_date desc, limit N" query shows it forever, and for a
  // team-filtered query specifically it could persist for weeks/months
  // into the next season too, not just during the gap before one starts.
  // milestones.py/pwhl_milestones.py already write a `season` column on
  // every row (NHL: resolveNHLSeason()'s string, e.g. "20262027"; PWHL:
  // resolvePWHLSeason()'s numeric seasonId, e.g. 8) -- it was just never
  // queried on here.
  if (url.pathname === '/milestones') {
    const team  = url.searchParams.get('team')?.toUpperCase();
    const sport = url.searchParams.get('sport')?.toLowerCase();
    const isPwhl = sport === 'pwhl';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
    const season = isPwhl ? (await resolvePWHLSeason(env)).seasonId : await resolveNHLSeason(env);

    return cachedJson(env, `milestones:${sport || 'nhl'}:${team || 'all'}:${limit}:${season}`, 3600, async () => {
      let filter = `?order=game_date.desc,id.desc&limit=${limit}&is_pwhl=eq.${isPwhl}&season=eq.${season}`;
      if (team) filter += `&team=eq.${team}`;

      const rows = await sbRows(`${SB_URL}/rest/v1/milestones${filter}`);
      if (rows instanceof Response) return rows;

      return rows;
    });
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
    if (!playerId) return badRequest('id required');

    return cachedJson(env, `player:landing:${playerId}`, 3600, async () => {
      let data;
      try {
        data = await nhlGet(`${NHL_BASE}/player/${playerId}/landing`);
      } catch (e) {
        return errorJson(502, { error: e.message });
      }

      return data;
    });
  }

  // ── Draft pick AI analysis ────────────────────────────────────────────────────
  // POST /draft/analyze  (secret-protected, called by draft_ingest.py on draft day)
  // Body: { prompt: string }
  // Returns: { analysis: string }
  if (url.pathname === '/draft/analyze' && request.method === 'POST') {
    const secret = request.headers.get('X-Poll-Secret');
    if (secret !== env.POLL_SECRET) return unauthorized();

    let body;
    try {
      body = await request.json();
      if (!body?.prompt) throw new Error('prompt required');
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }

    let aiResponse;
    try {
      aiResponse = await generateText(env, {
        messages: [
          {
            role: 'system',
            content: `You are Sticks, the EyeWall Analytics draft analyst. You give sharp, specific 2-3 sentence pick analyses. Focus on value relative to rank, team fit, and player type. No filler. No "This is a great pick" openers. Be direct.`,
          },
          { role: 'user', content: body.prompt },
        ],
      });
    } catch (e) {
      console.error('Draft analyze AI error:', e);
      return errorJson(502, { error: 'AI generation failed' });
    }

    const analysis = aiResponse.response?.trim() || '';
    if (!analysis) return errorJson(502, { error: 'Empty AI response' });

    console.log(`Draft analyze: ${analysis.slice(0, 80)}...`);
    return json({ analysis });
  }

  return new Response('Not found', { status: 404, headers: corsHeaders() });
}
