/**
 * pwhl.js — EyeWall Analytics Worker
 *
 * All /pwhl/* HTTP endpoints including standings, players, shots, schedule,
 * roster, last game, PBP, news, salaries, league players, scouting, and live game.
 */

import { kvGet, kvPut, json, corsHeaders, SB_URL, SB_ANON, HT_BASE, HT_KEY, HT_HDR, unwrapJsonp, parseRSS, parseESPN, sendPush } from './shared.js';

// PWHL team ID → abbreviation map
const PWHL_TEAM_CODES = { 1:'BOS', 2:'MIN', 3:'MTL', 4:'NY', 5:'OTT', 6:'TOR', 8:'SEA', 9:'VAN' };

const PWHL_NEWS_SOURCES = [
  {
    // ESPN women's hockey RSS — works from Cloudflare IPs
    id:     'espn-pwhl',
    name:   'ESPN',
    color:  '#FFFFFF',
    bg:     '#cc0000',
    url:    'https://www.espn.com/espn/rss/hockey/news',
    type:   'espn',
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
    // The Athletic hockey via NYT — works from Cloudflare IPs
    id:     'athletic-pwhl',
    name:   'The Athletic',
    color:  '#FFFFFF',
    bg:     '#222222',
    url:    'https://theathletic.com/rss/feed/?sport_name=nhl',
    type:   'rss',
    filter: ['pwhl', "women's hockey", 'walter cup', 'women'],
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

async function fetchPWHLNews(env) {
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
  if (deduped.length > 0) await kvPut(env, 'pwhl:news', deduped, 1800);
  return deduped;
}



// ── PWHL Push Notification Poll ──────────────────────────────
// Called from the Worker scheduled trigger alongside NHL poll().
// Checks for live PWHL games, fetches PBP, detects events,
// and sends push notifications to subscribers.
//
// PWHL season IDs: 1=2023-24, 5=2024-25, 8=2025-26 (regular), 9=playoffs
// Flip PWHL_SEASON each October when HockeyTech assigns new IDs.

const PWHL_SEASON = 8;

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

    // Get today's date in Eastern time
    const nowET    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = nowET.toISOString().slice(0, 10);

    // Find today's games
    const schedRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_game_log?game_date=eq.${todayStr}&season_id=eq.${PWHL_SEASON}` +
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

  // broadcast helper — prefixes PWHL: to avoid collisions with NHL abbrevs
  const notify = (homeOrAway, payload, eventType) => {
    const abbr    = homeOrAway === 'home' ? homeAbbr : awayAbbr;
    const teamKey = `PWHL:${abbr}`;
    return broadcastPWHL(env, payload, teamKey, eventType);
  };

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
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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

  // GET /pwhl/players?teamId=1&season=8
  if (url.pathname === '/pwhl/players') {
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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

  // GET /pwhl/schedule?teamId=1&season=8
  // game_log has home_team_id / away_team_id — filter both sides with OR
  if (url.pathname === '/pwhl/schedule') {
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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

  // GET /pwhl/lastgame?teamId=1&season=8
  // Returns the most recent completed game with opponent abbr resolved.
  if (url.pathname === '/pwhl/lastgame') {
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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
  // GH Actions runner IPs are not blocked by RSS sources; Worker IPs are.
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
    await kvPut(env, 'pwhl:news', merged, 1800); // 30min cache
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
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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
  if (url.pathname === '/pwhl/scout' && request.method === 'POST') {
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
    const season   = parseInt(url.searchParams.get('season')   || '8', 10);
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
    const season = parseInt(url.searchParams.get('season') || '8', 10);
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

    let rawEvents = [];
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
  if (url.pathname === '/pwhl/summary/narrative' && request.method === 'POST') {
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

  return new Response('EyeWall Poller', { status: 200 });
}
