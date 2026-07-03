/**
 * nhl.js — EyeWall Analytics Worker
 *
 * NHL poll loop, push notifications, and all /nhl/* + /poll/* HTTP endpoints.
 * Scheduled trigger calls poll() every 60s during the season.
 */

import { kvGet, kvPut, json, corsHeaders, SB_URL, SB_ANON, parseRSS, parseESPN, parseAtom, parseReddit, parseSportsnet, parseGoogleNews, parseNHLNews, sendPush, base64urlToUint8Array, uint8ArrayToBase64url } from './shared.js';

const NHL_BASE   = 'https://api-web.nhle.com/v1';
const STATS_BASE = 'https://api.nhle.com/stats/rest/en';

// ── Team configuration ────────────────────────────────────────
// All 32 teams. The poll() scheduled job uses DEFAULT_TEAM_ABBR.
// Every HTTP endpoint resolves a per-request team from ?team= query param,
// falling back to DEFAULT_TEAM_ABBR when omitted.

const DEFAULT_TEAM_ABBR = 'CAR';

const TEAM_CONFIGS = {
  // keywords: short names/nicknames used by beat writers and BR/Athletic article titles.
  // Used by teamFilterKeywords() to filter league-wide RSS feeds.
  ANA: { abbr:'ANA', teamId:24, franchiseId:32, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Anaheim Ducks',         keywords:['ducks','anaheim','drysdale','fowler','terry','zegras'],                       winCopy:"Let's go Ducks! 🦆",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`ANA vs ${o} — puck drop!`, hashtags:['#AnaheimDucks','#LetsGoDucks','#NHL'] },
  BOS: { abbr:'BOS', teamId:6,  franchiseId:6,  season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Boston Bruins',          keywords:['bruins','boston','pastrnak','mcavoy','swayman'],                               winCopy:"Let's go Bruins! 🐻",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`BOS vs ${o} — puck drop!`, hashtags:['#NHLBruins','#BostonBruins','#NHL'] },
  BUF: { abbr:'BUF', teamId:7,  franchiseId:7,  season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Buffalo Sabres',         keywords:['sabres','buffalo','tuch','power','ukko-pekka'],                                winCopy:"Let's go Sabres! ⚔️",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`BUF vs ${o} — puck drop!`, hashtags:['#Sabres','#LetsGoBuffalo','#NHL'] },
  CGY: { abbr:'CGY', teamId:20, franchiseId:27, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Calgary Flames',         keywords:['flames','calgary','huberdeau','weegar','markstrom'],                          winCopy:"Let's go Flames! 🔥",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CGY vs ${o} — puck drop!`, hashtags:['#Flames','#CofRed','#NHL'] },
  CAR: { abbr:'CAR', teamId:12, franchiseId:26, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Carolina Hurricanes',    keywords:['canes','hurricanes','carolina','aho','svechnikov','kotkaniemi','kochetkov'],   winCopy:"Let's go Canes! 🌀",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CAR vs ${o} — puck drop!`, hashtags:['#LetsGoCanes','#Canes','#NHL','#CarolinaHurricanes','#SoundTheSiren'] },
  CHI: { abbr:'CHI', teamId:16, franchiseId:11, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Chicago Blackhawks',     keywords:['blackhawks','chicago','hawks','bedard','dickinson'],                          winCopy:"Let's go Blackhawks! 🪶",  lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CHI vs ${o} — puck drop!`, hashtags:['#Blackhawks','#OneGoal','#NHL'] },
  COL: { abbr:'COL', teamId:21, franchiseId:27, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Colorado Avalanche',     keywords:['avalanche','colorado','avs','mackinnon','makar','landeskog'],                  winCopy:"Let's go Avs! ❄️",         lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`COL vs ${o} — puck drop!`, hashtags:['#GoAvsGo','#Avalanche','#NHL'] },
  CBJ: { abbr:'CBJ', teamId:29, franchiseId:36, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Columbus Blue Jackets',  keywords:['blue jackets','columbus','jackets','fantilli','voronkov'],                    winCopy:"Let's go Jackets! 💥",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`CBJ vs ${o} — puck drop!`, hashtags:['#CBJ','#NHLJackets','#NHL'] },
  DAL: { abbr:'DAL', teamId:25, franchiseId:15, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Dallas Stars',           keywords:['stars','dallas','robertson','seguin','oettinger'],                            winCopy:"Let's go Stars! ⭐",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`DAL vs ${o} — puck drop!`, hashtags:['#GoStars','#TexasHockey','#NHL'] },
  DET: { abbr:'DET', teamId:17, franchiseId:12, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Detroit Red Wings',      keywords:['red wings','detroit','wings','larkin','raymond','seider'],                    winCopy:"Let's go Wings! 🐙",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`DET vs ${o} — puck drop!`, hashtags:['#LGRW','#DetroitRedWings','#NHL'] },
  EDM: { abbr:'EDM', teamId:22, franchiseId:25, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Edmonton Oilers',        keywords:['oilers','edmonton','mcdavid','draisaitl','skinner'],                          winCopy:"Let's go Oilers! 🛢️",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`EDM vs ${o} — puck drop!`, hashtags:['#LetsGoOilers','#Oilers','#NHL'] },
  FLA: { abbr:'FLA', teamId:13, franchiseId:33, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Florida Panthers',       keywords:['panthers','florida','barkov','reinhart','bobrovsky'],                         winCopy:"Let's go Panthers! 🐾",    lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`FLA vs ${o} — puck drop!`, hashtags:['#TimeToHunt','#FlaPanthers','#NHL'] },
  LAK: { abbr:'LAK', teamId:26, franchiseId:14, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Los Angeles Kings',      keywords:['kings','los angeles','kopitar','doughty','fiala'],                            winCopy:"Let's go Kings! 👑",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`LAK vs ${o} — puck drop!`, hashtags:['#GoKingsGo','#LAKings','#NHL'] },
  MIN: { abbr:'MIN', teamId:30, franchiseId:37, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Minnesota Wild',         keywords:['wild','minnesota','kirill kaprizov','gustavsson','hartman'],                   winCopy:"Let's go Wild! 🌲",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`MIN vs ${o} — puck drop!`, hashtags:['#mnwild','#MNWild','#NHL'] },
  MTL: { abbr:'MTL', teamId:8,  franchiseId:1,  season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Montreal Canadiens',     keywords:['canadiens','montreal','habs','caufield','slafkovsky','montembeault'],         winCopy:"Let's go Habs! 🔵",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`MTL vs ${o} — puck drop!`, hashtags:['#GoHabsGo','#Canadiens','#NHL'] },
  NSH: { abbr:'NSH', teamId:18, franchiseId:34, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Nashville Predators',    keywords:['predators','nashville','preds','forsberg','juuse saros'],                     winCopy:"Let's go Preds! 🐯",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NSH vs ${o} — puck drop!`, hashtags:['#Preds','#NashvillePredators','#NHL'] },
  NJD: { abbr:'NJD', teamId:1,  franchiseId:23, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'New Jersey Devils',      keywords:['devils','new jersey','hischier','hughes','vanecek'],                          winCopy:"Let's go Devils! 😈",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NJD vs ${o} — puck drop!`, hashtags:['#NJDevils','#NJD','#NHL'] },
  NYI: { abbr:'NYI', teamId:2,  franchiseId:22, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'New York Islanders',     keywords:['islanders','new york','isles','barzal','sorokin'],                            winCopy:"Let's go Islanders! 🏝️",  lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NYI vs ${o} — puck drop!`, hashtags:['#Isles','#NYIsles','#NHL'] },
  NYR: { abbr:'NYR', teamId:3,  franchiseId:10, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'New York Rangers',       keywords:['rangers','new york','panarin','zibanejad','shesterkin'],                      winCopy:"Let's go Rangers! 🗽",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`NYR vs ${o} — puck drop!`, hashtags:['#NYR','#NYRangers','#NHL'] },
  OTT: { abbr:'OTT', teamId:9,  franchiseId:30, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Ottawa Senators',        keywords:['senators','ottawa','sens','tkachuk','stutzle','forsberg'],                    winCopy:"Let's go Sens! 🏛️",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`OTT vs ${o} — puck drop!`, hashtags:['#GoSensGo','#Sens','#NHL'] },
  PHI: { abbr:'PHI', teamId:4,  franchiseId:16, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Philadelphia Flyers',    keywords:['flyers','philadelphia','matvei michkov','cates','fedotov'],                   winCopy:"Let's go Flyers! 🟠",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`PHI vs ${o} — puck drop!`, hashtags:['#Flyers','#PhiladelphiaFlyers','#NHL'] },
  PIT: { abbr:'PIT', teamId:5,  franchiseId:17, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Pittsburgh Penguins',    keywords:['penguins','pittsburgh','pens','crosby','malkin','jarry'],                     winCopy:"Let's go Pens! 🐧",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`PIT vs ${o} — puck drop!`, hashtags:['#LetsGoPens','#Penguins','#NHL'] },
  SEA: { abbr:'SEA', teamId:55, franchiseId:39, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Seattle Kraken',         keywords:['kraken','seattle','beniers','tanev','grubauer'],                              winCopy:"Let's go Kraken! 🦑",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`SEA vs ${o} — puck drop!`, hashtags:['#SeattleKraken','#Kraken','#NHL'] },
  SJS: { abbr:'SJS', teamId:28, franchiseId:29, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'San Jose Sharks',        keywords:['sharks','san jose','celebrini','couture','mackeown'],                         winCopy:"Let's go Sharks! 🦈",      lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`SJS vs ${o} — puck drop!`, hashtags:['#SJSharks','#Sharks','#NHL'] },
  STL: { abbr:'STL', teamId:19, franchiseId:18, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'St. Louis Blues',        keywords:['blues','st. louis','thomas','kyrou','binnington'],                            winCopy:"Let's go Blues! 🎵",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`STL vs ${o} — puck drop!`, hashtags:['#STLBlues','#Blues','#NHL'] },
  TBL: { abbr:'TBL', teamId:14, franchiseId:31, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Tampa Bay Lightning',    keywords:['lightning','tampa bay','bolts','stamkos','kucherov','vasilevskiy'],           winCopy:"Let's go Lightning! ⚡",   lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`TBL vs ${o} — puck drop!`, hashtags:['#GoBolts','#TBLightning','#NHL'] },
  TOR: { abbr:'TOR', teamId:10, franchiseId:5,  season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Toronto Maple Leafs',   keywords:['maple leafs','toronto','leafs','matthews','marner','nylander'],                winCopy:"Let's go Leafs! 🍁",       lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`TOR vs ${o} — puck drop!`, hashtags:['#LeafsForever','#TMLtalk','#NHL'] },
  UTA: { abbr:'UTA', teamId:59, franchiseId:40, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Utah Mammoth',           keywords:['mammoth','utah','keller','peterka','villalta'],                               winCopy:"Let's go Mammoth! 🦣",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`UTA vs ${o} — puck drop!`, hashtags:['#TusksUp','#UtahMammoth','#Mammoth','#NHL'] },
  VAN: { abbr:'VAN', teamId:23, franchiseId:20, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Vancouver Canucks',      keywords:['canucks','vancouver','demko','pettersson','hughes'],                          winCopy:"Let's go Canucks! 🏒",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`VAN vs ${o} — puck drop!`, hashtags:['#Canucks','#VanCIty','#NHL'] },
  VGK: { abbr:'VGK', teamId:54, franchiseId:38, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Vegas Golden Knights',   keywords:['golden knights','vegas','knights','marchessault','stone','hill'],              winCopy:"Let's go Knights! ⚔️",     lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`VGK vs ${o} — puck drop!`, hashtags:['#VegasBorn','#GoKnightsGo','#NHL'] },
  WSH: { abbr:'WSH', teamId:15, franchiseId:24, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Washington Capitals',    keywords:['capitals','washington','caps','ovechkin','carlson','kuemper'],                winCopy:"Let's go Caps! 🦅",        lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`WSH vs ${o} — puck drop!`, hashtags:['#ALLCAPS','#Capitals','#NHL'] },
  WPG: { abbr:'WPG', teamId:52, franchiseId:35, season:'20252026', seasonEnd:new Date('2026-07-01'), displayName:'Winnipeg Jets',          keywords:['jets','winnipeg','scheifele','wheeler','hellebuyck'],                          winCopy:"Let's go Jets! ✈️",         lossCopy:'Tough one. Next game.', gameStartBody:(o)=>`WPG vs ${o} — puck drop!`, hashtags:['#GoJetsGo','#NHLJets','#NHL'] },
};

// Resolve team config from a request's ?team= param; falls back to DEFAULT_TEAM_ABBR.
// Use this in every HTTP endpoint that serves team-specific data.
function getTeamConfig(request) {
  const abbr = new URL(request.url).searchParams.get('team')?.toUpperCase() || DEFAULT_TEAM_ABBR;
  return TEAM_CONFIGS[abbr] || TEAM_CONFIGS[DEFAULT_TEAM_ABBR];
}

// The scheduled poll job uses the default team config.
// KV keys, API calls, and notifications in poll() derive from this.
const TEAM_CONFIG = TEAM_CONFIGS[DEFAULT_TEAM_ABBR];

// Convenience aliases for the poll path (unchanged from before)
const { abbr: TEAM_ABBR, teamId: TEAM_ID, season: SEASON, seasonEnd: SEASON_END } = TEAM_CONFIG;

// ── Helpers ───────────────────────────────────────────────────


async function nhlGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'EyeWall-Analytics-Worker/1.0' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`NHL API ${res.status}: ${url}`);
  return res.json();
}

function findLiveGame(games) {
  return games.find(g => g.gameState === 'LIVE' || g.gameState === 'CRIT') || null;
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

async function detectAndNotify(env, liveId, pbp, games) {
  if (!liveId || !pbp?.plays) return;

  const liveGame  = games.find(g => g.id === liveId);
  const isHome    = liveGame?.homeTeam?.abbrev === TEAM_ABBR;
  const carScore  = isHome ? (liveGame?.homeTeam?.score ?? 0) : (liveGame?.awayTeam?.score ?? 0);
  const oppScore  = isHome ? (liveGame?.awayTeam?.score ?? 0) : (liveGame?.homeTeam?.score ?? 0);
  const oppAbbr   = isHome ? liveGame?.awayTeam?.abbrev : liveGame?.homeTeam?.abbrev;
  const playCount = pbp.plays.length;
  const period    = pbp.periodDescriptor?.number || 1;

  const stateKey  = `push:gamestate:${liveId}`;
  const lastState = (await kvGet(env, stateKey)) || {
    carScore: 0, oppScore: 0, playCount: 0, started: false, period: 0,
    carGoalScorers: {}, // { playerId: count } for hat trick tracking
  };

  const lastPlayIdx = lastState.playCount;
  const newPlays    = pbp.plays.slice(lastPlayIdx);
  const periodLabel = n => n === 4 ? 'OT' : n === 5 ? 'SO' : `P${n}`;

  // Broadcast helper with teamAbbr baked in
  const notify = (payload, eventType) => broadcast(env, payload, `NHL:${TEAM_ABBR}`, eventType);

  // ── Game just started ─────────────────────────────────────
  if (!lastState.started && liveGame?.gameState === 'LIVE') {
    await notify({
      title: '🏒 Game Starting!',
      body:  TEAM_CONFIG.gameStartBody(oppAbbr),
      tag:   `game-start-${liveId}`,
      url:   '/',
    }, 'gameStart');
  }

  // ── Period start (P2, P3, OT only — P1 = game start) ─────
  if (period > 1 && period !== lastState.period && liveGame?.gameState === 'LIVE') {
    await notify({
      title: `🏒 ${periodLabel(period)} Starting`,
      body:  `${TEAM_ABBR} ${carScore}–${oppScore} ${oppAbbr} — ${periodLabel(period)} underway`,
      tag:   `period-start-${liveId}-${period}`,
      url:   '/',
    }, 'periodStart');
  }

  // ── Period end ────────────────────────────────────────────
  if (lastState.period > 0 && period > lastState.period && lastState.started) {
    await notify({
      title: `🔔 End of ${periodLabel(lastState.period)}`,
      body:  `${TEAM_ABBR} ${carScore}–${oppScore} ${oppAbbr} after ${periodLabel(lastState.period)}`,
      tag:   `period-end-${liveId}-${lastState.period}`,
      url:   '/',
    }, 'periodEnd');
  }

  // ── Our team scored ───────────────────────────────────────
  const carGoalScorers = { ...lastState.carGoalScorers };
  if (carScore > lastState.carScore) {
    const newGoals = carScore - lastState.carScore;
    const goalPlay = [...pbp.plays].reverse().find(p =>
      p.typeDescKey === 'goal' && p.details?.eventOwnerTeamId === TEAM_ID
    );
    const scorer   = goalPlay?.details?.scoringPlayerName || TEAM_ABBR;
    const scorerId = String(goalPlay?.details?.scoringPlayerId || '');
    const shotType = goalPlay?.details?.shotType || null;
    const isSH     = goalPlay?.details?.situationCode?.charAt(1) === '4'; // strength indicator

    // Track for hat trick
    if (scorerId) {
      carGoalScorers[scorerId] = (carGoalScorers[scorerId] || 0) + newGoals;
    }

    const eventType = isSH ? 'goal' : 'goal'; // SHG is still a goal notif
    await notify({
      title: `🚨 GOAL! ${TEAM_ABBR} ${carScore}–${oppScore} ${oppAbbr}`,
      body:  newGoals > 1
        ? `${newGoals} goals scored!`
        : `${scorer} scores!${shotType ? ` (${shotType})` : ''}${isSH ? ' ⚡ Short-Handed!' : ''}`,
      tag:   `goal-${liveId}-${carScore}`,
      url:   '/',
    }, 'goal');

    // Hat trick check
    if (scorerId && carGoalScorers[scorerId] === 3) {
      await notify({
        title: `🎩 HAT TRICK! ${scorer}`,
        body:  `${scorer} scores their 3rd goal of the game!`,
        tag:   `hattrick-${liveId}-${scorerId}`,
        url:   '/',
      }, 'hatTrick');
    }
  }

  // ── Opponent scored ───────────────────────────────────────
  if (oppScore > lastState.oppScore) {
    const isTied  = carScore === oppScore;
    const leading = carScore > oppScore;
    await notify({
      title: `${oppAbbr} scores. ${TEAM_ABBR} ${carScore}–${oppScore} ${oppAbbr}`,
      body:  isTied  ? `${oppAbbr} ties it up — stay sharp!`
          : leading  ? `Still leading — hold the line!`
          :            `${oppAbbr} takes the lead. Time to push back!`,
      tag:   `opp-goal-${liveId}-${oppScore}`,
      url:   '/',
    }, 'oppGoal');
  }

  // ── Goalie pulled ─────────────────────────────────────────
  const goaliePull = newPlays.find(p =>
    p.typeDescKey === 'goalie-pulled' && p.details?.eventOwnerTeamId !== TEAM_ID
  );
  if (goaliePull) {
    await notify({
      title: `🥅 ${oppAbbr} pulled their goalie!`,
      body:  `6-on-5 — ${TEAM_ABBR} ${carScore}–${oppScore}. Empty net opportunity!`,
      tag:   `goalie-pull-${liveId}-${lastPlayIdx}`,
      url:   '/',
    }, 'goaliePulled');
  }

  // ── Opponent penalty (our power play) ────────────────────
  const oppPenalty = newPlays.find(p =>
    p.typeDescKey === 'penalty' && p.details?.eventOwnerTeamId !== TEAM_ID
  );
  if (oppPenalty) {
    const dur  = oppPenalty.details?.duration || 2;
    const desc = oppPenalty.details?.descKey?.replace(/-/g, ' ') || 'penalty';
    await notify({
      title: `⚡ ${TEAM_ABBR} Power Play!`,
      body:  `${oppAbbr} — ${dur} min ${desc}`,
      tag:   `pp-${liveId}-${lastPlayIdx}`,
      url:   '/',
    }, 'penalty');
  }

  // Save new state
  await kvPut(env, stateKey, {
    carScore, oppScore, playCount, period,
    started: true,
    carGoalScorers,
  }, 24 * 3600);
}

async function notifyGameOver(env, game) {
  const isHome   = game.homeTeam?.abbrev === TEAM_ABBR;
  const carScore = isHome ? game.homeTeam?.score : game.awayTeam?.score;
  const oppScore = isHome ? game.awayTeam?.score : game.homeTeam?.score;
  const oppAbbr  = isHome ? game.awayTeam?.abbrev : game.homeTeam?.abbrev;
  const won      = carScore > oppScore;

  const sentKey     = `push:gameover:${game.id}`;
  const alreadySent = await kvGet(env, sentKey);
  if (alreadySent) return;

  if (won) {
    await broadcast(env, {
      title: `🏆 ${TEAM_ABBR} Win! ${TEAM_ABBR} ${carScore}–${oppScore} ${oppAbbr}`,
      body:  TEAM_CONFIG.winCopy,
      tag:   `win-${game.id}`,
      url:   '/',
    }, `NHL:${TEAM_ABBR}`, 'win');
  } else {
    await broadcast(env, {
      title: `Final: ${TEAM_ABBR} ${carScore}–${oppScore} ${oppAbbr}`,
      body:  TEAM_CONFIG.lossCopy,
      tag:   `final-${game.id}`,
      url:   '/',
    }, `NHL:${TEAM_ABBR}`, 'loss');
  }

  await kvPut(env, sentKey, true, 24 * 3600);

  // Generate AI game summary (once per game, stored in KV)
  await generateGameSummary(env, game).catch(e =>
    console.error('Summary generation error:', e.message)
  );

  // Aggregate shot locations for player heat maps
  await aggregatePlayerShots(env, game).catch(e =>
    console.error('Shot aggregation error:', e.message)
  );
}

// ── Player Shot Aggregation ───────────────────────────────────
async function aggregatePlayerShots(env, game) {
  const gameId  = game.id;
  const doneKey = `shots:done:${gameId}`;
  if (await kvGet(env, doneKey)) return; // already processed

  const isHome = game.homeTeam?.abbrev === TEAM_ABBR;

  // Fetch fresh PBP (may already be in KV from summary generation)
  const pbp = await kvGet(env, `pbp:${gameId}`)
    || await nhlGet(`${NHL_BASE}/gamecenter/${gameId}/play-by-play`).catch(() => null);
  if (!pbp?.plays) return;

  // Build player name map
  const playerMap = {};
  (pbp.rosterSpots || []).forEach(p => {
    if (p.playerId) {
      playerMap[String(p.playerId)] =
        `${p.firstName?.default || ''} ${p.lastName?.default || ''}`.trim();
    }
  });

  // Extract team shot events with coordinates
  const shotTypes = new Set(['shot-on-goal', 'missed-shot', 'blocked-shot', 'goal']);
  const carTeamId = isHome ? game.homeTeam?.id : game.awayTeam?.id;

  const shotsByPlayer = {};
  pbp.plays.forEach(p => {
    if (!shotTypes.has(p.typeDescKey)) return;
    const d = p.details;
    if (!d || d.xCoord == null || d.eventOwnerTeamId !== carTeamId) return;

    const shooterId = String(d.scoringPlayerId || d.shootingPlayerId || '');
    if (!shooterId) return;

    if (!shotsByPlayer[shooterId]) shotsByPlayer[shooterId] = [];
    shotsByPlayer[shooterId].push({
      x: d.xCoord,
      y: d.yCoord,
      t: p.typeDescKey === 'shot-on-goal' ? 's'
       : p.typeDescKey === 'goal'         ? 'g'
       : p.typeDescKey === 'missed-shot'  ? 'm'
       : 'b', // blocked
      p: p.periodDescriptor?.number || 1,
      st: d.shotType || null,
    });
  });

  // Merge into existing season shot data per player
  const TTL_SEASON = 8 * 30 * 24 * 3600; // 8 months
  for (const [playerId, shots] of Object.entries(shotsByPlayer)) {
    const key      = `shots:${TEAM_ABBR}:${playerId}`;
    const existing = (await kvGet(env, key)) || { name: playerMap[playerId] || playerId, shots: [] };
    existing.shots = [...existing.shots, ...shots];
    existing.name  = playerMap[playerId] || existing.name;
    existing.games = (existing.games || 0) + 1;
    await kvPut(env, key, existing, TTL_SEASON);
  }

  // Update the player index
  const indexKey = `shots:${TEAM_ABBR}:index`;
  const index    = (await kvGet(env, indexKey)) || {};
  for (const [playerId, shots] of Object.entries(shotsByPlayer)) {
    index[playerId] = { name: playerMap[playerId] || playerId, count: (index[playerId]?.count || 0) + shots.length };
  }
  await kvPut(env, indexKey, index, TTL_SEASON);

  await kvPut(env, doneKey, true, TTL_SEASON);
  console.log(`Shot aggregation: ${Object.keys(shotsByPlayer).length} ${TEAM_ABBR} players, game ${gameId}`);
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

const MP_SEASON = 20252026;
const MP_YEAR   = String(MP_SEASON).slice(0, 4); // "2025" — MoneyPuck uses start year; bump MP_SEASON next October
const MP_URL    = `https://moneypuck.com/moneypuck/playerData/seasonSummary/${MP_YEAR}/regular/skaters.csv`;
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
    console.log('Fetching MoneyPuck skaters CSV...');
    const res = await fetch(MP_URL, {
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

// fetchOdds() function
async function fetchOdds(env) {
  if (!env.ODDS_API_KEY) return; // silently skip if key not configured

  const kvKey = 'odds:nhl';

  // Skip entirely when there are no upcoming games within 7 days.
  // Avoids burning API quota during offseason and prevents 401 spam
  // when the key is over cap — no games means odds aren't needed anyway.
  const schedule = await kvGet(env, `schedule:${TEAM_ABBR}`) || [];
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

  // Check if still fresh — KV TTL handles expiry, but avoid redundant upstream calls
  // during the same poll cycle if KV already has data
  const existing = await kvGet(env, kvKey);
  if (existing) return; // still valid, nothing to do

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
    // 5 min TTL — pre-game odds don't change faster than that
    await kvPut(env, kvKey, data, 5 * 60);
    console.log(`Odds: cached ${data.length} games`);
  } catch (err) {
    console.warn('Odds fetch error:', err.message);
  }
}

// ── Main poll ─────────────────────────────────────────────────


// ── Main poll (scheduled every 60s) ────────────────────────

export async function poll(env, _ctx) {
  if (new Date().getTime() > SEASON_END.getTime()) { console.log('Season over'); return; }

  // 1. Schedule
  const scheduleData = await nhlGet(`${NHL_BASE}/club-schedule-season/${TEAM_ABBR}/${SEASON}`);
  const games = scheduleData?.games || [];
  await kvPut(env, `schedule:${TEAM_ABBR}`, games, 600);

  // 2. Live game
  const liveGame = findLiveGame(games);
  const liveId   = liveGame?.id || null;
  await kvPut(env, 'live:gameId', liveId, 60);

  // 3. Live PBP + boxscore + push notifications
  let pbpData = null;
  if (liveId) {
    const [pbpRes, bsRes] = await Promise.allSettled([
      nhlGet(`${NHL_BASE}/gamecenter/${liveId}/play-by-play`),
      nhlGet(`${NHL_BASE}/gamecenter/${liveId}/boxscore`),
    ]);
    if (pbpRes.status === 'fulfilled') {
      pbpData = pbpRes.value;
      await kvPut(env, `pbp:${liveId}`, pbpData, 60);
      // Detect goals + events and send push notifications
      if (env.VAPID_PRIVATE_KEY) {
        await detectAndNotify(env, liveId, pbpData, games).catch(e =>
          console.error('Push notification error:', e.message)
        );
      }
    }
    if (bsRes.status === 'fulfilled') {
      await kvPut(env, `boxscore:${liveId}`, bsRes.value, 60);
    }
  } else {
    // Check if a game just ended — notify game over
    const justEnded = [...games]
      .filter(g => isCompleted(g))
      .sort((a, b) => new Date(b.gameDate).getTime() - new Date(a.gameDate).getTime())[0];
    if (justEnded && env.VAPID_PRIVATE_KEY) {
      await notifyGameOver(env, justEnded).catch(e =>
        console.error('Game over notification error:', e.message)
      );
    }
    // Cache most recent completed game PBP
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
      await kvPut(env, 'recentGame:id', justEnded.id, 3600);
    }
  }

  // 4. Standings
  const standings = await nhlGet(`${NHL_BASE}/standings/now`);
  await kvPut(env, 'standings', standings?.standings || [], 300);

  // 5. Team stats
  const exp = `gameTypeId=2 and seasonId=${SEASON} and teamId=${TEAM_ID}`;
  const teamSummary = await nhlGet(
    `${STATS_BASE}/team/summary?isAggregate=false&isGame=false&sort=wins&limit=1&cayenneExp=${encodeURIComponent(exp)}`
  ).catch(() => null);
  if (teamSummary) await kvPut(env, `teamstats:${TEAM_ABBR}`, teamSummary?.data?.[0] || null, 600);

  // 6. Odds (5min TTL — Worker fetches once, all users read from KV)
  await fetchOdds(env).catch(e => console.warn('Odds fetch failed:', e.message));

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

  console.log(`Poll done. Live: ${liveId || 'none'}.`);
}

// ── PP/PK unit refresh ──────────────────────────────────────

export async function refreshPPUnits(env) {
  const season = env.NHL_SEASON || '20252026';
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
    const tc    = getTeamConfig(request);
    const items = await fetchNews(env, tc.abbr);
    return json({ ok: true, count: items.length, team: tc.abbr });
  }

  // GET /news — serve news for any team, fetching on-demand if cache is cold.
  // This is how non-default teams get their news populated: the first visitor
  // triggers a background fetch which populates the 30min KV cache for all
  // subsequent requests. Without this, only the cron-polled default team (CAR)
  // would ever have a warm news cache.
  if (url.pathname === '/news' && request.method === 'GET') {
    const tc      = getTeamConfig(request);
    const cached  = await kvGet(env, `news:${tc.abbr}`);
    if (cached) return json(cached);
    // Cache is cold — fetch in the background and return empty for now so the
    // client doesn't hang. Next request (after ~5s) will get real data.
    ctx.waitUntil(fetchNews(env, tc.abbr).catch(e => console.warn(`News bg fetch ${tc.abbr}:`, e.message)));
    return json([]);
  }

  // On-demand schedule for any team — mirrors the /news pattern.
  // Warm: serve from KV. Cold: fetch in background, return [] immediately.
  // Next request (~2s later) will get real data. Cron keeps CAR warm;
  // all other teams populate on first user request.
  if (url.pathname === '/schedule' && request.method === 'GET') {
    const tc     = getTeamConfig(request);
    const cached = await kvGet(env, `schedule:${tc.abbr}`);
    if (cached) return json(cached);
    ctx.waitUntil((async () => {
      try {
        const data  = await nhlGet(`${NHL_BASE}/club-schedule-season/${tc.abbr}/${tc.season}`);
        const games = data?.games || [];
        await kvPut(env, `schedule:${tc.abbr}`, games, 600);
        console.log(`Schedule bg fetch: ${tc.abbr} (${games.length} games)`);
      } catch (e) {
        console.warn(`Schedule bg fetch ${tc.abbr}: ${e.message}`);
      }
    })());
    return json([]);
  }

  // Health
  if (url.pathname === '/health') {
    const liveId   = await kvGet(env, 'live:gameId');
    const subs     = (await kvGet(env, 'push:subs')) || [];
    return json({ ok: true, liveGameId: liveId, subscribers: subs.length, timestamp: new Date().toISOString() });
  }

  // KV cache read — on a schedule miss, trigger background population
  // so the next request gets real data without a frontend change.
  if (url.pathname.startsWith('/cache/')) {
    const key = decodeURIComponent(url.pathname.slice('/cache/'.length));
    const val = await kvGet(env, key);
    if (val === null) {
      // Background-populate schedule for non-CAR teams on cache miss
      if (key.startsWith('schedule:')) {
        const abbr = key.split(':')[1];
        const tc   = TEAM_CONFIGS[abbr];
        if (tc) {
          ctx.waitUntil((async () => {
            try {
              const data  = await nhlGet(`${NHL_BASE}/club-schedule-season/${tc.abbr}/${tc.season}`);
              const games = data?.games || [];
              await kvPut(env, `schedule:${tc.abbr}`, games, 600);
              console.log(`Schedule bg fetch (cache miss): ${tc.abbr} (${games.length} games)`);
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
      const sources = getNewsSources(cfg);
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
    const tc = getTeamConfig(request);
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

  // Backfill shot data for completed games — processes in batches to avoid timeout
  if (url.pathname === '/shots/backfill') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const tc        = getTeamConfig(request);
    const batchSize = parseInt(url.searchParams.get('batch') || '5', 10);
    const schedule  = await kvGet(env, `schedule:${tc.abbr}`);
    const completed = (schedule || []).filter(g => isCompleted(g));

    // Find unprocessed games
    const unprocessed = [];
    for (const game of completed) {
      const done = await kvGet(env, `shots:done:${game.id}`);
      if (!done) unprocessed.push(game);
    }

    // Process one batch
    const batch = unprocessed.slice(0, batchSize);
    let processed = 0;
    for (const game of batch) {
      if (!await kvGet(env, `pbp:${game.id}`)) {
        const pbpRes = await nhlGet(`${NHL_BASE}/gamecenter/${game.id}/play-by-play`).catch(() => null);
        if (pbpRes) await kvPut(env, `pbp:${game.id}`, pbpRes, 7 * 24 * 3600);
      }
      await aggregatePlayerShots(env, game).catch(e => console.error(`Backfill error game ${game.id}:`, e.message));
      processed++;
    }

    return json({
      ok: true,
      processed,
      remaining: unprocessed.length - processed,
      total: completed.length,
      done: completed.length - unprocessed.length + processed,
    });
  }

  if (url.pathname === '/summary/generate') {
    const secret = url.searchParams.get('secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const tc       = getTeamConfig(request);
    const schedule = await kvGet(env, `schedule:${tc.abbr}`);
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
  // GET /prediction/analyze?gameId=XXX&secret=YYY (optional secret for force-regen)
  if (url.pathname === '/prediction/analyze') {
    const gameId    = url.searchParams.get('gameId');
    const forceRegen = url.searchParams.get('force') === '1';
    if (!gameId) return json({ error: 'gameId required' });
    const tc = getTeamConfig(request);

    const kvKey = `prediction:${gameId}`;

    // Serve from cache if available and not forced
    if (!forceRegen) {
      const cached = await kvGet(env, kvKey);
      if (cached) return json(cached);
    }

    // Fetch standings for both teams
    const standings = await kvGet(env, 'standings') || [];
    const schedule  = await kvGet(env, `schedule:${tc.abbr}`) || [];

    // Find this game
    const game = schedule.find(g => String(g.id) === String(gameId));
    if (!game) return json({ error: 'Game not found in schedule' });

    const isHome    = game.homeTeam?.abbrev === tc.abbr;
    const oppAbbr   = isHome ? game.awayTeam?.abbrev : game.homeTeam?.abbrev;
    const isPlayoff = game.gameType === 3;

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

    // Corsi proxy (SOG share)
    const carCF = carSF + oppSA > 0 ? (carSF / (carSF + oppSA) * 100).toFixed(1) : null;
    const oppCF = oppSF + carSA > 0 ? (oppSF / (oppSF + carSA) * 100).toFixed(1) : null;

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
    const carWinPct = Math.round((carScore / total) * 100);

    const prompt = `You are EyeWall Analytics, a ${tc.displayName} hockey analytics assistant. Write a sharp, data-driven pre-game analysis for ${tc.displayName} fans. 2-3 sentences only. Be specific about the numbers. No filler. No "In this matchup" opener.

Game: ${tc.abbr} (${isHome ? 'HOME' : 'AWAY'}) vs ${oppAbbr}
Context: ${isPlayoff ? 'PLAYOFFS' : 'Regular Season'}

${tc.abbr} stats:
- Record: ${carTeam.wins}-${carTeam.losses}-${carTeam.otLosses} (${carTeam.points} pts)
- GF/GA per game: ${carGpg.toFixed(2)} / ${carGag.toFixed(2)}
- PP%: ${(carTeam.powerPlayPct ?? 0).toFixed(1)}% · PK%: ${(carTeam.penaltyKillPct ?? 0).toFixed(1)}%
- SOG/GP: ${carSF.toFixed(1)} for / ${carSA.toFixed(1)} against
- Corsi proxy (SOG share): ${carCF ?? '—'}%
- Current streak: ${carStreak}

${oppAbbr} stats:
- Record: ${oppTeam.wins}-${oppTeam.losses}-${oppTeam.otLosses} (${oppTeam.points} pts)
- GF/GA per game: ${oppGpg.toFixed(2)} / ${oppGag.toFixed(2)}
- PP%: ${(oppTeam.powerPlayPct ?? 0).toFixed(1)}% · PK%: ${(oppTeam.penaltyKillPct ?? 0).toFixed(1)}%
- SOG/GP: ${oppSF.toFixed(1)} for / ${oppSA.toFixed(1)} against
- Corsi proxy (SOG share): ${oppCF ?? '—'}%
- Current streak: ${oppStreak}

Head-to-head this season: ${tc.abbr} ${h2hRecord}
Expected score (Pythagorean): ${tc.abbr} ${expCar} - ${oppAbbr} ${expOpp}
Model win probability: ${tc.abbr} ${carWinPct}%${isPlayoff ? '\n\nNote: This is a playoff game. Ignore regular season points — focus on possession, goaltending, and recent form.' : ''}

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
      generatedAt: new Date().toISOString(),
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
  if (url.pathname === '/summary/narrative') {
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

  // ── PWHL Player landing — proxy for PWHLPlayerPopup lookups (e.g. from
  // milestone taps). Unlike NHL's /player/landing, this queries Supabase
  // directly instead of an external API — pwhl_players is already the
  // source of truth, no HockeyTech per-player endpoint needed.
  //
  // PWHLPlayerPopup (unlike NHL's PlayerPopup) doesn't fetch its own season
  // stats — it reads goals/points/wins/etc. directly off the player object
  // passed in. So this merges the player's most recent regular-season stat
  // line (pwhl_player_seasons for skaters, pwhl_goalie_seasons for goalies)
  // onto the identity row before returning, rather than returning identity
  // only. "Most recent" is picked via season_id desc rather than a
  // hardcoded season, so this doesn't need updating at the October flip.
  // GET /pwhl/player/landing?id=198
  if (url.pathname === '/pwhl/player/landing') {
    const playerId = url.searchParams.get('id');
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:player:landing:${playerId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbHeaders = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };

    const playerRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_players?player_id=eq.${playerId}&select=*`,
      { headers: sbHeaders }
    );
    if (!playerRes.ok) return new Response(JSON.stringify({ error: `Supabase ${playerRes.status}` }), { status: 502, headers: corsHeaders() });
    const playerRows = await playerRes.json();
    if (!playerRows.length) return new Response(JSON.stringify({ error: 'Player not found' }), { status: 404, headers: corsHeaders() });

    const player = playerRows[0];
    const statsTable = player.position === 'G' ? 'pwhl_goalie_seasons' : 'pwhl_player_seasons';

    const statsRes = await fetch(
      `${SB_URL}/rest/v1/${statsTable}?player_id=eq.${playerId}&season_type=eq.regular&order=season_id.desc&limit=1&select=*`,
      { headers: sbHeaders }
    );
    const statsRows = statsRes.ok ? await statsRes.json() : [];
    const stats = statsRows[0] || {};

    const data = { ...player, ...stats };

    await kvPut(env, kvKey, data, 3600);
    return json(data);
  }

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
