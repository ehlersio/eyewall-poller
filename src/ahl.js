/**
 * ahl.js — EyeWall Analytics Worker
 *
 * All /ahl/* HTTP endpoints: standings, players, shots, schedule, roster,
 * team-season-summary, league-players. Mirrors pwhl.js's structure and
 * conventions closely (same Supabase-REST-direct pattern, same KV caching
 * shape) -- see that file for the conventions this one reuses.
 *
 * Real differences from PWHL, all confirmed live against production data
 * (see eyewall-pipeline's docs/hockeytech-ahl-api-notes.md and
 * AHL_ECHL_HOCKEYTECH_API.md for the full investigation):
 *   - ahl_game_log has no ot/shootout boolean columns (not cleanly
 *     available from the scorebar view AHL's pipeline uses).
 *   - ahl_team_seasons reports ot_losses and shootout_losses as separate
 *     columns (PWHL combines them into one non_reg_losses-derived field).
 *   - ahl_player_seasons has no shot_pct/gw_goals/pp_assists/sh_assists
 *     columns -- confirmed absent from AHL's HockeyTech feed entirely, not
 *     just occasionally null.
 *   - No ahl_pbp_events table exists (AHL's PBP has no hit/faceoff events
 *     at all, and penalty-event ingestion wasn't needed -- PP%/PK% already
 *     live on ahl_team_seasons straight from HockeyTech's own special-teams
 *     view). /ahl/team-season-summary therefore has no hits/faceoff/
 *     penalties section, unlike /pwhl/team-season-summary.
 *   - No blocked_shot event type exists in AHL's PBP at all -- ahl_shot_events
 *     only ever has event_type 'shot' or 'goal'. There is no Corsi/Fenwick/
 *     PDO computation anywhere in this file, and none should be added
 *     without a real data source for shot attempts beyond shots-on-goal --
 *     see AHL_BUILD_BRIEF.md's explicit scope notes.
 */

import { kvGet, kvPut, json, corsHeaders, SB_URL, SB_ANON } from './shared.js';
import { resolveAHLSeason, getAllAHLSeasonTypes } from './seasons.js';

// Resolve the ?season= query param, live-resolving the current season
// (see seasons.js) when the param is omitted. Mirrors pwhl.js's
// seasonParam() exactly.
async function seasonParam(url, env) {
  const raw = url.searchParams.get('season');
  if (raw) return parseInt(raw, 10);
  return (await resolveAHLSeason(env)).seasonId;
}

// AHL team ID -> abbreviation map. Current as of season 94 (2026-27),
// confirmed live via feed=modulekit&view=teamsbyseason 2026-08-29 -- same
// hardcoded-snapshot convention as PWHL_TEAM_CODES in pwhl.js (no ahl_teams
// table exists; team display metadata is a frontend concern).
export const AHL_TEAM_CODES = {
  307: 'HFD', 309: 'PRO', 313: 'LV', 316: 'WBS', 319: 'HER', 321: 'MB',
  323: 'ROC', 324: 'SYR', 327: 'MIL', 328: 'GR', 330: 'CHI', 335: 'TOR',
  372: 'RFD', 373: 'CLE', 380: 'TEX', 384: 'CLT', 389: 'IA', 390: 'UTC',
  402: 'BAK', 403: 'ONT', 404: 'SD', 405: 'SJ', 411: 'SPR', 412: 'TUC',
  413: 'BEL', 415: 'LAV', 419: 'COL', 437: 'HSK', 440: 'ABB', 444: 'CGY',
  445: 'CV', 457: 'HAM',
  // Historical franchise rename, not a current team -- Bridgeport
  // Islanders relocated to become the Hamilton Hammers (457) for 2026-27.
  // Needed for historical-season queries (e.g. season 90) which still use
  // "BRI" throughout. See eyewall-pipeline's ahl_stats.py TEAM_ID_MAP for
  // the same entry.
  317: 'BRI',
};

const sbH = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` };

async function resolveSeasonType(env, seasonId) {
  const types = await getAllAHLSeasonTypes(env);
  return types?.[String(seasonId)] || 'regular';
}

export async function handleAHL(request, env, ctx, url) {
  // GET /ahl/standings?season=90
  // Mirrors /pwhl/standings' L10/streak enrichment from game log, computed
  // the same way. AHL's team_seasons.wins is already the season total
  // (regulation + OT/SO) -- see ahl_stats.py -- so no PWHL-style
  // regulation_wins + non_reg_wins addition is needed here either.
  if (url.pathname === '/ahl/standings') {
    const season = await seasonParam(url, env);
    const kvKey = `ahl:standings:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const seasonType = await resolveSeasonType(env, season);
    const [standRes, gameRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/ahl_team_seasons?season_id=eq.${season}&season_type=eq.${seasonType}&order=points.desc&limit=32`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/ahl_game_log?season_id=eq.${season}&game_state=eq.Final&order=game_id.desc&limit=1500&select=game_id,home_team_id,away_team_id,home_score,away_score`,
        { headers: sbH }
      ),
    ]);
    if (!standRes.ok) return new Response(JSON.stringify({ error: `Supabase ${standRes.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await standRes.json();
    const games = gameRes.ok ? await gameRes.json() : [];

    // L10/streak from recent game log -- no ot/shootout columns on
    // ahl_game_log (see module docstring), so every non-win here is
    // counted as a plain loss ('L'), not split into a regulation-loss vs
    // OT-loss ('O') the way /pwhl/standings can. Streak logic is otherwise
    // identical.
    const teamStats = {};
    for (const g of games) {
      for (const [tid, myScore, oppScore] of [
        [g.home_team_id, g.home_score, g.away_score],
        [g.away_team_id, g.away_score, g.home_score],
      ]) {
        if (!tid) continue;
        if (!teamStats[tid]) teamStats[tid] = { games: [] };
        teamStats[tid].games.push(myScore > oppScore ? 'W' : 'L');
      }
    }
    const enriched = rows.map(r => {
      const ts = teamStats[r.team_id];
      if (!ts) return r;
      const last10 = ts.games.slice(0, 10);
      const l10W = last10.filter(x => x === 'W').length;
      const l10L = last10.filter(x => x === 'L').length;
      let streak = 0, streakType = '';
      for (const res of ts.games) {
        if (!streakType) { streakType = res; streak = 1; }
        else if (res === streakType) streak++;
        else break;
      }
      return { ...r, l10W, l10L, streakType, streakCount: streak };
    });
    await kvPut(env, kvKey, enriched, 3600);
    return json(enriched);
  }

  // GET /ahl/schedule?teamId=444&season=90
  if (url.pathname === '/ahl/schedule') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `ahl:schedule:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/ahl_game_log?season_id=eq.${season}&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_date.asc&limit=150`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 1800);
    return json(rows);
  }

  // GET /ahl/roster?teamId=444
  // Bare player list for name resolution (shot map tooltips, etc.).
  if (url.pathname === '/ahl/roster') {
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `ahl:roster:${teamId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/ahl_players?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number&limit=60`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 24 * 3600); // 24hr — roster rarely changes
    return json(rows);
  }

  // GET /ahl/players?teamId=444&season=90
  // Skater + goalie season stats for one team, plus a jersey-sorted roster
  // list for the Roster tab. Mirrors /pwhl/players' shape.
  if (url.pathname === '/ahl/players') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `ahl:players:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const seasonType = await resolveSeasonType(env, season);
    const [skatersRes, goaliesRes, rosterRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/ahl_player_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&order=points.desc&limit=40`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/ahl_goalie_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&order=gp.desc&limit=5`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/ahl_players?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number,birth_date,birth_place,shoots,height_inches,weight_lbs&limit=80`,
        { headers: sbH }
      ),
    ]);
    if (!skatersRes.ok || !goaliesRes.ok || !rosterRes.ok) {
      return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    }
    const [skaters, goalies, rosterRaw] = await Promise.all([skatersRes.json(), goaliesRes.json(), rosterRes.json()]);

    const allPlayersRes = await fetch(
      `${SB_URL}/rest/v1/ahl_players?select=player_id,first_name,last_name,position,jersey_number,birth_date,birth_place,shoots,height_inches,weight_lbs&limit=1500`,
      { headers: sbH }
    );
    const allPlayers = allPlayersRes.ok ? await allPlayersRes.json() : rosterRaw;

    const nameMap = {};
    for (const p of allPlayers) {
      nameMap[p.player_id] = {
        player_name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        first_name: p.first_name || null,
        last_name: p.last_name || null,
        position: p.position || null,
        jersey_number: p.jersey_number || null,
        birth_date: p.birth_date || null,
        birth_place: p.birth_place || null,
        shoots: p.shoots || null,
        height_inches: p.height_inches || null,
        weight_lbs: p.weight_lbs || null,
        headshot: `https://assets.leaguestat.com/ahl/240x240/${p.player_id}.jpg`,
      };
    }
    const skatersWithNames = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
    const goaliesWithNames = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));
    const rosterFull = rosterRaw
      .map(p => ({ ...p, headshot: `https://assets.leaguestat.com/ahl/240x240/${p.player_id}.jpg` }))
      .sort((a, b) => {
        if (a.jersey_number == null && b.jersey_number == null) return 0;
        if (a.jersey_number == null) return 1;
        if (b.jersey_number == null) return -1;
        return a.jersey_number - b.jersey_number;
      });
    const result = { skaters: skatersWithNames, goalies: goaliesWithNames, roster: rosterFull };
    await kvPut(env, kvKey, result, 3600);
    return json(result);
  }

  // GET /ahl/league-players?season=90
  // All teams' skater + goalie season stats (Leaders tab).
  if (url.pathname === '/ahl/league-players') {
    const season = await seasonParam(url, env);
    const kvKey = `ahl:leagueplayers:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const seasonType = await resolveSeasonType(env, season);
    const [skatersRes, goaliesRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/ahl_player_seasons?season_id=eq.${season}&season_type=eq.${seasonType}&select=player_id,team_id,goals,assists,points,gp,shots,pp_goals,sh_goals,pim,plus_minus&order=points.desc&limit=600`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/ahl_goalie_seasons?season_id=eq.${season}&season_type=eq.${seasonType}&select=player_id,team_id,gp,wins,losses,ot_losses,gaa,sv_pct,shutouts,saves,goals_against&order=sv_pct.desc&limit=80`,
        { headers: sbH }
      ),
    ]);
    if (!skatersRes.ok || !goaliesRes.ok) {
      return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    }
    const [skaters, goalies] = await Promise.all([skatersRes.json(), goaliesRes.json()]);

    const nameRes = await fetch(
      `${SB_URL}/rest/v1/ahl_players?select=player_id,first_name,last_name,position,team_id&limit=1500`,
      { headers: sbH }
    );
    const nameRows = nameRes.ok ? await nameRes.json() : [];
    const nameMap = {};
    for (const p of nameRows) {
      nameMap[p.player_id] = {
        player_name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        first_name: p.first_name, last_name: p.last_name, position: p.position,
      };
    }
    const enrichSkaters = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
    const enrichGoalies = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));
    const result = { skaters: enrichSkaters, goalies: enrichGoalies };
    await kvPut(env, kvKey, result, 3600 * 2);
    return json(result);
  }

  // GET /ahl/shots?teamId=444&season=90
  // Paginates through all rows in batches of 1000 to bypass Supabase's row
  // cap, same as /pwhl/shots. Only ever 'shot' or 'goal' event_type rows
  // exist -- no 'blocked_shot' in this data source (see module docstring).
  if (url.pathname === '/ahl/shots') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `ahl:shots:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const PAGE = 1000;
    const allRows = [];
    let offset = 0;
    while (true) {
      const r = await fetch(
        `${SB_URL}/rest/v1/ahl_shot_events?team_id=eq.${teamId}&season_id=eq.${season}&order=game_id.asc`,
        {
          headers: {
            ...sbH,
            Range: `${offset}-${offset + PAGE - 1}`,
            'Range-Unit': 'items',
            Prefer: 'count=none',
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
    console.log(`AHL shots: teamId=${teamId} season=${season} total=${allRows.length}`);
    return json(allRows);
  }

  // GET /ahl/team-season-summary?teamId=444&season=90
  // Season-aggregate SOG for the Shot Map's "All N" summary card, plus
  // PP%/PK% (already computed on ahl_team_seasons -- same source
  // /ahl/standings reads). Deliberately NO hits/blocked/faceoff/penalties
  // sections, unlike /pwhl/team-season-summary -- there is no
  // ahl_pbp_events table and no blocked_shot event type in this data
  // source at all (see module docstring). Don't add fabricated zeros for
  // these fields; the frontend should simply not render those cards for
  // AHL.
  if (url.pathname === '/ahl/team-season-summary') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `ahl:team-season-summary:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const gameRes = await fetch(
      `${SB_URL}/rest/v1/ahl_game_log?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&select=game_id`,
      { headers: sbH }
    );
    if (!gameRes.ok) return new Response(JSON.stringify({ error: `Supabase ${gameRes.status}` }), { status: 502, headers: corsHeaders() });
    const gameIds = (await gameRes.json()).map(g => g.game_id);

    const seasonType = await resolveSeasonType(env, season);
    const tsRes = await fetch(
      `${SB_URL}/rest/v1/ahl_team_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&select=pp_pct,pk_pct`,
      { headers: sbH }
    );
    const tsRow = tsRes.ok ? (await tsRes.json())[0] : null;

    const empty = { teamId, season, gamesPlayed: gameIds.length, sog: { car: 0, opp: 0 }, ppPct: tsRow?.pp_pct ?? null, pkPct: tsRow?.pk_pct ?? null };
    if (!gameIds.length) {
      await kvPut(env, kvKey, empty, 3600);
      return json(empty);
    }

    let sogCar = 0, sogOpp = 0;
    const PAGE = 1000;
    let offset = 0;
    try {
      while (true) {
        const r = await fetch(
          `${SB_URL}/rest/v1/ahl_shot_events?game_id=in.(${gameIds.join(',')})&select=team_id,event_type`,
          { headers: { ...sbH, Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items', Prefer: 'count=none' } }
        );
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        const rows = await r.json();
        for (const row of rows) {
          if (row.event_type !== 'shot' && row.event_type !== 'goal') continue;
          if (row.team_id === teamId) sogCar++; else sogOpp++;
        }
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: corsHeaders() });
    }

    const data = { teamId, season, gamesPlayed: gameIds.length, sog: { car: sogCar, opp: sogOpp }, ppPct: tsRow?.pp_pct ?? null, pkPct: tsRow?.pk_pct ?? null };
    await kvPut(env, kvKey, data, 3600);
    console.log(`AHL team-season-summary: teamId=${teamId} season=${season} games=${gameIds.length}`);
    return json(data);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
}
