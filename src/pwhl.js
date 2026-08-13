/**
 * pwhl.js — EyeWall Analytics Worker
 *
 * All /pwhl/* HTTP endpoints including standings, players, shots, schedule,
 * roster, last game, PBP, news, salaries, league players, scouting, and live game.
 */

import { kvGet, kvPut, json, corsHeaders, SB_URL, SB_ANON, HT_BASE, HT_KEY, HT_HDR, unwrapJsonp, parseRSS, parseESPN, sendPush, checkAiRateLimit, buildHeadToHeadPayload } from './shared.js';
import { resolvePWHLSeason, getAllPWHLSeasonTypes } from './seasons.js';

// Resolve the ?season= query param, live-resolving the current season
// (see seasons.js) when the param is omitted instead of a hardcoded '8'.
// The frontend normally passes ?season= explicitly (from pwhlConfig.js),
// so this fallback mainly matters for direct/manual endpoint calls and
// during the frontend's own live-lookup rollout.
async function seasonParam(url, env) {
  const raw = url.searchParams.get('season');
  if (raw) return parseInt(raw, 10);
  return (await resolvePWHLSeason(env)).seasonId;
}

// Pulls the server-computed "Total" row out of one careerStats section
// (view=player's Regular Season / Playoffs split), coercing HockeyTech's
// stringified numeric fields (e.g. "16.9") to real numbers and dropping
// season_name/team_name, which don't apply to an aggregate row. Returns
// null if the player has no rows in that section at all (e.g. hasn't made
// the playoffs yet) -- callers must not assume both sections exist.
function extractCareerTotal(sections, title) {
  const section = (sections || []).find(s => s.title === title);
  const totalItem = (section?.data || []).find(item => item.row?.season_name === 'Total');
  if (!totalItem) return null;

  const out = {};
  for (const [k, v] of Object.entries(totalItem.row)) {
    if (k === 'season_name' || k === 'team_name') continue;
    const n = typeof v === 'string' ? Number(v) : v;
    out[k] = typeof v === 'string' && v !== '' && !Number.isNaN(n) ? n : v;
  }
  return out;
}

// Live-fetch + cache HockeyTech's gameCenterPreview view, used by
// /pwhl/preview (season series / H2H / streaks / leaders / special teams).
// 30min TTL — pre-game data (records, streaks) shifts daily, unlike the
// 1hr/24hr TTLs used for Final-game data elsewhere in this file (that
// convention was chosen because Final results don't change).
// /pwhl/prediction deliberately does NOT call this — it stays Supabase-only
// (pwhl_team_seasons + pwhl_game_log), matching how NHL's own
// /prediction/analyze is self-contained from cached standings+schedule with
// no second external view dependency. The richer HockeyTech-sourced H2H
// narrative lives in /pwhl/preview's section of the popup instead.
async function fetchGameCenterPreview(env, gameId) {
  const kvKey = `pwhl:gcpreview:${gameId}`;
  const cached = await kvGet(env, kvKey);
  if (cached) return cached;
  const htRes = await fetch(
    `${HT_BASE}?feed=statviewfeed&view=gameCenterPreview&game_id=${gameId}&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=`,
    { headers: HT_HDR }
  );
  if (!htRes.ok) throw new Error(`HockeyTech ${htRes.status}`);
  const raw = unwrapJsonp(await htRes.text());
  await kvPut(env, kvKey, raw, 1800);
  return raw;
}

// PWHL team ID → abbreviation map
export const PWHL_TEAM_CODES = {
  1:'BOS', 2:'MIN', 3:'MTL', 4:'NY', 5:'OTT', 6:'TOR', 8:'SEA', 9:'VAN',
  // 2026-27 expansion teams — IDs confirmed via HockeyTech's real signing
  // data + team-filter dropdown (docs/hockeytech-api-notes.md, 2026-07-04).
  // Not yet in bootstrap's teams[] (no roster/division assigned pre-season),
  // so these won't show up in live polling until that changes — but wiring
  // the IDs in now means nothing needs manual updating once they do.
  10:'DET', 11:'HAM', 12:'LV', 13:'SJS',
};

const PWHL_NEWS_SOURCES = [
  {
    // The Hockey News — general site feed, filtered for PWHL. Replaces
    // the old espn-pwhl entry (Session: news ingestion investigation --
    // https://www.espn.com/espn/rss/hockey/news 503s; there is no real
    // ESPN "hockey" or "womenshockey" RSS category at all, confirmed by
    // probing several candidate paths, all 503).
    id:     'hockeynews-pwhl',
    name:   'The Hockey News',
    color:  '#FFFFFF',
    bg:     '#0a0a0a',
    url:    'https://thehockeynews.com/feed',
    type:   'rss',
    filter: ['pwhl', "women's hockey", 'women', 'walter cup', 'frost', 'fleet', 'sceptres', 'victoire', 'sirens', 'charge', 'torrent', 'goldeneyes'],
  },
  {
    // The Score hockey — works from Cloudflare IPs, filtered for PWHL
    id:     'thescore-pwhl',
    name:   'The Score',
    color:  '#FFFFFF',
    bg:     '#e8000d',
    url:    'https://origin-feeds.thescore.com/hockey.rss',
    type:   'rss',
    filter: ['pwhl', 'walter cup', 'women'],
  },
  {
    // The Athletic's dedicated women's hockey feed (confirmed live,
    // Session: news ingestion investigation -- 100 PWHL-dense items).
    // The previous URL (theathletic.com/rss/feed/?sport_name=nhl) was the
    // pre-NYT-migration domain -- 301s and dead-ends, plus it was never
    // actually PWHL-scoped in the first place (sport_name=nhl). This one
    // is genuinely women's-hockey-specific, so the filter mostly just
    // guards against stray non-hockey "women's sports" crossover pieces.
    id:     'athletic-pwhl',
    name:   'The Athletic',
    color:  '#FFFFFF',
    bg:     '#222222',
    url:    'https://www.nytimes.com/athletic/rss/womens-hockey/',
    type:   'rss',
    filter: ['pwhl', "women's hockey", 'walter cup', 'women', 'hockey'],
  },
  {
    // Sportsnet — Canadian outlet with strong PWHL coverage
    id:     'sportsnet-pwhl',
    name:   'Sportsnet',
    color:  '#000000',
    bg:     '#d4a017',
    url:    'https://www.sportsnet.ca/feed/',
    type:   'rss',
    filter: ['pwhl', 'walter cup', 'women'],
  },
];

export async function fetchPWHLNews(env) {
  const allItems = [];
  for (const source of PWHL_NEWS_SOURCES) {
    // atom types require GH Actions (CF IPs blocked) — skip for now
    if (source.type === 'atom') continue;
    try {
      console.log(`PWHL news: fetching ${source.id} from ${source.url}`);
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'EyeWall-Analytics/1.0', 'Accept': 'application/rss+xml,text/xml,*/*' },
        cf: { cacheTtl: 0 },
      });
      console.log(`PWHL news: ${source.id} status=${res.status}`);
      if (!res.ok) { console.warn(`PWHL news: ${source.id} failed ${res.status}`); continue; }
      const xml = await res.text();
      let parsed = source.type === 'espn' ? parseESPN(xml, source) : parseRSS(xml, source);
      if (source.filter?.length) {
        parsed = parsed.filter(item => {
          const text = (item.title + ' ' + (item.excerpt || '')).toLowerCase();
          return source.filter.some(kw => text.includes(kw));
        });
      }
      allItems.push(...parsed);
      console.log(`PWHL news: ${source.id} → ${parsed.length} items`);
    } catch (err) {
      console.warn(`PWHL news: ${source.id} error: ${err.message}`);
    }
  }
  const seenIds = new Set();
  const deduped = allItems
    .filter(item => { if (seenIds.has(item.id)) return false; seenIds.add(item.id); return true; })
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  // Merge with whatever's already cached instead of overwriting it
  // (Session: news ingestion investigation) -- this function runs
  // on-demand (a user's cold /pwhl/news request), but /pwhl/news/ingest
  // (eyewall-pipeline's pwhl_news.py, once nightly, a wider and more
  // PWHL-dedicated source list) also writes to this same key. Blindly
  // overwriting meant a user-triggered fetch that found only 1-2 items
  // could wipe out the nightly job's real articles for the rest of the
  // day. Same id-based dedupe/merge pattern as /pwhl/news/ingest itself.
  const existing = (await kvGet(env, 'pwhl:news')) || [];
  const merged = [
    ...deduped,
    ...existing.filter(item => !deduped.find(d => d.id === item.id)),
  ].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, 60);
  // Always write, even when empty (previously this only wrote on a
  // non-empty result, so an all-source outage left the KV key entirely
  // missing rather than holding a cached empty result -- every request
  // during an outage re-triggered all 4 live fetches instead of being
  // absorbed by cache). Short TTL when truly empty so a real recovery is
  // picked up quickly; normal TTL once populated (merged, not just this
  // call's own contribution, since existing nightly content still counts).
  await kvPut(env, 'pwhl:news', merged, merged.length > 0 ? 1800 : 300);
  return merged;
}



// ── PWHL Push Notification Poll ──────────────────────────────
// Called from the Worker scheduled trigger alongside NHL poll().
// Checks for live PWHL games, fetches PBP, detects events,
// and sends push notifications to subscribers.

// Periods when PWHL season is active (roughly Nov–Jun)
function pwhlSeasonActive() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
  return month >= 11 || month <= 6;
}

export async function pollPWHL(env) {
  if (!pwhlSeasonActive()) { console.log('[PWHL poll] Off-season — skipping'); return; }
  if (!env.VAPID_PRIVATE_KEY) return;

  try {
    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const { seasonId: pwhlSeason } = await resolvePWHLSeason(env);

    // Get today's date in Eastern time
    const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = nowET.toISOString().slice(0, 10);

    // Find today's games
    const schedRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?game_date=eq.${todayStr}&season_id=eq.${pwhlSeason}` +
      `&select=game_id,home_team_id,away_team_id,home_score,away_score,game_state&limit=10`,
      { headers: sbH }
    );
    if (!schedRes.ok) return;
    const games = await schedRes.json();
    if (!games?.length) return;

    // Only process in-progress games
    const liveGames = games.filter(g => {
      const gs = (g.game_state || '').toLowerCase();
      return gs.includes('progress') || gs.includes('live') || gs.includes('intermission');
    });
    if (!liveGames.length) return;

    for (const game of liveGames) {
      await pollPWHLGame(env, game).catch(e =>
        console.error(`[PWHL poll] game ${game.game_id}: ${e.message}`)
      );
    }
  } catch (e) {
    console.error('[PWHL poll] error:', e.message);
  }
}

async function pollPWHLGame(env, game) {
  const gameId    = game.game_id;
  const homeId    = game.home_team_id;
  const awayId    = game.away_team_id;
  const homeAbbr  = PWHL_TEAM_CODES[homeId] || String(homeId);
  const awayAbbr  = PWHL_TEAM_CODES[awayId]  || String(awayId);

  // Fetch live PBP from HockeyTech
  const pbpRes = await fetch(
    `${HT_BASE}?feed=statviewfeed&view=gameCenterPlayByPlay&game_id=${gameId}` +
    `&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=`,
    { headers: HT_HDR }
  );
  if (!pbpRes.ok) return;

  let events;
  try {
    const text = (await pbpRes.text()).trim();
    const json  = text.startsWith('(') ? text.slice(1, text.lastIndexOf(')')) : text;
    events = JSON.parse(json);
  } catch { return; }
  if (!Array.isArray(events) || !events.length) return;

  // Load previous state (scores + last processed event index)
  const stateKey = `pwhl:push:state:${gameId}`;
  const lastState = (await kvGet(env, stateKey)) || {
    homeScore: 0, awayScore: 0, eventCount: 0, started: false, period: 0,
    scorerGoalCounts: {}, // { playerId: count } for hat trick tracking
  };

  const newEvents = events.slice(lastState.eventCount);
  const period    = events[events.length - 1]?.details?.period?.id;
  const periodNum = typeof period === 'string' && period.startsWith('OT')
    ? 4 : (parseInt(period, 10) || 1);
  const periodLabel = n => n <= 3 ? `P${n}` : n === 4 ? 'OT' : `OT${n - 3}`;

  const scorerGoalCounts = { ...lastState.scorerGoalCounts };

  // ── Game start ───────────────────────────────────────────
  if (!lastState.started && newEvents.length > 0) {
    const sessionKey = `pwhl:push:start:${gameId}`;
    if (!(await kvGet(env, sessionKey))) {
      await kvPut(env, sessionKey, true, 24 * 3600);
      // Notify both home and away subscribers
      for (const abbr of [homeAbbr, awayAbbr]) {
        await broadcastPWHL(env, {
          title: `🏒 PWHL Game Starting!`,
          body:  `${homeAbbr} vs ${awayAbbr} — puck drop!`,
          tag:   `pwhl-start-${gameId}`,
          url:   '/pwhl/shots',
        }, `PWHL:${abbr}`, 'gameStart');
      }
    }
  }

  // ── Period start (P2+) ───────────────────────────────────
  if (periodNum > 1 && periodNum !== lastState.period) {
    const sessionKey = `pwhl:push:period:${gameId}:${periodNum}`;
    if (!(await kvGet(env, sessionKey))) {
      await kvPut(env, sessionKey, true, 24 * 3600);
      const curHome = game.home_score ?? lastState.homeScore;
      const curAway = game.away_score ?? lastState.awayScore;
      for (const [abbr, myScore, oppScore, oppAbbr] of [
        [homeAbbr, curHome, curAway, awayAbbr],
        [awayAbbr, curAway, curHome, homeAbbr],
      ]) {
        await broadcastPWHL(env, {
          title: `🔔 ${periodLabel(periodNum)} Starting`,
          body:  `${abbr} ${myScore}–${oppScore} ${oppAbbr}`,
          tag:   `pwhl-period-${gameId}-${periodNum}-${abbr}`,
          url:   '/pwhl/shots',
        }, `PWHL:${abbr}`, 'periodStart');
      }
    }
  }

  // ── Process new events ───────────────────────────────────
  for (const ev of newEvents) {
    const type = ev.event;
    const d    = ev.details || {};
    const time = d.time || null;

    if (type === 'goal') {
      const teamId   = parseInt(d.team?.id, 10) || null;
      const isHome   = teamId === homeId;
      const abbr     = isHome ? homeAbbr : awayAbbr;
      const oppAbbr  = isHome ? awayAbbr : homeAbbr;
      const scorer   = d.scoredBy ? `${d.scoredBy.firstName} ${d.scoredBy.lastName}`.trim() : abbr;
      const scorerId = String(d.scoredBy?.id || '');
      const assists  = (d.assists || []).map(a => `${a.firstName} ${a.lastName}`.trim());
      const isPP     = d.properties?.isPowerPlay === '1';
      const isSH     = d.properties?.isShortHanded === '1';
      const isEN     = d.properties?.isEmptyNet === '1';

      // Dedupe by goal ID
      const goalKey = `pwhl:push:goal:${d.game_goal_id || `${gameId}-${teamId}-${time}`}`;
      if (await kvGet(env, goalKey)) continue;
      await kvPut(env, goalKey, true, 24 * 3600);

      // Track for hat trick
      if (scorerId) scorerGoalCounts[scorerId] = (scorerGoalCounts[scorerId] || 0) + 1;

      const modifier = isPP ? ' (PP)' : isSH ? ' (SH)' : isEN ? ' (EN)' : '';
      const curHome  = isHome ? (lastState.homeScore + 1) : lastState.homeScore;
      const curAway  = isHome ? lastState.awayScore : (lastState.awayScore + 1);

      // Notify scoring team subscribers
      await broadcastPWHL(env, {
        title: `🚨 GOAL! ${abbr} ${isHome ? curHome : curAway}–${isHome ? curAway : curHome} ${oppAbbr}`,
        body:  `${scorer} scores!${modifier}${assists.length ? ` Assists: ${assists.slice(0,2).join(', ')}` : ''}`,
        tag:   `pwhl-goal-${goalKey}`,
        url:   '/pwhl/shots',
      }, `PWHL:${abbr}`, 'goal');

      // Notify opp subscribers (they gave up the goal)
      await broadcastPWHL(env, {
        title: `${abbr} scores. ${oppAbbr} ${isHome ? curAway : curHome}–${isHome ? curHome : curAway} ${abbr}`,
        body:  `${scorer} scores for ${abbr}${modifier}`,
        tag:   `pwhl-opp-goal-${goalKey}`,
        url:   '/pwhl/shots',
      }, `PWHL:${oppAbbr}`, 'oppGoal');

      // Hat trick
      if (scorerId && scorerGoalCounts[scorerId] === 3) {
        await broadcastPWHL(env, {
          title: `🎩 HAT TRICK! ${scorer}`,
          body:  `${scorer} scores her 3rd goal of the game for ${abbr}!`,
          tag:   `pwhl-hattrick-${gameId}-${scorerId}`,
          url:   '/pwhl/shots',
        }, `PWHL:${abbr}`, 'hatTrick');
      }
    }

    if (type === 'penalty' && d.isPowerPlay) {
      const penId   = `pwhl:push:pen:${d.game_penalty_id || `${gameId}-${time}`}`;
      if (await kvGet(env, penId)) continue;
      await kvPut(env, penId, true, 24 * 3600);

      // againstTeam = team taking the penalty → other team gets PP
      const penTeamId = parseInt(d.againstTeam?.id, 10) || null;
      const ppTeamId  = penTeamId === homeId ? awayId : homeId;
      const ppAbbr    = PWHL_TEAM_CODES[ppTeamId]  || String(ppTeamId);
      const penAbbr   = PWHL_TEAM_CODES[penTeamId] || String(penTeamId);
      const mins      = parseFloat(d.minutes || '2') || 2;
      const desc      = (d.description || 'Penalty')
        .replace(/^(?:Ob|Maj|Min|Mis|Gm)-/i, '').replace(/-/g, ' ').trim();

      await broadcastPWHL(env, {
        title: `⚡ ${ppAbbr} Power Play!`,
        body:  `${penAbbr} — ${mins} min ${desc}`,
        tag:   `pwhl-pp-${penId}`,
        url:   '/pwhl/shots',
      }, `PWHL:${ppAbbr}`, 'penalty');
    }

    if (type === 'goalie_change' && d.goalieComingIn === null) {
      // Goalie pulled — notify the team that now has the EN opportunity
      const pulledTeamId  = parseInt(d.team_id, 10) || null;
      const benefitTeamId = pulledTeamId === homeId ? awayId : homeId;
      const benefitAbbr   = PWHL_TEAM_CODES[benefitTeamId] || String(benefitTeamId);
      const pulledAbbr    = PWHL_TEAM_CODES[pulledTeamId]  || String(pulledTeamId);
      const pullKey = `pwhl:push:pull:${gameId}-${time}`;
      if (!(await kvGet(env, pullKey))) {
        await kvPut(env, pullKey, true, 24 * 3600);
        await broadcastPWHL(env, {
          title: `🥅 ${pulledAbbr} pulled their goalie!`,
          body:  `6-on-5 — empty net opportunity for ${benefitAbbr}!`,
          tag:   `pwhl-pull-${pullKey}`,
          url:   '/pwhl/shots',
        }, `PWHL:${benefitAbbr}`, 'goaliePulled');
      }
    }
  }

  // ── Game over ────────────────────────────────────────────
  const gs = (game.game_state || '').toLowerCase();
  if (gs === 'final' || gs === 'official') {
    const finalKey = `pwhl:push:final:${gameId}`;
    if (!(await kvGet(env, finalKey))) {
      await kvPut(env, finalKey, true, 48 * 3600);
      const hs = game.home_score ?? 0;
      const as = game.away_score ?? 0;

      // Home team
      await broadcastPWHL(env, hs > as ? {
        title: `🏆 ${homeAbbr} Win! ${homeAbbr} ${hs}–${as} ${awayAbbr}`,
        body:  'Final score — great win!',
        tag:   `pwhl-win-${gameId}-home`,
        url:   '/pwhl/shots',
      } : {
        title: `Final: ${homeAbbr} ${hs}–${as} ${awayAbbr}`,
        body:  'Final score.',
        tag:   `pwhl-final-${gameId}-home`,
        url:   '/pwhl/shots',
      }, `PWHL:${homeAbbr}`, hs > as ? 'win' : 'loss');

      // Away team
      await broadcastPWHL(env, as > hs ? {
        title: `🏆 ${awayAbbr} Win! ${awayAbbr} ${as}–${hs} ${homeAbbr}`,
        body:  'Final score — great win!',
        tag:   `pwhl-win-${gameId}-away`,
        url:   '/pwhl/shots',
      } : {
        title: `Final: ${awayAbbr} ${as}–${hs} ${homeAbbr}`,
        body:  'Final score.',
        tag:   `pwhl-final-${gameId}-away`,
        url:   '/pwhl/shots',
      }, `PWHL:${awayAbbr}`, as > hs ? 'win' : 'loss');
    }
  }

  // Save state
  await kvPut(env, stateKey, {
    homeScore:        game.home_score ?? lastState.homeScore,
    awayScore:        game.away_score ?? lastState.awayScore,
    eventCount:       events.length,
    started:          true,
    period:           periodNum,
    scorerGoalCounts,
  }, 24 * 3600);
}

// PWHL-specific broadcast — wraps shared broadcast with PWHL: prefixed teamAbbr
async function broadcastPWHL(env, payload, teamKey, eventType) {
  // Import broadcast from nhl.js isn't possible (circular) — inline the lookup here
  const subs = (await kvGet(env, 'push:subs')) || [];
  if (!subs.length) return;

  const targets = subs.filter(s => {
    const subTeam = s.teamAbbr || 'NHL:CAR';
    if (subTeam !== teamKey) return false;
    if (!s.prefs) return true;
    return s.prefs[eventType] !== false;
  });

  if (!targets.length) return;

  console.log(`[PWHL push] ${targets.length} targets for ${teamKey}:${eventType}`);

  const results = await Promise.all(targets.map(s => sendPush(s, payload, env)));

  // Prune expired subs
  const expiredEndpoints = new Set(
    targets.filter((_, i) => results[i] === 'expired').map(s => s.endpoint)
  );
  if (expiredEndpoints.size > 0) {
    const allSubs = (await kvGet(env, 'push:subs')) || [];
    const active = allSubs.filter(s => !expiredEndpoints.has(s.endpoint));
    await kvPut(env, 'push:subs', active, 365 * 24 * 3600);
  }
  console.log(`[PWHL push] results: ${results.join(', ')}`);
}

export async function handlePWHL(request, env, ctx, url) {
  // ── PWHL endpoints ─────────────────────────────────────────────────────────

  if (url.pathname === '/pwhl/standings') {
    const season = await seasonParam(url, env);
    const kvKey  = `pwhl:standings:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const [standRes, gameRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/pwhl_team_seasons?season_id=eq.${season}&season_type=eq.regular&order=points.desc&limit=12`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/pwhl_game_log?season_id=eq.${season}&game_state=eq.Final&order=game_id.desc&limit=500&select=game_id,home_team_id,away_team_id,home_score,away_score,ot,shootout`, { headers: sbH }),
    ]);
    if (!standRes.ok) return new Response(JSON.stringify({ error: `Supabase ${standRes.status}` }), { status: 502, headers: corsHeaders() });
    const rows  = await standRes.json();
    const games = gameRes.ok ? await gameRes.json() : [];

    // Compute L10 and streak per team from recent game log
    const teamStats = {};
    for (const g of games) {
      for (const [tid,, myScore, oppScore] of [
        [g.home_team_id, g.away_team_id, g.home_score, g.away_score],
        [g.away_team_id, g.home_team_id, g.away_score, g.home_score],
      ]) {
        if (!tid) continue;
        if (!teamStats[tid]) teamStats[tid] = { games: [], streak: 0, streakType: '' };
        const won   = myScore > oppScore;
        const extra = g.ot || g.shootout;
        const result = won ? 'W' : extra ? 'O' : 'L'; // O = OT loss
        teamStats[tid].games.push(result);
      }
    }
    // L10: last 10 games (already desc by game_id, so first 10 = most recent)
    const enriched = rows.map(r => {
      const ts = teamStats[r.team_id];
      if (!ts) return r;
      const last10 = ts.games.slice(0, 10);
      const l10W   = last10.filter(x => x === 'W').length;
      const l10OTL = last10.filter(x => x === 'O').length;
      const l10L   = last10.filter(x => x === 'L').length;
      // Streak: consecutive same result from most recent
      let streak = 0, streakType = '';
      for (const res of ts.games) {
        if (!streakType) { streakType = res === 'W' ? 'W' : 'L'; streak = 1; }
        else if ((res === 'W' && streakType === 'W') || (res !== 'W' && streakType === 'L')) streak++;
        else break;
      }
      return { ...r, l10W, l10OTL, l10L, streakType, streakCount: streak };
    });
    await kvPut(env, kvKey, enriched, 3600);
    return json(enriched);
  }

  // Season-over-season team comparison (Session 64) -- box-score fields
  // only (wins/losses/points/goals-for-against/PP%/PK%), mirroring NHL's
  // /team-seasons/compare. Deliberately excludes corsi_for/corsi_for_5v5 and
  // roster_war_score/xgf_pct -- null across PWHL team-seasons right now
  // (confirmed via direct query, SESSION_63_FINDINGS.md), not just for
  // older seasons. Filters by season_id only (not season_type) -- each
  // season_id already maps to exactly one type per HockeyTech's bootstrap,
  // same grouping /config/seasons/comparison uses. Missing seasons for the
  // requested team are simply absent from the response array; the frontend
  // already knows which seasons it asked for and renders the gap itself.
  if (url.pathname === '/pwhl/team-seasons/compare') {
    const teamId  = parseInt(url.searchParams.get('teamId') || '0', 10);
    const seasons = (url.searchParams.get('seasons') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!teamId || seasons.length === 0) {
      return new Response(JSON.stringify({ error: 'teamId and seasons (comma-separated) are required' }), { status: 400, headers: corsHeaders() });
    }
    const kvKey  = `pwhl:team-seasons:compare:${teamId}:${seasons.slice().sort().join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const res = await fetch(
      `${SB_URL}/rest/v1/pwhl_team_seasons?team_id=eq.${teamId}&season_id=in.(${seasons.join(',')})` +
      `&select=season_id,season_type,gp,wins,losses,ot_losses,points,goals_for,goals_against,pp_pct,pk_pct`,
      { headers: sbH }
    );
    if (!res.ok) return new Response(JSON.stringify({ error: `Supabase ${res.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await res.json();

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // Two-team, same-season comparison (Session 86, Team vs Team Mode 1) --
  // mirrors NHL's /team-seasons/compare-teams. Same "missing row is the
  // frontend's gap to render" convention as /pwhl/team-seasons/compare.
  if (url.pathname === '/pwhl/team-seasons/compare-teams') {
    const teamIds = (url.searchParams.get('teamIds') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
    const season  = url.searchParams.get('season');
    if (teamIds.length !== 2 || teamIds.some(id => !id) || !season) {
      return new Response(JSON.stringify({ error: 'teamIds (exactly two, comma-separated) and season are required' }), { status: 400, headers: corsHeaders() });
    }

    const kvKey  = `pwhl:team-seasons:compare-teams:${teamIds.slice().sort((a, b) => a - b).join(',')}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const res = await fetch(
      `${SB_URL}/rest/v1/pwhl_team_seasons?team_id=in.(${teamIds.join(',')})&season_id=eq.${season}` +
      `&select=team_id,season_id,season_type,gp,wins,losses,ot_losses,points,goals_for,goals_against,pp_pct,pk_pct`,
      { headers: sbH }
    );
    if (!res.ok) return new Response(JSON.stringify({ error: `Supabase ${res.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await res.json();

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // All-time head-to-head between two teams, across every season on record
  // (Session 88, Team vs Team Mode 2) -- PWHL analog of NHL's
  // /team-seasons/head-to-head. Unlike NHL's game_log (one row per team per
  // game), pwhl_game_log is one row per game with both teams in columns, so
  // this needs the OR-of-AND home/away filter already established for
  // single-season PWHL head-to-head elsewhere in this file, just without a
  // season_id filter so it spans every season. game_state=eq.Final excludes
  // in-progress/future games, matching this file's other game_log reads.
  if (url.pathname === '/pwhl/team-seasons/head-to-head') {
    const teamIds = (url.searchParams.get('teamIds') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
    if (teamIds.length !== 2 || teamIds.some(id => !id)) {
      return new Response(JSON.stringify({ error: 'teamIds (exactly two, comma-separated) are required' }), { status: 400, headers: corsHeaders() });
    }
    const [teamA, teamB] = teamIds;

    const kvKey  = `pwhl:team-seasons:head-to-head:${teamIds.slice().sort((a, b) => a - b).join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const res = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?game_state=eq.Final` +
      `&or=(and(home_team_id.eq.${teamA},away_team_id.eq.${teamB}),and(home_team_id.eq.${teamB},away_team_id.eq.${teamA}))` +
      `&select=game_id,season_id,game_date,home_team_id,away_team_id,home_score,away_score` +
      `&order=season_id.asc,game_id.asc`,
      { headers: sbH }
    );
    if (!res.ok) return new Response(JSON.stringify({ error: `Supabase ${res.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await res.json();

    const payload = buildHeadToHeadPayload(teamA, teamB, rows.map(g => {
      const aIsHome = g.home_team_id === teamA;
      const teamAScore = aIsHome ? g.home_score : g.away_score;
      const teamBScore = aIsHome ? g.away_score : g.home_score;
      return {
        gameId: g.game_id, season: g.season_id, gameDate: g.game_date,
        teamAWon: teamAScore > teamBScore,
        teamAScore, teamBScore, homeTeam: aIsHome ? teamA : teamB,
      };
    }));

    await kvPut(env, kvKey, payload, 3600);
    return json(payload);
  }

  // AI narrative layer on top of the head-to-head stats above (Session 90
  // fast-follow to Session 88's templated record/window/streak) -- PWHL
  // analog of nhl.js's /team-seasons/head-to-head/narrative. Client posts
  // the payload it already fetched from /pwhl/team-seasons/head-to-head
  // plus display names (this Worker has no PWHL team-name map of its own --
  // pwhlConfig.js on the frontend does -- same reason /pwhl/summary/narrative
  // above takes carName/oppName from the client instead of resolving them
  // server-side). Prompt is hand-rolled here, not shared with nhl.js's
  // version -- see that route's comment for why.
  if (url.pathname === '/pwhl/team-seasons/head-to-head/narrative' && request.method === 'POST') {
    const limited = await checkAiRateLimit(env, request, 'pwhl-h2h-narrative');
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

    const kvKey  = `pwhl:h2h-narrative:${[teamA, teamB].slice().sort((a, b) => a - b).join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const aDisplay = teamADisplay || String(teamA);
    const bDisplay = teamBDisplay || String(teamB);
    const streakLine = currentStreak
      ? `Current streak: ${currentStreak.holder === 'A' ? aDisplay : bDisplay} has won ${currentStreak.count} straight.`
      : 'No active streak.';
    // Thin-sample guardrail -- common for PWHL given expansion teams have
    // only played a handful of games against some opponents. Same
    // discipline the templated UI already applies (isThinSample), so the
    // AI narrative doesn't undo it with confident-sounding prose.
    const thinSampleNote = isThinSample
      ? `\nIMPORTANT: Only ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'} exist between these teams. Do not describe this as a "trend," "rivalry," or "dominance" -- that's too small a sample to support it. It's fine to note the limited history plainly.`
      : '';

    const prompt = `You are Sticks, EyeWall's hockey analyst. Write a punchy 2-3 sentence head-to-head summary for ${aDisplay} vs ${bDisplay}.

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
      console.error('[PWHL] head-to-head narrative AI error:', e);
      return new Response(JSON.stringify({ error: 'AI generation failed' }), { status: 502, headers: corsHeaders() });
    }
  }

  // GET /pwhl/players?teamId=1&season=8
  if (url.pathname === '/pwhl/players') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:players:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const sbHeaders = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const [skatersRes, goaliesRes, rosterRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/pwhl_player_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.regular&order=points.desc&limit=40`,
        { headers: sbHeaders }
      ),
      fetch(
        `${SB_URL}/rest/v1/pwhl_goalie_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.regular&order=gp.desc&limit=5`,
        { headers: sbHeaders }
      ),
      // Fetch current team roster (for Roster tab) AND all players (for name resolution across seasons)
      fetch(
        `${SB_URL}/rest/v1/pwhl_players?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number,birth_date,birth_city,shoots&limit=80`,
        { headers: sbHeaders }
      ),
    ]);
    if (!skatersRes.ok || !goaliesRes.ok || !rosterRes.ok) {
      return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    }
    const [skaters, goalies, rosterRaw] = await Promise.all([skatersRes.json(), goaliesRes.json(), rosterRes.json()]);

    // Also fetch all players for name resolution (past season players may have moved teams)
    const allPlayersRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_players?select=player_id,first_name,last_name,position,jersey_number,birth_date,birth_city,shoots&limit=500`,
      { headers: sbHeaders }
    );
    const allPlayers = allPlayersRes.ok ? await allPlayersRes.json() : rosterRaw;

    // Build player_id -> bio map from all players (not just current team)
    const nameMap = {};
    for (const p of allPlayers) {
      nameMap[p.player_id] = {
        player_name:   `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        first_name:    p.first_name || null,
        last_name:     p.last_name  || null,
        position:      p.position   || null,
        jersey_number: p.jersey_number || null,
        birth_date:    p.birth_date || null,
        birth_city:    p.birth_city || null,
        shoots:        p.shoots     || null,
        headshot:      `https://assets.leaguestat.com/pwhl/240x240/${p.player_id}.jpg`,
      };
    }
    const skatersWithNames = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
    const goaliesWithNames = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));

    // Roster tab: current team players sorted by jersey number (nulls last)
    const rosterFull = rosterRaw
      .map(p => ({ ...p, headshot: `https://assets.leaguestat.com/pwhl/240x240/${p.player_id}.jpg` }))
      .sort((a,b) => {
        if (a.jersey_number == null && b.jersey_number == null) return 0;
        if (a.jersey_number == null) return 1;
        if (b.jersey_number == null) return -1;
        return a.jersey_number - b.jersey_number;
      });
    const result = { skaters: skatersWithNames, goalies: goaliesWithNames, roster: rosterFull };
    await kvPut(env, kvKey, result, 3600);
    return json(result);
  }

  // GET /pwhl/shots?teamId=1&season=8
  // Paginates through all rows in batches of 1000 to bypass Supabase row cap.
  if (url.pathname === '/pwhl/shots') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:shots:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const PAGE = 1000;
    const allRows = [];
    let offset = 0;
    while (true) {
      const r = await fetch(
        `${SB_URL}/rest/v1/pwhl_shot_events?team_id=eq.${teamId}&season_id=eq.${season}&order=game_id.asc`,
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
      if (rows.length < PAGE) break; // last page
      offset += PAGE;
    }
    await kvPut(env, kvKey, allRows, 3600); // 1hr TTL
    console.log(`PWHL shots: teamId=${teamId} season=${season} total=${allRows.length}`);
    return json(allRows);
  }

  // GET /pwhl/team-season-summary?teamId=1&season=8
  // Season-aggregate SOG/Blocks/Hits/Penalties/FO% for the Shot Map's
  // "All N" summary cards -- counts only (aggregated here, not raw rows),
  // since the frontend only needs totals for this view, not per-shot
  // coordinates the way /pwhl/shots's rink-dot consumers do.
  //
  // /pwhl/shots (above) only ever returns the requested team's own shot
  // rows (team_id=eq.), which is enough for that route's existing rink-dot
  // consumers but can't answer "how many shots did opponents take against
  // this team all season" -- there's no single "the opponent" for a whole
  // season, only "whichever team we played in each specific game." Same
  // problem NHL's /nhl/shots solves by resolving the team's own completed
  // game_ids first, then querying by game_id IN (...) instead of by team
  // -- that pulls both sides' rows for exactly the games this team played,
  // letting team_id on each row split "us" from "them" per game. Mirrored
  // here against pwhl_shot_events and pwhl_pbp_events.
  //
  // pwhl_pbp_events' faceoff rows store the WINNING team's id (see
  // pwhl_pbp_events.py) -- car/opp faceoff counts below are win counts,
  // not attempts, same convention ShotMapView.jsx's per-game faceoff card
  // already uses.
  if (url.pathname === '/pwhl/team-season-summary') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:team-season-summary:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };

    const gameRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&select=game_id`,
      { headers: sbH }
    );
    if (!gameRes.ok) return new Response(JSON.stringify({ error: `Supabase ${gameRes.status}` }), { status: 502, headers: corsHeaders() });
    const gameIds = (await gameRes.json()).map(g => g.game_id);

    const empty = {
      teamId, season, gamesPlayed: gameIds.length,
      sog: { car: 0, opp: 0 }, blocked: { car: 0, opp: 0 },
      hits: { car: 0, opp: 0 }, penalties: { car: 0, opp: 0 },
      faceoff: { car: 0, opp: 0, pct: null },
      ppPct: null, pkPct: null,
    };
    if (!gameIds.length) {
      await kvPut(env, kvKey, empty, 3600);
      return json(empty);
    }

    // Paginated fetch — aggregated into counters below rather than
    // returned as raw rows (a full season can be 2000+ shot/pbp rows).
    async function fetchAndCount(table, select, tally) {
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const r = await fetch(
          `${SB_URL}/rest/v1/${table}?game_id=in.(${gameIds.join(',')})&select=${select}`,
          {
            headers: {
              ...sbH,
              'Range':      `${offset}-${offset + PAGE - 1}`,
              'Range-Unit': 'items',
              'Prefer':     'count=none',
            },
          }
        );
        if (!r.ok) throw new Error(`Supabase ${r.status} (${table})`);
        const rows = await r.json();
        rows.forEach(tally);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
    }

    let sogCar = 0, sogOpp = 0, blkCar = 0, blkOpp = 0;
    let hitCar = 0, hitOpp = 0, penCar = 0, penOpp = 0, foCar = 0, foOpp = 0;
    try {
      await fetchAndCount('pwhl_shot_events', 'team_id,event_type', row => {
        const isCar = row.team_id === teamId;
        if (row.event_type === 'shot' || row.event_type === 'goal') { isCar ? sogCar++ : sogOpp++; }
        // team_id on a blocked_shot row is the shooter's team (same as every
        // other event_type here) -- "car" blocks = car's OWN shots that got
        // blocked, matching PWHLShotMapView.jsx's existing per-game
        // shotStats.blocks (ourShotEvents.filter('blocked-shot'), taken at
        // face value, no shooter/blocker inversion). Do not "fix" this to
        // NHL's inverted blocker-credit convention -- it would flip car/opp
        // relative to what the per-game view already shows for the same team.
        else if (row.event_type === 'blocked_shot') { isCar ? blkCar++ : blkOpp++; }
      });
      await fetchAndCount('pwhl_pbp_events', 'team_id,event_type', row => {
        const isCar = row.team_id === teamId;
        if (row.event_type === 'hit') { isCar ? hitCar++ : hitOpp++; }
        else if (row.event_type === 'penalty') { isCar ? penCar++ : penOpp++; }
        else if (row.event_type === 'faceoff') { isCar ? foCar++ : foOpp++; } // team_id = winner
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    // Season PP%/PK% — already computed and stored, same source /pwhl/standings reads.
    const tsRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_team_seasons?team_id=eq.${teamId}&season_id=eq.${season}&select=pp_pct,pk_pct`,
      { headers: sbH }
    );
    const tsRow = tsRes.ok ? (await tsRes.json())[0] : null;

    const totalFO = foCar + foOpp;
    const data = {
      teamId, season, gamesPlayed: gameIds.length,
      sog: { car: sogCar, opp: sogOpp },
      blocked: { car: blkCar, opp: blkOpp },
      hits: { car: hitCar, opp: hitOpp },
      penalties: { car: penCar, opp: penOpp },
      faceoff: { car: foCar, opp: foOpp, pct: totalFO > 0 ? (foCar / totalFO * 100) : null },
      ppPct: tsRow?.pp_pct ?? null,
      pkPct: tsRow?.pk_pct ?? null,
    };
    await kvPut(env, kvKey, data, 3600);
    console.log(`PWHL team-season-summary: teamId=${teamId} season=${season} games=${gameIds.length}`);
    return json(data);
  }

  // GET /pwhl/schedule?teamId=1&season=8
  // game_log has home_team_id / away_team_id — filter both sides with OR
  if (url.pathname === '/pwhl/schedule') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:schedule:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?season_id=eq.${season}&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_date.asc&limit=150`,
      { headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 1800);
    return json(rows);
  }

  // GET /pwhl/roster?teamId=1
  // Returns player list for name resolution in shot map tooltips.
  if (url.pathname === '/pwhl/roster') {
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:roster:${teamId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/pwhl_players?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number&limit=60`,
      { headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 24 * 3600); // 24hr — roster rarely changes
    return json(rows);
  }

  // GET /pwhl/game-box?gameId=210
  // Per-player box score (skaters + goalies) for the PWHL game-stats popup
  // (Session 50). Flat arrays with team_id on each row, matching the
  // pwhl_skater_game_box/pwhl_goalie_game_box table shape directly -- the
  // frontend already has home_team_id/away_team_id from the schedule fetch
  // and groups client-side, same flat-list convention as /pwhl/shots rather
  // than NHL boxscore's nested homeTeam/awayTeam shape.
  if (url.pathname === '/pwhl/game-box') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId param required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:game-box:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const [skRes, gRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/pwhl_skater_game_box?game_id=eq.${gameId}&order=team_id.asc`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/pwhl_goalie_game_box?game_id=eq.${gameId}&order=team_id.asc`, { headers: sbH }),
    ]);
    if (!skRes.ok) return new Response(JSON.stringify({ error: `Supabase ${skRes.status}` }), { status: 502, headers: corsHeaders() });
    if (!gRes.ok)  return new Response(JSON.stringify({ error: `Supabase ${gRes.status}` }),  { status: 502, headers: corsHeaders() });

    const payload = { skaters: await skRes.json(), goalies: await gRes.json() };
    await kvPut(env, kvKey, payload, 24 * 3600); // 24hr -- Final-game box scores don't change once ingested
    return json(payload);
  }

  // GET /pwhl/player-game-log?playerId=198&seasonId=8
  // Per-player, per-season game-by-game box score rows for the player
  // Compare tab's trend charts (Session 70). Unlike /pwhl/game-box above
  // (one game, all players), this is one player, all games in a season --
  // queries the same two tables, filtered the other way. Returns both
  // skaters + goalies rows the same flat-arrays shape as /pwhl/game-box;
  // the frontend already knows the player's position and just reads
  // whichever array is non-empty, same convention as that route.
  if (url.pathname === '/pwhl/player-game-log') {
    const playerId = parseInt(url.searchParams.get('playerId') || '0', 10);
    const seasonId = parseInt(url.searchParams.get('seasonId') || '0', 10);
    if (!playerId || !seasonId) {
      return new Response(JSON.stringify({ error: 'playerId and seasonId params required' }), { status: 400, headers: corsHeaders() });
    }

    const kvKey  = `pwhl:player-game-log:${playerId}:${seasonId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const [skRes, gRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/pwhl_skater_game_box?player_id=eq.${playerId}&season_id=eq.${seasonId}&order=game_id.asc`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/pwhl_goalie_game_box?player_id=eq.${playerId}&season_id=eq.${seasonId}&order=game_id.asc`, { headers: sbH }),
    ]);
    if (!skRes.ok) return new Response(JSON.stringify({ error: `Supabase ${skRes.status}` }), { status: 502, headers: corsHeaders() });
    if (!gRes.ok)  return new Response(JSON.stringify({ error: `Supabase ${gRes.status}` }),  { status: 502, headers: corsHeaders() });

    const payload = { skaters: await skRes.json(), goalies: await gRes.json() };
    // 24hr -- same rationale as /pwhl/game-box: completed-game rows don't
    // change once ingested, and a player's current-season log only grows
    // by one row per new game, not worth a shorter TTL.
    await kvPut(env, kvKey, payload, 24 * 3600);
    return json(payload);
  }

  // GET /pwhl/player/landing?id=198&season=8
  // Player detail lookup for PWHLPlayerPopup — self-fetches identity + a
  // season's stat line by id, the same role NHL's own /player/landing
  // (proxying api-web.nhle.com) plays for NHL's PlayerPopup. Unlike NHL's
  // route, this queries Supabase directly — pwhl_players is already the
  // source of truth, no HockeyTech per-player endpoint needed.
  //
  // ?season= pins the stat line to that season_id (the frontend's season
  // picker passes the exact id it's showing, e.g. PWHLPlayersView's Stats
  // tab); omitted, falls back to the most recent regular-season row so
  // season-agnostic callers (MilestonesFeed) keep working unchanged.
  if (url.pathname === '/pwhl/player/landing') {
    const playerId    = url.searchParams.get('id');
    const seasonParam = url.searchParams.get('season');
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:player:landing:${playerId}:${seasonParam || 'latest'}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };

    const playerRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_players?player_id=eq.${playerId}&select=*`,
      { headers: sbH }
    );
    if (!playerRes.ok) return new Response(JSON.stringify({ error: `Supabase ${playerRes.status}` }), { status: 502, headers: corsHeaders() });
    const playerRows = await playerRes.json();
    if (!playerRows.length) return new Response(JSON.stringify({ error: 'Player not found' }), { status: 404, headers: corsHeaders() });

    const player = playerRows[0];
    const statsTable = player.position === 'G' ? 'pwhl_goalie_seasons' : 'pwhl_player_seasons';
    const statsQuery = seasonParam
      ? `player_id=eq.${playerId}&season_id=eq.${seasonParam}&season_type=eq.regular&limit=1&select=*`
      : `player_id=eq.${playerId}&season_type=eq.regular&order=season_id.desc&limit=1&select=*`;

    const statsRes = await fetch(`${SB_URL}/rest/v1/${statsTable}?${statsQuery}`, { headers: sbH });
    const statsRows = statsRes.ok ? await statsRes.json() : [];
    const stats = statsRows[0] || {};

    const data = { ...player, ...stats };

    await kvPut(env, kvKey, data, 3600);
    return json(data);
  }

  // GET /pwhl/player/percentiles?id=198&season=8&seasonType=regular
  // PWHL analog of NHL's /player-analytics (nhl.js) -- but shaped as a
  // single player/season/season_type lookup (like this file's own
  // /pwhl/player/landing above) rather than NHL's bulk whole-season fetch.
  // NHL's route returns every player_seasons row for a season because
  // MoneyPuck-derived percentiles there are computed client-side (in this
  // Worker) from a full league CSV each time; PWHL's percentiles are
  // instead precomputed league-wide by the Python pipeline
  // (eyewall-pipeline#36, pwhl_percentiles.py) and stored directly on
  // pwhl_player_seasons, so there's nothing to compute here -- just a
  // straight read of one row, matching /pwhl/player/landing's convention.
  //
  // Conflict key on pwhl_player_seasons is
  // player_id,team_id,season_id,season_type -- ?season= pins season_id the
  // same way /pwhl/player/landing's ?season= does; season_type defaults to
  // 'regular' (the common case) and can be overridden for playoffs.
  //
  // Sequencing note: toi_per_game/xg_for/finishing/pct_* columns come from
  // eyewall-pipeline#36, which was open (not yet merged/DDL-applied) at the
  // time this route was written. Until that DDL lands in production, this
  // query will 502 (unknown column) rather than return nulls -- see this
  // PR's description for the merge-order dependency. Once the columns
  // exist, an unqualified/pre-pipeline row (or a player who hasn't cleared
  // pwhl_percentiles.py's GP threshold) still resolves cleanly here: no row
  // found, or found with pct_* all null, both return 200 with null
  // percentile fields rather than a 404/error, same "not enough data yet"
  // convention as NHL's results_vs_process/on_ice_gf_pct nulls.
  if (url.pathname === '/pwhl/player/percentiles') {
    const playerId    = url.searchParams.get('id');
    const seasonQuery = url.searchParams.get('season');
    const seasonType  = url.searchParams.get('seasonType') || 'regular';
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:player:percentiles:${playerId}:${seasonQuery || 'latest'}:${seasonType}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const cols = 'player_id,team_id,season_id,season_type,toi_per_game,xg_for,finishing,' +
      'pct_goals,pct_a1,pct_penalties,pct_finishing';
    const statsQuery = seasonQuery
      ? `player_id=eq.${playerId}&season_id=eq.${seasonQuery}&season_type=eq.${seasonType}&limit=1&select=${cols}`
      : `player_id=eq.${playerId}&season_type=eq.${seasonType}&order=season_id.desc&limit=1&select=${cols}`;

    let rows;
    try {
      const r = await fetch(`${SB_URL}/rest/v1/pwhl_player_seasons?${statsQuery}`, { headers: sbH });
      if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
      rows = await r.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    const row = rows[0] || {};
    const data = {
      player_id:   parseInt(playerId, 10),
      team_id:     row.team_id ?? null,
      season_id:   row.season_id ?? (seasonQuery ? parseInt(seasonQuery, 10) : null),
      season_type: row.season_type ?? seasonType,
      toi_per_game: row.toi_per_game ?? null,
      xg_for:       row.xg_for       ?? null,
      finishing:    row.finishing    ?? null,
      // Nulls (no row yet, or row exists but pct_* not populated) fall
      // through as-is -- the frontend already treats null percentiles as
      // "not enough data yet" rather than an error state.
      percentiles: {
        goals:     { pct: row.pct_goals     ?? null, label: 'Goals',       note: 'Percentile rank vs league, goals' },
        a1:        { pct: row.pct_a1        ?? null, label: '1st Assists', note: 'Percentile rank vs league, primary assists' },
        penalties: { pct: row.pct_penalties ?? null, label: 'Penalties',   note: 'Percentile rank vs league, penalty discipline' },
        finishing: { pct: row.pct_finishing ?? null, label: 'Finishing',   note: 'Percentile rank vs league, goals above xGoals' },
      },
    };

    await kvPut(env, kvKey, data, 3600); // 1hr -- matches /pwhl/player/landing's TTL
    return json(data);
  }

  // GET /pwhl/player/career?id=198
  // Live proxy for HockeyTech's view=player careerStats Total rows -- the
  // server already computes correctly-weighted career totals server-side
  // (SESSION_74_FINDINGS_pwhl_career_investigation.md Q1: verified live
  // that rate stats like shooting_percentage/savepct are real weighted
  // recomputations from summed raw counts, not per-season averages), so
  // this route does zero aggregation math of its own -- same
  // live-HockeyTech-call shape as /pwhl/summary and /pwhl/preview, NOT
  // /pwhl/player/landing (that one reads from Supabase, despite the
  // similar name/pattern).
  //
  // No ?season= param -- confirmed live that careerStats is season-
  // independent (identical Total rows whether season_id is omitted or set
  // to an arbitrary/old value), so there's nothing to resolve here.
  //
  // 24hr TTL -- career totals only change when the player plays a new
  // game, same infrequency class as other season-long PWHL data in this
  // file.
  if (url.pathname === '/pwhl/player/career') {
    const playerId = url.searchParams.get('id');
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:player:career:${playerId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const htRes = await fetch(
      `${HT_BASE}?feed=statviewfeed&view=player&player_id=${playerId}&site_id=0&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=&statsType=standard`,
      { headers: HT_HDR }
    );
    if (!htRes.ok) return new Response(JSON.stringify({ error: `HockeyTech ${htRes.status}` }), { status: 502, headers: corsHeaders() });

    let raw;
    try {
      const parsed = unwrapJsonp(await htRes.text());
      raw = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'player career parse failed', detail: e.message }), { status: 502, headers: corsHeaders() });
    }

    const sections = raw?.careerStats?.[0]?.sections || [];
    const data = {
      player_id:     parseInt(playerId, 10),
      regularSeason: extractCareerTotal(sections, 'Regular Season'),
      playoffs:      extractCareerTotal(sections, 'Playoffs'),
    };

    await kvPut(env, kvKey, data, 24 * 3600);
    return json(data);
  }

  // GET /pwhl/lastgame?teamId=1&season=8
  // Returns the most recent completed game with opponent abbr resolved.
  if (url.pathname === '/pwhl/lastgame') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:lastgame:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_id.desc&limit=1`,
      { headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    if (!rows.length) return json(null);
    const g = rows[0];
    const isHome    = g.home_team_id === teamId;
    const oppId     = isHome ? g.away_team_id : g.home_team_id;
    const teamScore = isHome ? g.home_score   : g.away_score;
    const oppScore  = isHome ? g.away_score   : g.home_score;
    const result = {
      gameId:    g.game_id,
      isHome,
      teamScore,
      oppScore,
      oppId,
      oppAbbr:   PWHL_TEAM_CODES[oppId] || String(oppId),
      ot:        g.ot,
      shootout:  g.shootout,
      gameState: g.game_state,
      won:       teamScore > oppScore,
    };
    await kvPut(env, kvKey, result, 1800);
    return json(result);
  }


  // GET /pwhl/pbp?gameId=213
  // Returns all PBP events (hits, penalties, faceoffs, goalie changes) for a
  // completed game with player names joined. Shot events are in /pwhl/shots.
  // TTL: 1 hour — game data is immutable once Final.
  if (url.pathname === '/pwhl/pbp') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:pbp:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    // Fetch PBP events + game log (for team IDs) in parallel
    const [pbpRes, gameRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/pwhl_pbp_events?game_id=eq.${gameId}&order=period_id.asc,time_seconds.asc&limit=500`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/pwhl_game_log?game_id=eq.${gameId}&select=home_team_id,away_team_id&limit=1`, { headers: sbH }),
    ]);
    if (!pbpRes.ok || !gameRes.ok) return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    const [rows, gameRows] = await Promise.all([pbpRes.json(), gameRes.json()]);
    // Join player names, fetch shots + gameSummary — all in one block
    const gameRow = gameRows[0];
    // Hoist playerMap so it's available to both the PBP annotation pass and the shots/summary pass
    const playerMap = {};
    if (gameRow) {
      const teamIds = [gameRow.home_team_id, gameRow.away_team_id].filter(Boolean);
      const rosterRes = await fetch(
        `${SB_URL}/rest/v1/pwhl_players?team_id=in.(${teamIds.join(',')})&select=player_id,first_name,last_name,team_id&limit=120`,
        { headers: sbH }
      );
      if (rosterRes.ok) {
        const roster = await rosterRes.json();
        for (const p of roster) {
          playerMap[p.player_id] = {
            name:    `${p.first_name || ''} ${p.last_name || ''}`.trim(),
            team_id: p.team_id,
          };
        }
        const homeTeamId = gameRow.home_team_id;
        const awayTeamId = gameRow.away_team_id;
        for (const row of rows) {
          const pm = row.player_id ? playerMap[row.player_id] : null;
          if (pm?.name) row.player_name = pm.name;
          const sm = row.secondary_player_id ? playerMap[row.secondary_player_id] : null;
          if (sm?.name) row.secondary_player_name = sm.name;
          if (row.team_id == null && pm?.team_id) row.team_id = pm.team_id;
          row._home_team_id = homeTeamId;
          row._away_team_id = awayTeamId;
        }
      }
    }
    if (gameRow) {

      // Fetch shot events + gameSummary in parallel
      const [allShotsRes, summaryRes] = await Promise.all([
        fetch(
          `${SB_URL}/rest/v1/pwhl_shot_events?game_id=eq.${gameId}&select=shooter_id,team_id,event_type,period_id,time_seconds,x_norm,y_norm,is_home&limit=400`,
          { headers: sbH }
        ),
        fetch(
          `${HT_BASE}?feed=statviewfeed&view=gameSummary&game_id=${gameId}&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=`,
          { headers: HT_HDR }
        ),
      ]);

      // All shots for both teams (for OPP rink + drill-downs)
      const allShots = allShotsRes.ok ? await allShotsRes.json() : [];
      const namedShots = allShots.map(s => ({
        ...s,
        shooter_name: s.shooter_id && playerMap[s.shooter_id]
          ? playerMap[s.shooter_id].name
          : null,
      }));

      // gameSummary: faceoff wins per skater + goalie stats
      const faceoffStats = {};   // { player_id: { name, wins, attempts } }
      const goalieStats  = [];   // [{ team_id, name, gp, saves, shots_against, toi }]

      if (summaryRes.ok) {
        try {
          let summaryText = await summaryRes.text();
          if (summaryText.includes('(')) summaryText = summaryText.slice(summaryText.indexOf('(')+1, summaryText.lastIndexOf(')'));
          const summary = JSON.parse(summaryText);

          // Faceoffs: summary.skaters (array), each has .id, .stats.faceoffWins, .stats.faceoffAttempts
          const skaters = summary.skaters || summary.homeTeam?.skaters?.concat(summary.visitingTeam?.skaters || []) || [];
          for (const sk of skaters) {
            const pid = sk.info?.id || sk.id;
            const wins = parseInt(sk.stats?.faceoffWins || 0);
            const att  = parseInt(sk.stats?.faceoffAttempts || sk.stats?.faceoffTaken || 0);
            if (att > 0 && pid) {
              faceoffStats[pid] = {
                name:     playerMap[pid]?.name || sk.info?.firstName + ' ' + sk.info?.lastName || `#${pid}`,
                wins,
                attempts: att,
                losses:   att - wins,
              };
            }
          }

          // Goalies: summary.homeTeam/visitingTeam → goalies array
          const processGoalies = (teamObj, team_id) => {
            const goalies = teamObj?.goalies || [];
            for (const g of goalies) {
              const pid = g.info?.id || g.id;
              goalieStats.push({
                team_id,
                player_id:    pid,
                name:         playerMap[pid]?.name || `${g.info?.firstName || ''} ${g.info?.lastName || ''}`.trim() || `#${pid}`,
                saves:        parseInt(g.stats?.saves || 0),
                shots_against: parseInt(g.stats?.shotsAgainst || g.stats?.shots || 0),
                goals_against: parseInt(g.stats?.goalsAgainst || 0),
                toi:          g.stats?.toi || g.stats?.timeOnIce || null,
              });
            }
          };
          processGoalies(summary.homeTeam    || summary.home,      gameRow.home_team_id);
          processGoalies(summary.visitingTeam || summary.visiting,  gameRow.away_team_id);
        } catch { /* gameSummary parse failure — carry on */ }
      }

      const payload = {
        events:         rows,
        opp_shots:      namedShots,
        home_team_id:   gameRow.home_team_id,
        away_team_id:   gameRow.away_team_id,
        faceoff_stats:  faceoffStats,
        goalie_stats:   goalieStats,
      };
      await kvPut(env, kvKey, payload, 3600);
      return json(payload);
    }
    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // POST /pwhl/news/bust — invalidate news cache so next GET triggers fresh fetch
  if (url.pathname === '/pwhl/news/bust' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    await env.CACHE.delete('pwhl:news');
    console.log('PWHL news cache busted');
    return json({ ok: true, busted: ['pwhl:news'] });
  }

  // POST /pwhl/cache/bust?secret=&teamId=&season=
  // Force-invalidates PWHL KV caches for a team so fresh data is served.
  // Call after pipeline ingestion or when data looks stale.
  if (url.pathname === '/pwhl/cache/bust' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    const season = await seasonParam(url, env);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId required' }), { status: 400, headers: corsHeaders() });
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    const keys = [
      `pwhl:shots:${teamId}:${season}`,
      `pwhl:players:${teamId}:${season}`,
      `pwhl:schedule:${teamId}:${season}`,
      `pwhl:lastgame:${teamId}:${season}`,
      `pwhl:roster:${teamId}`,
      `pwhl:standings:${season}`,
      `pwhl:leagueplayers:${season}`,
      `pwhl:today:${season}`,
      ...(gameId ? [`pwhl:live:${gameId}`] : []),
    ];
    await Promise.all(keys.map(k => env.CACHE.delete(k)));
    console.log(`PWHL cache busted: teamId=${teamId} season=${season} (${keys.length} keys)`);
    return json({ ok: true, busted: keys });
  }

  // POST /pwhl/news/ingest — accepts PWHL articles from GitHub Actions
  // (eyewall-pipeline's pwhl_news.py, run once nightly via pwhl-nightly.yml).
  // GH Actions runner IPs are not blocked by these RSS sources; Worker IPs are.
  if (url.pathname === '/pwhl/news/ingest' && request.method === 'POST') {
    const secret = url.searchParams.get('secret') || request.headers.get('x-ingest-secret');
    if (secret !== env.POLL_SECRET) return new Response('Unauthorized', { status: 401 });
    let articles;
    try {
      articles = await request.json();
      if (!Array.isArray(articles)) throw new Error('Expected array');
    } catch (e) {
      return new Response(`Bad request: ${e.message}`, { status: 400 });
    }
    // Merge with any existing articles, deduplicate, sort newest first
    const existing = (await kvGet(env, 'pwhl:news')) || [];
    const merged = [
      ...articles,
      ...existing.filter(a => !articles.find(n => n.id === a.id)),
    ].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
      .slice(0, 60);
    // 25hr, not 30min (Session: news ingestion investigation) -- this is
    // fed by a once-nightly cron job, not a per-request fetch. The old
    // 30min TTL meant these real articles were only ever visible for the
    // 30 minutes right after the nightly run, then vanished until either
    // the next night or fetchPWHLNews()'s own (separately fixed) merge
    // kept something alive -- in practice `pwhl:news` sat empty most of
    // each day even though this route was successfully finding real
    // PWHL articles every night.
    await kvPut(env, 'pwhl:news', merged, 25 * 3600);
    console.log(`PWHL news ingest: ${articles.length} new → ${merged.length} total`);
    return json({ ok: true, received: articles.length, total: merged.length });
  }

  // GET /pwhl/salaries?teamId=1&season=2025-26
  if (url.pathname === '/pwhl/salaries') {
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    const season = url.searchParams.get('season') || '2025-26';
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:salaries:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/pwhl_salaries?team_id=eq.${teamId}&season=eq.${encodeURIComponent(season)}&order=salary.desc&limit=60`,
      { headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 3600 * 24); // 24hr cache — salaries update annually
    return json(rows);
  }

  // GET /pwhl/league-players?season=8 — all teams' skaters + goalies for Leaders tab
  if (url.pathname === '/pwhl/league-players') {
    const season = await seasonParam(url, env);
    const kvKey  = `pwhl:leagueplayers:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const [skatersRes, goaliesRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/pwhl_player_seasons?season_id=eq.${season}&season_type=eq.regular&select=player_id,team_id,goals,assists,points,gp,shots,shot_pct,pp_goals,sh_goals,gw_goals,pim,plus_minus&order=points.desc&limit=300`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/pwhl_goalie_seasons?season_id=eq.${season}&season_type=eq.regular&select=player_id,team_id,gp,wins,losses,ot_losses,gaa,sv_pct,shutouts,saves,goals_against&order=sv_pct.desc&limit=50`, { headers: sbH }),
    ]);
    const [skaters, goalies] = await Promise.all([skatersRes.json(), goaliesRes.json()]);

    // Fetch all player names
    const nameRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_players?select=player_id,first_name,last_name,position,team_id&limit=500`,
      { headers: sbH }
    );
    const nameRows = nameRes.ok ? await nameRes.json() : [];
    const nameMap = {};
    for (const p of nameRows) {
      nameMap[p.player_id] = {
        player_name: `${p.first_name||''} ${p.last_name||''}`.trim(),
        first_name: p.first_name, last_name: p.last_name, position: p.position,
      };
    }
    const enrichSkaters = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
    const enrichGoalies = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));
    const result = { skaters: enrichSkaters, goalies: enrichGoalies };
    await kvPut(env, kvKey, result, 3600 * 2);
    return json(result);
  }

  // POST /pwhl/scout — generate AI scouting report for a PWHL player
  // Public, billed-AI route; rate-limited below (no secret check — called directly from the frontend)
  if (url.pathname === '/pwhl/scout' && request.method === 'POST') {
    const limited = await checkAiRateLimit(env, request, 'pwhl-scout');
    if (limited) return limited;
    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders() }); }
    const { name, position, stats, isGoalie, seasonLabel } = body;
    if (!name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: corsHeaders() });

    const statsLine = isGoalie
      ? `GP: ${stats.gp ?? '—'}, W: ${stats.wins ?? '—'}, L: ${stats.losses ?? '—'}, OTL: ${stats.ot_losses ?? '—'}, SV%: ${stats.sv_pct != null ? Number(stats.sv_pct).toFixed(3) : '—'}, GAA: ${stats.gaa != null ? Number(stats.gaa).toFixed(2) : '—'}, SO: ${stats.shutouts ?? '—'}`
      : `GP: ${stats.gp ?? '—'}, G: ${stats.goals ?? '—'}, A: ${stats.assists ?? '—'}, PTS: ${stats.points ?? '—'}, +/-: ${stats.plus_minus ?? '—'}, PPG: ${stats.pp_goals ?? '—'}, SHG: ${stats.sh_goals ?? '—'}, SOG: ${stats.shots ?? '—'}, S%: ${stats.shot_pct != null ? Number(stats.shot_pct).toFixed(1) + '%' : '—'}, PIM: ${stats.pim ?? '—'}`;

    const prompt = `You are a hockey analyst writing a concise scouting report for a PWHL player.
Player: ${name} (${position})
Season: ${seasonLabel} PWHL Regular Season
Stats: ${statsLine}

Write a 2-3 sentence scouting report highlighting their strengths, style of play, and impact this season. Be specific and use the stats. Do not use generic filler phrases. Write in plain text, no markdown.`;

    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages: [{ role: 'user', content: prompt }],
      });
      const blurb = aiResponse.response?.trim() || '';
      if (!blurb) return json({ error: 'Empty AI response' });
      return json({ blurb });
    } catch (e) {
      console.error('PWHL scout AI error:', e);
      return new Response(JSON.stringify({ error: 'AI generation failed' }), { status: 502, headers: corsHeaders() });
    }
  }

  // GET /pwhl/player-shots?playerId=36&season=8
  if (url.pathname === '/pwhl/player-shots') {
    const playerId = parseInt(url.searchParams.get('playerId') || '0', 10);
    const season   = await seasonParam(url, env);
    if (!playerId) return new Response(JSON.stringify({ error: 'playerId required' }), { status: 400, headers: corsHeaders() });
    const kvKey  = `pwhl:pshots:${playerId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/pwhl_shot_events?shooter_id=eq.${playerId}&season_id=eq.${season}&select=event_type,period_id,time_seconds,x_norm,y_norm&limit=500`,
      { headers: { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    // Normalise coordinates: fold to positive x (attacking direction)
    const shots = rows.map(r => {
      let x = parseFloat(r.x_norm), y = parseFloat(r.y_norm);
      if (x < 0) { x = -x; y = -y; }
      return {
        x: Math.min(Math.abs(x), 99),
        y: Math.max(-42, Math.min(42, y)),
        t: r.event_type === 'goal' ? 'g' : r.event_type === 'blocked_shot' ? 'b' : r.event_type === 'missed_shot' ? 'm' : 's',
        p: r.period_id,
      };
    }).filter(s => !isNaN(s.x) && !isNaN(s.y));
    const result = { shots, total: shots.length };
    await kvPut(env, kvKey, result, 3600 * 6); // 6hr cache
    return json(result);
  }

  // GET /pwhl/news
  if (url.pathname === '/pwhl/news' && request.method === 'GET') {
    const cached = await kvGet(env, 'pwhl:news');
    if (cached) return json(cached);
    ctx.waitUntil(fetchPWHLNews(env).catch(e => console.warn('PWHL news bg fetch:', e.message)));
    return json([]);
  }

  // ── PWHL Live endpoints ───────────────────────────────────────────────────

  // GET /pwhl/today?season=8
  // Returns all games scheduled for today (Eastern time) with status pre/live/final.
  if (url.pathname === '/pwhl/today') {
    const season = await seasonParam(url, env);
    const kvKey  = `pwhl:today:${season}`;

    // 60s TTL — status needs to flip quickly when a game goes live
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };

    // Get today's date in Eastern time (games stored as Eastern dates in pwhl_game_log)
    const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = nowET.toISOString().slice(0, 10); // YYYY-MM-DD

    const r = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?game_date=eq.${todayStr}&season_id=eq.${season}` +
      `&select=game_id,home_team_id,away_team_id,home_score,away_score,game_state,game_date&limit=10`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });


    const rows  = await r.json();
    const games = rows.map(g => {
      // Derive status from game_state string HockeyTech uses.
      // Known values from pwhl_game_log: "Final", "Pre-Game".
      // "InProgress" / "Intermission" assumed for live — verify against a live game.
      const gs = (g.game_state || '').toLowerCase();
      let status = 'pre';
      if (gs === 'final' || gs === 'official')                                   status = 'final';
      else if (gs.includes('progress') || gs.includes('live') || gs.includes('intermission')) status = 'live';

      return {
        gameId:       g.game_id,
        homeTeamId:   g.home_team_id,
        awayTeamId:   g.away_team_id,
        homeTeamCode: PWHL_TEAM_CODES[g.home_team_id] || String(g.home_team_id),
        awayTeamCode: PWHL_TEAM_CODES[g.away_team_id] || String(g.away_team_id),
        homeScore:    g.home_score,
        awayScore:    g.away_score,
        status,
      };
    });

    await kvPut(env, kvKey, games, 60);
    return json(games);
  }

  // GET /pwhl/live/:gameId
  // Fetches + normalises live PBP from HockeyTech. KV TTL: 30s live, 1hr final.
  if (url.pathname.startsWith('/pwhl/live/')) {
    const gameId = parseInt(url.pathname.split('/pwhl/live/')[1], 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:live:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);


    // Fetch PBP + gameSummary in parallel (summary gives goalie stats + faceoff pcts)
    const [pbpRes, summaryRes] = await Promise.all([
      fetch(
        `${HT_BASE}?feed=statviewfeed&view=gameCenterPlayByPlay&game_id=${gameId}&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=`,
        { headers: HT_HDR }
      ),
      fetch(
        `${HT_BASE}?feed=statviewfeed&view=gameSummary&game_id=${gameId}&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=`,
        { headers: HT_HDR }
      ),
    ]);

    if (!pbpRes.ok) return new Response(JSON.stringify({ error: `HockeyTech PBP ${pbpRes.status}` }), { status: 502, headers: corsHeaders() });

    let rawEvents;
    try {
      rawEvents = unwrapJsonp(await pbpRes.text());
    } catch (e) {
      return new Response(JSON.stringify({ error: 'PBP parse failed', detail: e.message }), { status: 502, headers: corsHeaders() });
    }

    // Period normaliser: "OT1"→4, "OT2"→5, "OT3"→6, "SO"→7, numeric string→int
    const normPeriod = (raw) => {
      const periodMap = { 'OT1': 4, 'OT2': 5, 'OT3': 6, 'SO': 7 };
      const s = String(raw ?? '1');
      return periodMap[s] ?? (parseInt(s, 10) || 1);
    };

    // Strip clinch prefixes from team abbrevs: "x - MTL" → "MTL"
    const normAbbr = (abbr) => (abbr || '').replace(/^[a-z]+ - /i, '').trim();

    // Time string "MM:SS" → elapsed seconds
    const timeToSeconds = (t) => {
      const parts = (t || '0:00').split(':');
      return parseInt(parts[0], 10) * 60 + parseInt(parts[parts.length - 1], 10);
    };

    // Normalise a player stub to { id, firstName, lastName, jerseyNumber }
    const normPlayer = (p) => p ? {
      id:           parseInt(p.id, 10) || null,
      firstName:    p.firstName || '',
      lastName:     p.lastName  || '',
      jerseyNumber: p.jerseyNumber || null,
    } : null;

    // Build normalised event list
    const events = rawEvents.map(ev => {
      if (!ev || typeof ev !== 'object') return null;
      const type = ev.event;
      const d    = ev.details || {};
      const period      = normPeriod(d.period?.id);
      const time        = d.time || '0:00';
      const timeSeconds = timeToSeconds(time);

      const base = { eventType: type, period, time, timeSeconds };

      if (type === 'goal') {
        return {
          ...base,
          teamId:        parseInt(d.team?.id, 10) || null,
          teamAbbrev:    normAbbr(d.team?.abbreviation),
          scoredBy:      normPlayer(d.scoredBy),
          assists:       (d.assists || []).map(normPlayer),
          isPowerPlay:   d.properties?.isPowerPlay    === '1',
          isShortHanded: d.properties?.isShortHanded  === '1',
          isEmptyNet:    d.properties?.isEmptyNet      === '1',
          isPenaltyShot: d.properties?.isPenaltyShot  === '1',
          isGameWinner:  d.properties?.isGameWinningGoal === '1',
          plusPlayers:   (d.plus_players  || []).map(normPlayer),
          minusPlayers:  (d.minus_players || []).map(normPlayer),
          x: d.xLocation ?? null,
          y: d.yLocation ?? null,
        };
      }

      if (type === 'shot' || type === 'blocked_shot') {
        return {
          ...base,
          teamId:      parseInt(d.shooterTeamId, 10) || null,
          shooter:     normPlayer(d.shooter),
          goalie:      normPlayer(d.goalie),
          blocker:     normPlayer(d.blocker) || null,
          shotType:    d.shotType    || null,
          shotQuality: d.shotQuality || null,
          isGoal:      !!d.isGoal,
          x: d.xLocation ?? null,
          y: d.yLocation ?? null,
        };
      }

      if (type === 'penalty') {
        return {
          ...base,
          teamId:      parseInt(d.againstTeam?.id, 10) || null,
          teamAbbrev:  normAbbr(d.againstTeam?.abbreviation),
          takenBy:     normPlayer(d.takenBy),
          servedBy:    normPlayer(d.servedBy),
          minutes:     parseFloat(d.minutes || '2') || 2,
          description: d.description || '',
          isPowerPlay: !!d.isPowerPlay,
          isBench:     !!d.isBench,
        };
      }

      if (type === 'goalie_change') {
        return {
          ...base,
          teamId:    parseInt(d.team_id, 10) || null,
          goalieIn:  normPlayer(d.goalieComingIn),   // null = goalie pulled for extra attacker
          goalieOut: normPlayer(d.goalieGoingOut),   // null = goalie returning to net
        };
      }

      if (type === 'faceoff') {
        return {
          ...base,
          homePlayer:     normPlayer(d.homePlayer),
          visitingPlayer: normPlayer(d.visitingPlayer),
          homeWin:        String(d.homeWin) === '1',
          x: d.xLocation ?? null,
          y: d.yLocation ?? null,
        };
      }

      if (type === 'hit') {
        return {
          ...base,
          teamId:   parseInt(d.teamId, 10) || null,
          player:   normPlayer(d.player),
          onPlayer: normPlayer(d.onPlayer),
          x: d.xLocation ?? null,
          y: d.yLocation ?? null,
        };
      }

      return null; // unknown event type — skip
    }).filter(Boolean);

    // Derive live score + game status from Supabase (home/away team IDs needed to split goals)
    const sbH     = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const gameRows = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?game_id=eq.${gameId}&select=home_team_id,away_team_id,game_state&limit=1`,
      { headers: sbH }
    ).then(r => r.ok ? r.json() : []).catch(() => []);
    const gameRow = gameRows[0] || null;

    let homeScore = 0, awayScore = 0, gameStatus = 'pre';
    if (gameRow) {
      for (const g of events.filter(e => e.eventType === 'goal')) {
        if (g.teamId === gameRow.home_team_id) homeScore++;
        else awayScore++;
      }
      const gs = (gameRow.game_state || '').toLowerCase();
      if (gs === 'final' || gs === 'official')                                          gameStatus = 'final';
      else if (gs.includes('progress') || gs.includes('live') || gs.includes('intermission')) gameStatus = 'live';
    }

    // Parse gameSummary for goalie stats + faceoff pcts (best-effort, non-fatal)
    const goalieStats = [], faceoffStats = {};
    if (summaryRes.ok) {
      try {
        const summaryData = unwrapJsonp(await summaryRes.text());
        const processGoalies = (teamObj, teamId) => {
          for (const g of (teamObj?.goalies || [])) {
            goalieStats.push({
              teamId,
              playerId:     parseInt(g.info?.id || g.id, 10) || null,
              name:         `${g.info?.firstName || ''} ${g.info?.lastName || ''}`.trim(),
              saves:        parseInt(g.stats?.saves        || 0),
              shotsAgainst: parseInt(g.stats?.shotsAgainst || g.stats?.shots || 0),
              goalsAgainst: parseInt(g.stats?.goalsAgainst || 0),
              toi:          g.stats?.toi || g.stats?.timeOnIce || null,
            });
          }
        };
        processGoalies(summaryData.homeTeam     || summaryData.home,      gameRow?.home_team_id);
        processGoalies(summaryData.visitingTeam || summaryData.visiting,   gameRow?.away_team_id);

        const skaters = summaryData.skaters ||
          (summaryData.homeTeam?.skaters || []).concat(summaryData.visitingTeam?.skaters || []);
        for (const sk of skaters) {
          const pid  = sk.info?.id || sk.id;
          const wins = parseInt(sk.stats?.faceoffWins     || 0);
          const att  = parseInt(sk.stats?.faceoffAttempts || sk.stats?.faceoffTaken || 0);
          if (att > 0 && pid) {
            faceoffStats[pid] = { wins, attempts: att, losses: att - wins };
          }
        }
      } catch { /* gameSummary parse failure — non-fatal */ }
    }

    const ttl     = gameStatus === 'final' ? 3600 : 30;
    const payload = {
      gameId,
      homeTeamId: gameRow?.home_team_id ?? null,
      awayTeamId: gameRow?.away_team_id ?? null,
      homeScore,
      awayScore,
      gameStatus,
      events,
      goalieStats,
      faceoffStats,
    };

    await kvPut(env, kvKey, payload, ttl);
    return json(payload);
  }

  // GET /pwhl/summary?gameId=210
  // Returns normalized HockeyTech gameSummary: periods with goal details,
  // MVPs (three stars), and team stats. Used by usePWHLPeriodSummary hook.
  // TTL: 1hr (immutable once game is final).
  if (url.pathname === '/pwhl/summary') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:gamesummary:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const htRes = await fetch(
      `${HT_BASE}?feed=statviewfeed&view=gameSummary&game_id=${gameId}&key=${HT_KEY}&client_code=pwhl&lang=en&league_id=`,
      { headers: HT_HDR }
    );
    if (!htRes.ok) return new Response(JSON.stringify({ error: `HockeyTech ${htRes.status}` }), { status: 502, headers: corsHeaders() });

    let raw;
    try {
      raw = unwrapJsonp(await htRes.text());
    } catch (e) {
      return new Response(JSON.stringify({ error: 'gameSummary parse failed', detail: e.message }), { status: 502, headers: corsHeaders() });
    }

    const normAbbr = (abbr) => (abbr || '').replace(/^[a-z]+ - /i, '').trim();

    const periods = (raw.periods || []).map(p => ({
      info: {
        id:        parseInt(p.info?.id, 10) || 1,
        shortName: p.info?.shortName || '',
        longName:  p.info?.longName  || '',
      },
      stats: {
        homeGoals:     parseInt(p.stats?.homeGoals     || 0),
        homeShots:     parseInt(p.stats?.homeShots     || 0),
        visitingGoals: parseInt(p.stats?.visitingGoals || 0),
        visitingShots: parseInt(p.stats?.visitingShots || 0),
      },
      goals: (p.goals || []).map(g => ({
        game_goal_id: g.game_goal_id || null,
        time:         g.time || '0:00',
        team: {
          id:           parseInt(g.team?.id, 10) || null,
          abbreviation: normAbbr(g.team?.abbreviation),
        },
        scoredBy: g.scoredBy ? {
          id:             parseInt(g.scoredBy.id, 10) || null,
          firstName:      g.scoredBy.firstName || '',
          lastName:       g.scoredBy.lastName  || '',
          playerImageURL: g.scoredBy.playerImageURL || null,
        } : null,
        assists: (g.assists || []).map(a => ({
          id:        parseInt(a.id, 10) || null,
          firstName: a.firstName || '',
          lastName:  a.lastName  || '',
        })),
        properties: {
          isPowerPlay:       g.properties?.isPowerPlay       || '0',
          isShortHanded:     g.properties?.isShortHanded     || '0',
          isEmptyNet:        g.properties?.isEmptyNet        || '0',
          isPenaltyShot:     g.properties?.isPenaltyShot     || '0',
          isGameWinningGoal: g.properties?.isGameWinningGoal || '0',
        },
      })),
    }));

    // MVPs (three stars)
    const mvps = (raw.mostValuablePlayers || []).map(mvp => ({
      team: {
        id:           parseInt(mvp.team?.id, 10) || null,
        abbreviation: normAbbr(mvp.team?.abbreviation),
        name:         mvp.team?.name || '',
      },
      player: {
        info: {
          id:             parseInt(mvp.player?.info?.id, 10) || null,
          firstName:      mvp.player?.info?.firstName  || '',
          lastName:       mvp.player?.info?.lastName   || '',
          jerseyNumber:   mvp.player?.info?.jerseyNumber || null,
          position:       mvp.player?.info?.position   || '',
          playerImageURL: mvp.player?.info?.playerImageURL || null,
        },
        stats: mvp.player?.stats || {},
      },
      isGoalie:    !!mvp.isGoalie,
      playerImage: mvp.playerImage || mvp.player?.info?.playerImageURL?.replace('/120x160/', '/240x240/') || null,
      homeTeam:    mvp.homeTeam === 1 || mvp.homeTeam === true,
    }));

    const payload = {
      periods,
      mvps,
      homeTeamStats:     raw.homeTeam?.stats     || {},
      visitingTeamStats: raw.visitingTeam?.stats || {},
    };
    await kvPut(env, kvKey, payload, 3600);
    return json(payload);
  }

  // POST /pwhl/summary/narrative?gameId=210&period=1
  // Generates AI period/game narrative for PWHL summaries.
  // Caches in KV so subsequent users get the pre-generated text.
  // Public, billed-AI route; rate-limited below (no secret check — called directly from the frontend)
  if (url.pathname === '/pwhl/summary/narrative' && request.method === 'POST') {
    const limited = await checkAiRateLimit(env, request, 'pwhl-summary-narrative');
    if (limited) return limited;
    const gameId    = url.searchParams.get('gameId') || '';
    const periodKey = url.searchParams.get('period') || '1';
    // Include carAbbr in cache key so each team gets its own perspective
    const carAbbrKey = (url.searchParams.get('carAbbr') || 'UNK').toUpperCase();

    const cacheKey = `pwhl:narrative:${periodKey}:${gameId}:${carAbbrKey}`;
    const cached   = await kvGet(env, cacheKey);
    if (cached) return json(cached);

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders() });
    }

    const {
      carAbbr, oppAbbr, carName, oppName, periodLabel,
      corsiForPct, carSOG, oppSOG, carGoals, oppGoals,
      carHits, carFOPct, carHDCF, oppHDCF,
      penaltyCount, carPenaltyCount,
      bestPeriod, worstPeriod,
      primaryGoalieName,
      goals = [],
    } = body;

    // Use full team names in prose so the model writes "the Fleet" not "BOS"
    const carDisplay = carName || carAbbr;
    const oppDisplay = oppName || oppAbbr;

    const isGame = periodKey === 'game';

    const goalLines = goals.map(g => {
      const who = g.scorerName || (g.isCar ? carDisplay : oppDisplay);
      const str = g.strength && g.strength !== 'ev' ? ` (${g.strength.toUpperCase()})` : '';
      const per = isGame && g.period ? ` P${g.period}` : '';
      return `${g.isCar ? carDisplay : oppDisplay}: ${who} at ${g.time}${per}${str}`;
    }).join('\n');

    const prompt = isGame
      ? `You are Sticks, EyeWall Analytics' PWHL game analyst. Write a punchy 2-3 sentence final game summary. Use the full team names (e.g. "${carDisplay}", "${oppDisplay}") when referring to teams — never use abbreviations in the narrative.
Game: ${carDisplay} (${carAbbr}) vs ${oppDisplay} (${oppAbbr})
Score: ${carDisplay} ${carGoals}–${oppGoals} ${oppDisplay}
Corsi For%: ${corsiForPct}% · SOG: ${carSOG}–${oppSOG} · HD Chances: ${carHDCF}–${oppHDCF}
Faceoff Win%: ${carFOPct != null ? carFOPct + '%' : '—'} · Hits: ${carHits} · Penalties: ${carDisplay} ${carPenaltyCount}–${penaltyCount - carPenaltyCount} ${oppDisplay}
Goals:\n${goalLines || 'None'}
${primaryGoalieName ? `Goalie: ${primaryGoalieName}` : ''}
Best period: ${bestPeriod?.period ? 'P' + bestPeriod.period + ' (' + bestPeriod.corsiForPct + '% CF)' : '—'}
Worst period: ${worstPeriod?.period ? 'P' + worstPeriod.period + ' (' + worstPeriod.corsiForPct + '% CF)' : '—'}

Write in plain text, no markdown, no bullet points. Be specific about what happened.`
      : `You are Sticks, EyeWall Analytics' PWHL analyst. Write a punchy 1-2 sentence period summary. Use the full team names (e.g. "${carDisplay}", "${oppDisplay}") — never abbreviations in the narrative.
Period: ${periodLabel} — ${carDisplay} (${carAbbr}) vs ${oppDisplay} (${oppAbbr})
Corsi For%: ${corsiForPct}% · SOG: ${carSOG}–${oppSOG} · HD Chances: ${carHDCF}–${oppHDCF}
Goals: ${carGoals}–${oppGoals} · Hits: ${carHits} · Faceoffs: ${carFOPct != null ? carFOPct + '%' : '—'}
Penalties this period: ${penaltyCount} (${carDisplay} took ${carPenaltyCount})
${goalLines ? 'Goals:\n' + goalLines : 'No goals this period.'}

Write in plain text, no markdown. 1-2 sentences max.`;

    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages:   [{ role: 'user', content: prompt }],
        max_tokens: isGame ? 120 : 80,
      });
      const narrative = (aiResponse.response || '').trim();
      if (!narrative) return json({ error: 'Empty AI response' });

      let cardNarrative = null;
      if (isGame && narrative.length > 120) {
        const firstSentence = narrative.match(/^[^.!?]+[.!?]/);
        cardNarrative = firstSentence ? firstSentence[0].trim() : narrative.slice(0, 120) + '…';
      }

      const result = { narrative, cardNarrative };
      await kvPut(env, cacheKey, result, 24 * 3600);
      return json(result);
    } catch (e) {
      console.error('[PWHL] narrative AI error:', e);
      return new Response(JSON.stringify({ error: 'AI generation failed' }), { status: 502, headers: corsHeaders() });
    }
  }

  // ── Pre-game preview (Session 51) ────────────────────────────
  // GET /pwhl/preview?gameId=210
  // Live-fetched from HockeyTech's gameCenterPreview view — season series,
  // head-to-head, streaks, team-scoped leading scorers, special teams, for
  // an upcoming (not-yet-played) PWHL game. Deliberately excludes
  // miscellaneousRecords (confirmed all-zero in every game checked) and
  // lineup (confirmed always null pre-2026-27-preseason; revisit once a
  // genuinely scheduled game with real lineup data exists).
  if (url.pathname === '/pwhl/preview') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });

    const kvKey  = `pwhl:preview:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    let raw;
    try {
      raw = await fetchGameCenterPreview(env, gameId);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'gameCenterPreview fetch failed', detail: e.message }), { status: 502, headers: corsHeaders() });
    }

    const team = (t) => t ? {
      id:            parseInt(t.teamInfo?.id, 10) || null,
      abbreviation:  t.teamInfo?.abbreviation || '',
      name:          t.teamInfo?.name || '',
      goalsFor:      t.goalsFor ?? null,
      goalsAgainst:  t.goalsAgainst ?? null,
      // teamRecord.streak is a plain string ("1-0-0-0"), NOT the same
      // {wins,losses,...,formattedRecord} object shape as the other
      // teamRecord splits (overall/home/visiting/past_10_games) -- confirmed
      // live against game 326's real payload (Session 51).
      streak:        t.teamRecord?.streak || null,
      overallRecord: t.teamRecord?.overall?.formattedRecord || null,
      last10Record:  t.teamRecord?.past_10_games?.formattedRecord || null,
      leadingScorers: (t.leadingScorers || []).slice(0, 5).map(s => ({
        name:   `${s.info?.firstName || ''} ${s.info?.lastName || ''}`.trim(),
        stats:  s.stats || null,
      })),
      leadingRookie: t.leadingRookie ? {
        name:  `${t.leadingRookie.info?.firstName || ''} ${t.leadingRookie.info?.lastName || ''}`.trim(),
        stats: t.leadingRookie.stats || null,
      } : null,
      leadingPIM: t.leadingPIM ? {
        name:  `${t.leadingPIM.info?.firstName || ''} ${t.leadingPIM.info?.lastName || ''}`.trim(),
        stats: t.leadingPIM.stats || null,
      } : null,
      powerPlay:    t.powerPlayStats?.overall   || null,
      penaltyKill:  t.penaltyKillStats?.overall || null,
    } : null;

    const payload = {
      gameId,
      homeTeam:     team(raw.homeTeam),
      visitingTeam: team(raw.visitingTeam),
      // In-season game-by-game log between these two teams — count varies
      // (0 for a series/season opener, several for teams that meet often).
      seasonSeries: (raw.previousMeetings || []).map(m => ({
        gameId:     parseInt(m.gameId, 10) || null,
        datePlayed: m.datePlayed || m.game_date_iso_8601 || null,
        homeTeamId: parseInt(m.homeTeamId, 10) || null,
        homeCity:   m.homeCity || '',
        homeScore:  parseInt(m.homeScore, 10) || 0,
        visitingTeamId: parseInt(m.visitingTeamId, 10) || null,
        visitingCity:   m.visitingCity || '',
        visitingScore:  parseInt(m.visitingScore, 10) || 0,
      })),
      // Multi-season aggregate (previousYear/currentYear/previousFiveYears),
      // NOT a game log — that's seasonSeries above.
      headToHeadRecords: raw.headToHeadRecords || null,
      longestStreaks: {
        home:      raw.homeTeam?.longestStreaks     || null,
        visiting:  raw.visitingTeam?.longestStreaks || null,
      },
      generatedAt: new Date().toISOString(),
    };

    await kvPut(env, kvKey, payload, 1800);
    return json(payload);
  }

  // GET /pwhl/prediction?gameId=210
  // Team-level win prediction (heuristic + AI narrative) — PWHL analog of
  // NHL's /prediction/analyze FALLBACK tier (nhl.js:2228-2382), not NHL's
  // preferred DB-first Tier-1 system (ai_predictions.py, RAPM/WAR/zone-start
  // driven) — that one needs shift-level data PWHL doesn't have until the
  // WAR/RAPM October blocker clears (see eyewall-pipeline CLAUDE.md). Don't
  // present this as full parity with NHL's "real" prediction system.
  //
  // "Corsi" here (corsiForPct) is shot-attempt share — goals + shots +
  // blocked shots — at ALL STRENGTHS, not 5-on-5 filtered (PWHL's PBP data
  // has no strength-state reconstruction yet). It's still more complete
  // than NHL's own possession proxy in /prediction/analyze, which is only
  // shots-on-goal share and doesn't count blocked shots at all — but it's
  // not a true 5v5 possession stat either. Labeled explicitly in the AI
  // prompt and in corsiCaveat below so nothing overclaims precision.
  //
  // Public, billed-AI route; rate-limited below (no secret check — called
  // directly from the frontend, same pattern as /pwhl/scout).
  if (url.pathname === '/pwhl/prediction') {
    const limited = await checkAiRateLimit(env, request, 'pwhl-prediction');
    if (limited) return limited;

    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });
    const forceRegen = url.searchParams.get('force') === '1';

    const kvKey = `pwhl:prediction:${gameId}`;
    if (!forceRegen) {
      const cached = await kvGet(env, kvKey);
      if (cached) return json(cached);
    }

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };

    const gameRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?game_id=eq.${gameId}&select=game_id,season_id,home_team_id,away_team_id`,
      { headers: sbH }
    );
    if (!gameRes.ok) return new Response(JSON.stringify({ error: `Supabase ${gameRes.status}` }), { status: 502, headers: corsHeaders() });
    const [game] = await gameRes.json();
    if (!game || !game.home_team_id || !game.away_team_id) {
      return new Response(JSON.stringify({ error: 'Game not found in pwhl_game_log' }), { status: 404, headers: corsHeaders() });
    }

    const seasonId  = game.season_id;
    const homeId    = game.home_team_id;
    const awayId    = game.away_team_id;

    const seasonTypeMap = await getAllPWHLSeasonTypes(env);
    const seasonType    = seasonTypeMap?.[seasonId] || 'regular';
    const isPlayoff      = seasonType === 'playoffs';

    const [teamsRes, logRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/pwhl_team_seasons?team_id=in.(${homeId},${awayId})&season_id=eq.${seasonId}&season_type=eq.${seasonType}`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/pwhl_game_log?season_id=eq.${seasonId}&game_state=eq.Final&order=game_id.desc&limit=500&select=game_id,home_team_id,away_team_id,home_score,away_score,ot,shootout`, { headers: sbH }),
    ]);
    if (!teamsRes.ok) return new Response(JSON.stringify({ error: `Supabase ${teamsRes.status}` }), { status: 502, headers: corsHeaders() });
    const teamRows = await teamsRes.json();
    const games    = logRes.ok ? await logRes.json() : [];

    const home = teamRows.find(t => t.team_id === homeId);
    const away = teamRows.find(t => t.team_id === awayId);
    if (!home || !away) {
      return new Response(JSON.stringify({ error: 'pwhl_team_seasons rows not found for both teams' }), { status: 404, headers: corsHeaders() });
    }

    // Streak, computed live from the game log — same result-string logic as
    // /pwhl/standings' streak calc above, scoped to just these 2 teams.
    const streakFor = (teamId) => {
      const results = games
        .filter(g => g.home_team_id === teamId || g.away_team_id === teamId)
        .map(g => {
          const isHomeG = g.home_team_id === teamId;
          const my  = isHomeG ? g.home_score : g.away_score;
          const opp = isHomeG ? g.away_score : g.home_score;
          const extra = g.ot || g.shootout;
          return my > opp ? 'W' : extra ? 'O' : 'L';
        });
      let streak = 0, streakType = '';
      for (const res of results) {
        if (!streakType) { streakType = res === 'W' ? 'W' : 'L'; streak = 1; }
        else if ((res === 'W' && streakType === 'W') || (res !== 'W' && streakType === 'L')) streak++;
        else break;
      }
      return streak ? `${streakType}${streak}` : 'unknown';
    };
    const homeStreak = streakFor(homeId);
    const awayStreak = streakFor(awayId);

    // This-season head-to-head between these 2 teams (long-run multi-season
    // H2H lives in /pwhl/preview's headToHeadRecords instead).
    const h2hGames = games.filter(g =>
      (g.home_team_id === homeId && g.away_team_id === awayId) ||
      (g.home_team_id === awayId && g.away_team_id === homeId)
    );
    const h2hHomeWins = h2hGames.filter(g => {
      const homeWasHome = g.home_team_id === homeId;
      const myScore  = homeWasHome ? g.home_score : g.away_score;
      const oppScore = homeWasHome ? g.away_score : g.home_score;
      return myScore > oppScore;
    }).length;
    const h2hRecord = h2hGames.length > 0
      ? `${h2hHomeWins}-${h2hGames.length - h2hHomeWins}`
      : 'no prior meetings';

    const homeAbbr = PWHL_TEAM_CODES[homeId] || `T${homeId}`;
    const awayAbbr = PWHL_TEAM_CODES[awayId] || `T${awayId}`;

    const hGp = home.gp || 1, aGp = away.gp || 1;
    const hGpg = (home.goals_for ?? 0) / hGp,     aGpg = (away.goals_for ?? 0) / aGp;
    const hGag = (home.goals_against ?? 0) / hGp, aGag = (away.goals_against ?? 0) / aGp;
    const hPP  = (home.pp_pct ?? 0) * 100,        aPP  = (away.pp_pct ?? 0) * 100;
    const hPK  = (home.pk_pct ?? 0) * 100,        aPK  = (away.pk_pct ?? 0) * 100;

    // Real Corsi, preferring the 5v5-filtered column over all-situations —
    // same preference-order pattern as NHL's /prediction/analyze
    // (nhl.js:2299-2307). Unlike NHL's team_seasons, pwhl_team_seasons
    // stores corsi_for_pct[_5v5] already scaled to a percentage (see
    // pwhl_stats.py::run_team_shot_totals[_5v5]), not a 0-1 fraction — no
    // *100 here, that would double-scale.
    let hCF, aCF, corsiSource;
    if (home.corsi_for_pct_5v5 != null && away.corsi_for_pct_5v5 != null) {
      hCF = home.corsi_for_pct_5v5; aCF = away.corsi_for_pct_5v5; corsiSource = '5v5';
    } else if (home.corsi_for_pct != null && away.corsi_for_pct != null) {
      hCF = home.corsi_for_pct; aCF = away.corsi_for_pct; corsiSource = 'all_situations';
    } else {
      hCF = null; aCF = null; corsiSource = 'unavailable';
    }
    const corsiCaveat = corsiSource === '5v5'
      ? '5-on-5 shot-attempt share (goals+shots+blocked), not all-situations.'
      : corsiSource === 'all_situations'
        ? 'All-situations shot-attempt share (goals+shots+blocked), not 5-on-5 filtered.'
        : 'Shot-attempt share unavailable for this team/season yet.';
    const corsiLabel = corsiSource === '5v5' ? 'Shot-attempt share (Corsi For%, 5-on-5)' : 'Shot-attempt share (Corsi For%, all situations)';

    // Pythagorean expected score — same geometric-mean-of-rates shape as
    // NHL's /prediction/analyze (nhl.js:2306-2310), home-ice adjustment
    // ported unchanged.
    const clamp    = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const expHome  = clamp(Math.sqrt(Math.max(hGpg, 0.5) * Math.max(aGag, 0.5)) + 0.12, 1.5, 5.0).toFixed(1);
    const expAway  = clamp(Math.sqrt(Math.max(aGpg, 0.5) * Math.max(hGag, 0.5)) - 0.12, 1.5, 5.0).toFixed(1);

    // Win probability — additive heuristic ported from NHL's
    // /prediction/analyze (nhl.js:2312-2327), with real Corsi-for% swapped
    // in for NHL's SOG-for-only "possession" term.
    let homeScore = 0, awayScore = 0;
    if (!isPlayoff) {
      const ptsDiff = (home.points ?? 0) - (away.points ?? 0);
      homeScore += ptsDiff > 0 ? Math.min(ptsDiff / 20, 1) : 0;
      awayScore += ptsDiff < 0 ? Math.min(-ptsDiff / 20, 1) : 0;
    }
    if (hGpg > aGpg) homeScore += 0.6; else awayScore += 0.6;
    if (hGag < aGag) homeScore += 0.6; else awayScore += 0.6;
    if (hPP  > aPP)  homeScore += 0.4; else awayScore += 0.4;
    if (hCF != null && aCF != null) {
      if (hCF > aCF) homeScore += 0.5; else awayScore += 0.5;
    }
    if (homeStreak.startsWith('W')) homeScore += 0.3;
    if (awayStreak.startsWith('W')) awayScore += 0.3;
    const totalScore = homeScore + awayScore || 1;
    const homeWinPct = Math.round((homeScore / totalScore) * 100);

    const prompt = `You are EyeWall Analytics, a PWHL hockey analytics assistant. Write a sharp, data-driven pre-game analysis. 2-3 sentences only. Be specific about the numbers. No filler. No "In this matchup" opener. ${corsiSource === '5v5' ? 'The shot-attempt numbers below are 5-ON-5 filtered — describe it as "5v5 shot-attempt share" or "possession," accurately reflecting that scope.' : corsiSource === 'all_situations' ? 'The shot-attempt numbers below are ALL-SITUATIONS (not 5-on-5 only) — describe it as "shot-attempt share," not as a 5v5/possession-only stat.' : 'Shot-attempt data is unavailable for one or both teams — do not reference Corsi or possession.'}

Game: ${homeAbbr} (HOME) vs ${awayAbbr} (AWAY)
Context: ${isPlayoff ? 'PLAYOFFS' : 'Regular Season'}

${homeAbbr} stats:
- Record: ${home.wins}-${home.losses}-${home.ot_losses} (${home.points} pts)
- GF/GA per game: ${hGpg.toFixed(2)} / ${hGag.toFixed(2)}
- PP%: ${hPP.toFixed(1)}% · PK%: ${hPK.toFixed(1)}%
- ${corsiLabel}: ${hCF != null ? hCF.toFixed(1) : '—'}%
- Current streak: ${homeStreak}

${awayAbbr} stats:
- Record: ${away.wins}-${away.losses}-${away.ot_losses} (${away.points} pts)
- GF/GA per game: ${aGpg.toFixed(2)} / ${aGag.toFixed(2)}
- PP%: ${aPP.toFixed(1)}% · PK%: ${aPK.toFixed(1)}%
- ${corsiLabel}: ${aCF != null ? aCF.toFixed(1) : '—'}%
- Current streak: ${awayStreak}

Head-to-head this season: ${homeAbbr} ${h2hRecord}
Expected score (Pythagorean): ${homeAbbr} ${expHome} - ${awayAbbr} ${expAway}
Model win probability: ${homeAbbr} ${homeWinPct}%${isPlayoff ? '\n\nNote: This is a playoff game. Ignore regular season points — focus on possession, goaltending, and recent form.' : ''}

Write the analysis now. Mention the single most decisive factor, one risk or concern, and a concrete expected-score range.`;

    let narrative = '';
    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
        messages: [{ role: 'user', content: prompt }],
      });
      narrative = aiResponse.response?.trim() || '';
    } catch (e) {
      console.error('PWHL prediction AI error:', e);
    }
    if (!narrative) return new Response(JSON.stringify({ error: 'Empty AI response' }), { status: 502, headers: corsHeaders() });

    const result = {
      gameId,
      homeTeamId: homeId,
      awayTeamId: awayId,
      homeAbbr,
      awayAbbr,
      isPlayoff,
      homeWinPct,
      awayWinPct: 100 - homeWinPct,
      expHome: parseFloat(expHome),
      expAway: parseFloat(expAway),
      narrative,
      h2hRecord,
      homeStreak,
      awayStreak,
      corsiForPct: { home: hCF, away: aCF },
      corsiCaveat,
      generatedAt: new Date().toISOString(),
    };

    // 30min TTL, not NHL's 24hr (nhl.js:2379) — that convention assumes a
    // day's worth of staleness is fine for lineup-change risk only; PWHL's
    // inputs here (streaks, Corsi) can shift same-day as games finish, and
    // Session 51 explicitly rejected reusing the 24hr convention for this.
    await kvPut(env, kvKey, result, 1800);
    return json(result);
  }

  return new Response('EyeWall Poller', { status: 200 });
}
