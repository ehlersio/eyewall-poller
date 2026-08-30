/**
 * echl.js — EyeWall Analytics Worker
 *
 * /echl/* HTTP endpoints: standings, schedule, roster, players,
 * league-players, shots, team-season-summary. Foundation + basic display
 * pass only (user's explicit scope choice) -- mirrors ahl.js's structure
 * and conventions closely (same Supabase-REST-direct pattern, same KV
 * caching shape) -- see that file for the conventions this one reuses.
 *
 * Not in this pass (deferred to a later parity pass, matching AHL's own
 * two-pass history): player/landing, player/career, player-shots,
 * lastgame, summary, preview, game-box, player-game-log, prediction,
 * team-seasons compare/compare-teams/head-to-head(+narrative), news
 * routes, today/live routes.
 *
 * Real differences from AHL, all confirmed live 2026-08-30 against
 * production data (see eyewall-pipeline's docs/hockeytech-ahl-api-notes.md
 * and ECHL_BUILD_BRIEF.md):
 *   - Same data-shape ceiling as AHL: no shift data, no hit/faceoff/
 *     blocked_shot event types, hits/faceoffs hardcoded "0" in the box
 *     score. No Corsi/Fenwick/PDO anywhere in this file either.
 *   - echl_game_log has no ot/shootout boolean columns, same as AHL.
 *   - echl_team_seasons reports ot_losses and shootout_losses as separate
 *     columns, same as AHL.
 *   - echl_player_seasons has no shot_pct/gw_goals/pp_assists/sh_assists
 *     columns, same as AHL.
 *   - This league's HockeyTech key is NOT exposed on echl.com's own site
 *     (Laravel/Livewire rebuild, renders server-side) -- if it ever
 *     breaks, re-check sportsdataverse-py's league registry, not a
 *     network-tab hunt (see seasons.js's ECHL_HT_KEY comment).
 */

import { kvGet, kvPut, json, corsHeaders, SB_URL, SB_ANON } from './shared.js';
import { resolveECHLSeason, getAllECHLSeasonTypes } from './seasons.js';

// Resolve the ?season= query param, live-resolving the current season
// when the param is omitted. Mirrors ahl.js's seasonParam() exactly.
async function seasonParam(url, env) {
  const raw = url.searchParams.get('season');
  if (raw) return parseInt(raw, 10);
  return (await resolveECHLSeason(env)).seasonId;
}

async function resolveSeasonType(env, seasonId) {
  const types = await getAllECHLSeasonTypes(env);
  return types?.[String(seasonId)] || 'regular';
}

const sbH = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` };

// ECHL team ID -> abbreviation map. Current as of season 77/78 (2026-27),
// confirmed live via feed=modulekit&view=teamsbyseason 2026-08-30 -- same
// hardcoded-snapshot convention as AHL_TEAM_CODES in ahl.js (no
// echl_teams table exists; team display metadata is a frontend concern).
export const ECHL_TEAM_CODES = {
  74: 'ADK', 66: 'ALN', 10: 'ATL', 107: 'BLM', 5: 'CIN', 8: 'FLA',
  60: 'FW', 108: 'GSO', 52: 'GVL', 11: 'IDH', 65: 'IND', 79: 'JAX',
  50: 'KAL', 68: 'KC', 82: 'MNE', 114: 'NM', 76: 'NOR', 61: 'ORL',
  70: 'RC', 17: 'REA', 102: 'SAV', 18: 'SC', 106: 'TAH', 21: 'TOL',
  113: 'TRE', 99: 'TR', 71: 'TUL', 25: 'WHL', 72: 'WIC', 77: 'WOR',
};

export async function handleECHL(request, env, ctx, url) {
  // ── ECHL endpoints ───────────────────────────────────────────────────────

  // GET /echl/standings?season=73
  // L10/streak from recent game log -- no ot/shootout columns on
  // echl_game_log, so every non-win here is counted as a plain loss
  // ('L'), same as AHL's /ahl/standings.
  if (url.pathname === '/echl/standings') {
    const season = await seasonParam(url, env);
    const kvKey = `echl:standings:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const seasonType = await resolveSeasonType(env, season);
    const [standRes, gameRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/echl_team_seasons?season_id=eq.${season}&season_type=eq.${seasonType}&order=points.desc&limit=32`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/echl_game_log?season_id=eq.${season}&game_state=eq.Final&order=game_id.desc&limit=1500&select=game_id,home_team_id,away_team_id,home_score,away_score`,
        { headers: sbH }
      ),
    ]);
    if (!standRes.ok) return new Response(JSON.stringify({ error: `Supabase ${standRes.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await standRes.json();
    const games = gameRes.ok ? await gameRes.json() : [];

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

  // GET /echl/schedule?teamId=8&season=73
  if (url.pathname === '/echl/schedule') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:schedule:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/echl_game_log?season_id=eq.${season}&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_date.asc&limit=150`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 1800);
    return json(rows);
  }

  // GET /echl/roster?teamId=8
  // Bare player list for name resolution (shot map tooltips, etc.).
  if (url.pathname === '/echl/roster') {
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:roster:${teamId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/echl_players?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number&limit=60`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    await kvPut(env, kvKey, rows, 24 * 3600); // 24hr — roster rarely changes
    return json(rows);
  }

  // GET /echl/players?teamId=8&season=73
  // Skater + goalie season stats for one team, plus a jersey-sorted
  // roster list for the Roster tab. Mirrors /ahl/players' shape.
  if (url.pathname === '/echl/players') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:players:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const seasonType = await resolveSeasonType(env, season);
    const [skatersRes, goaliesRes, rosterRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/echl_player_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&order=points.desc&limit=40`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/echl_goalie_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&order=gp.desc&limit=5`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/echl_players?team_id=eq.${teamId}&select=player_id,first_name,last_name,position,jersey_number,birth_date,birth_place,shoots,height_inches,weight_lbs&limit=80`,
        { headers: sbH }
      ),
    ]);
    if (!skatersRes.ok || !goaliesRes.ok || !rosterRes.ok) {
      return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    }
    const [skaters, goalies, rosterRaw] = await Promise.all([skatersRes.json(), goaliesRes.json(), rosterRes.json()]);

    const allPlayersRes = await fetch(
      `${SB_URL}/rest/v1/echl_players?select=player_id,first_name,last_name,position,jersey_number,birth_date,birth_place,shoots,height_inches,weight_lbs&limit=1500`,
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
        headshot: `https://assets.leaguestat.com/echl/120x160/${p.player_id}.jpg`,
      };
    }
    const skatersWithNames = skaters.map(s => ({ ...s, ...nameMap[s.player_id] }));
    const goaliesWithNames = goalies.map(g => ({ ...g, ...nameMap[g.player_id] }));
    const rosterFull = rosterRaw
      .map(p => ({ ...p, headshot: `https://assets.leaguestat.com/echl/120x160/${p.player_id}.jpg` }))
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

  // GET /echl/league-players?season=73
  // All teams' skater + goalie season stats (Leaders tab).
  if (url.pathname === '/echl/league-players') {
    const season = await seasonParam(url, env);
    const kvKey = `echl:leagueplayers:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const seasonType = await resolveSeasonType(env, season);
    const [skatersRes, goaliesRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/echl_player_seasons?season_id=eq.${season}&season_type=eq.${seasonType}&select=player_id,team_id,goals,assists,points,gp,shots,pp_goals,sh_goals,pim,plus_minus&order=points.desc&limit=600`,
        { headers: sbH }
      ),
      fetch(
        `${SB_URL}/rest/v1/echl_goalie_seasons?season_id=eq.${season}&season_type=eq.${seasonType}&select=player_id,team_id,gp,wins,losses,ot_losses,gaa,sv_pct,shutouts,saves,goals_against&order=sv_pct.desc&limit=80`,
        { headers: sbH }
      ),
    ]);
    if (!skatersRes.ok || !goaliesRes.ok) {
      return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    }
    const [skaters, goalies] = await Promise.all([skatersRes.json(), goaliesRes.json()]);

    const nameRes = await fetch(
      `${SB_URL}/rest/v1/echl_players?select=player_id,first_name,last_name,position,team_id&limit=1500`,
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

  // GET /echl/shots?teamId=8&season=73
  // Paginates through all rows in batches of 1000 to bypass Supabase's
  // row cap, same as /ahl/shots. Only ever 'shot' or 'goal' event_type
  // rows exist -- no 'blocked_shot' in this data source.
  if (url.pathname === '/echl/shots') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:shots:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const PAGE = 1000;
    const allRows = [];
    let offset = 0;
    while (true) {
      const r = await fetch(
        `${SB_URL}/rest/v1/echl_shot_events?team_id=eq.${teamId}&season_id=eq.${season}&order=game_id.asc`,
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
    console.log(`ECHL shots: teamId=${teamId} season=${season} total=${allRows.length}`);
    return json(allRows);
  }

  // GET /echl/team-season-summary?teamId=8&season=73
  // Season-aggregate SOG for the Shot Map's "All N" summary card, plus
  // PP%/PK% (already computed on echl_team_seasons). Deliberately NO
  // hits/blocked/faceoff/penalties sections, same as AHL -- there is no
  // echl_pbp_events table and no blocked_shot event type in this data
  // source at all.
  if (url.pathname === '/echl/team-season-summary') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:team-season-summary:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const gameRes = await fetch(
      `${SB_URL}/rest/v1/echl_game_log?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&select=game_id`,
      { headers: sbH }
    );
    if (!gameRes.ok) return new Response(JSON.stringify({ error: `Supabase ${gameRes.status}` }), { status: 502, headers: corsHeaders() });
    const gameIds = (await gameRes.json()).map(g => g.game_id);

    const seasonType = await resolveSeasonType(env, season);
    const tsRes = await fetch(
      `${SB_URL}/rest/v1/echl_team_seasons?team_id=eq.${teamId}&season_id=eq.${season}&season_type=eq.${seasonType}&select=pp_pct,pk_pct`,
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
          `${SB_URL}/rest/v1/echl_shot_events?game_id=in.(${gameIds.join(',')})&select=team_id,event_type`,
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
    console.log(`ECHL team-season-summary: teamId=${teamId} season=${season} games=${gameIds.length}`);
    return json(data);
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
}
