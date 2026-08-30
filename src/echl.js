/**
 * echl.js — EyeWall Analytics Worker
 *
 * /echl/* HTTP endpoints: standings, schedule, roster, players,
 * league-players, shots, team-season-summary. Foundation + basic display
 * pass only (user's explicit scope choice) -- mirrors ahl.js's structure
 * and conventions closely (same Supabase-REST-direct pattern, same KV
 * caching shape) -- see that file for the conventions this one reuses.
 *
 * player/landing, player/career, and player-shots (parity plan Phase 2
 * equivalent) were added 2026-08-30 -- mirrors ahl.js's own 3 routes
 * exactly, see those for the shared conventions.
 *
 * lastgame, summary, preview, game-box, and prediction (Phase 3
 * equivalent) were added 2026-08-30 -- mirrors ahl.js's own routes
 * exactly. No player-game-log route: confirmed AHL's own equivalent
 * (/ahl/player-game-log) has zero frontend consumers anywhere in
 * eyewallanalytics -- a real pre-existing gap (built for a "Compare"
 * feature that was never wired up), not something worth reproducing here.
 *
 * team-seasons compare/compare-teams/head-to-head(+narrative) (Phase 4
 * equivalent) were added 2026-08-30 -- mirrors ahl.js's own 4 routes
 * exactly. worker.js's /config/seasons/comparison also got a real 'echl'
 * entry as part of this same change (see seasons.js's
 * getAllECHLSeasons() comment -- it fixes a matching, already-shipped gap
 * in AHL's own entry at the same time).
 *
 * Not in this pass (deferred to a later parity pass, matching AHL's own
 * two-pass history): news routes, today/live routes.
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

import { kvGet, kvPut, json, corsHeaders, SB_URL, SB_ANON, unwrapJsonp, extractCareerTotal, extractRows, extractBioPoints, extractPhoto, checkAiRateLimit, generateText, buildHeadToHeadPayload } from './shared.js';
import { resolveECHLSeason, getAllECHLSeasonTypes, ECHL_HT_BASE, ECHL_HT_KEY, ECHL_HT_HDR } from './seasons.js';

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

  // GET /echl/player/landing?id=6681&season=73
  // Player detail lookup for ECHLPlayerPopup -- self-fetches identity + a
  // season's stat line by id. Mirrors /ahl/player/landing exactly
  // (echl_players/echl_player_seasons/echl_goalie_seasons are the same
  // shape as their AHL counterparts) -- Supabase-only, no HockeyTech call.
  if (url.pathname === '/echl/player/landing') {
    const playerId = url.searchParams.get('id');
    const seasonQ = url.searchParams.get('season');
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey = `echl:player:landing:${playerId}:${seasonQ || 'latest'}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const playerRes = await fetch(`${SB_URL}/rest/v1/echl_players?player_id=eq.${playerId}&select=*`, { headers: sbH });
    if (!playerRes.ok) return new Response(JSON.stringify({ error: `Supabase ${playerRes.status}` }), { status: 502, headers: corsHeaders() });
    const playerRows = await playerRes.json();
    if (!playerRows.length) return new Response(JSON.stringify({ error: 'Player not found' }), { status: 404, headers: corsHeaders() });

    const player = playerRows[0];
    const statsTable = player.position === 'G' ? 'echl_goalie_seasons' : 'echl_player_seasons';
    const statsQuery = seasonQ
      ? `player_id=eq.${playerId}&season_id=eq.${seasonQ}&season_type=eq.regular&limit=1&select=*`
      : `player_id=eq.${playerId}&season_type=eq.regular&order=season_id.desc&limit=1&select=*`;

    const statsRes = await fetch(`${SB_URL}/rest/v1/${statsTable}?${statsQuery}`, { headers: sbH });
    const statsRows = statsRes.ok ? await statsRes.json() : [];
    const stats = statsRows[0] || {};

    const data = { ...player, ...stats };
    await kvPut(env, kvKey, data, 3600);
    return json(data);
  }

  // GET /echl/player/career?id=6681
  // Live proxy for HockeyTech's view=player careerStats Total rows, same
  // shape/role as /ahl/player/career -- reuses shared.js's
  // extractCareerTotal/extractRows/extractBioPoints/extractPhoto
  // unmodified, same "identical statviewfeed view=player shape across the
  // whole vendor" reasoning already confirmed for AHL/PWHL.
  // No ?season= param -- careerStats is season-independent.
  if (url.pathname === '/echl/player/career') {
    const playerId = url.searchParams.get('id');
    if (!playerId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: corsHeaders() });

    const kvKey = `echl:player:career:${playerId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const htRes = await fetch(
      `${ECHL_HT_BASE}?feed=statviewfeed&view=player&player_id=${playerId}&site_id=0&key=${ECHL_HT_KEY}&client_code=echl&lang=en&league_id=&statsType=standard`,
      { headers: ECHL_HT_HDR }
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
    const draftRows = extractRows(raw?.draftInfo?.[0]?.sections, '');
    const draft = (raw?.info?.display_drafts === true && draftRows.length > 0) ? draftRows[0] : null;

    const gameRows = extractRows(raw?.gameByGame?.[0]?.sections, '');
    const recentGames = gameRows.slice(-5).reverse();

    const data = {
      player_id:     parseInt(playerId, 10),
      regularSeason: extractCareerTotal(sections, 'Regular Season'),
      playoffs:      extractCareerTotal(sections, 'Playoffs'),
      bioPoints:     extractBioPoints(raw?.info?.bio),
      photo:         extractPhoto(raw?.media?.images),
      draft,
      recentGames,
    };

    await kvPut(env, kvKey, data, 24 * 3600);
    return json(data);
  }

  // GET /echl/player-shots?playerId=6681&season=73
  // Shot-map heat map data for a single skater. Mirrors /ahl/player-shots
  // exactly (echl_shot_events has the same x_norm/y_norm shape) -- skaters
  // only. No /echl/goalie-shots equivalent: ECHL's PBP goal events also
  // carry goalie_id: null (echl_shot_events.py's own comment, confirmed
  // 2026-08-30 -- same structural gap as AHL's feed). Shown as an honest
  // "not available" state in ECHLPlayerPopup instead of a heat map that
  // would silently under-count goals.
  if (url.pathname === '/echl/player-shots') {
    const playerId = parseInt(url.searchParams.get('playerId') || '0', 10);
    const season = await seasonParam(url, env);
    if (!playerId) return new Response(JSON.stringify({ error: 'playerId required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:pshots:${playerId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/echl_shot_events?shooter_id=eq.${playerId}&season_id=eq.${season}&select=event_type,period_id,time_seconds,x_norm,y_norm&limit=500`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    const shots = rows.map(row => {
      let x = parseFloat(row.x_norm), y = parseFloat(row.y_norm);
      if (x < 0) { x = -x; y = -y; }
      return {
        x: Math.min(Math.abs(x), 99),
        y: Math.max(-42, Math.min(42, y)),
        t: row.event_type === 'goal' ? 'g' : 's',
        p: row.period_id,
      };
    }).filter(s => !isNaN(s.x) && !isNaN(s.y));
    const result = { shots, total: shots.length };
    await kvPut(env, kvKey, result, 3600 * 6);
    return json(result);
  }

  // GET /echl/lastgame?teamId=8&season=73
  // Most recent completed game with opponent abbr resolved. Thin port of
  // /ahl/lastgame -- echl_game_log has no ot/shootout columns either, so
  // those fields are just omitted from the result.
  if (url.pathname === '/echl/lastgame') {
    const season = await seasonParam(url, env);
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    if (!teamId) return new Response(JSON.stringify({ error: 'teamId param required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:lastgame:${teamId}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const r = await fetch(
      `${SB_URL}/rest/v1/echl_game_log?season_id=eq.${season}&game_state=eq.Final&or=(home_team_id.eq.${teamId},away_team_id.eq.${teamId})&order=game_id.desc&limit=1`,
      { headers: sbH }
    );
    if (!r.ok) return new Response(JSON.stringify({ error: `Supabase ${r.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await r.json();
    if (!rows.length) return json(null);
    const g = rows[0];
    const isHome = g.home_team_id === teamId;
    const oppId = isHome ? g.away_team_id : g.home_team_id;
    const teamScore = isHome ? g.home_score : g.away_score;
    const oppScore = isHome ? g.away_score : g.home_score;
    const result = {
      gameId: g.game_id,
      gameDate: g.game_date,
      opponentId: oppId,
      opponentAbbr: ECHL_TEAM_CODES[oppId] || String(oppId),
      isHome,
      teamScore,
      oppScore,
      won: teamScore > oppScore,
    };
    await kvPut(env, kvKey, result, 3600);
    return json(result);
  }

  // GET /echl/summary?gameId=24296
  // Live proxy for HockeyTech's gameSummary view -- period-by-period
  // scoring, three stars, officials/coaches, venue. Mirrors /ahl/summary
  // exactly -- confirmed live 2026-08-30 that ECHL's gameSummary has the
  // identical periods/mostValuablePlayers/referees/linesmen/coaches/
  // details/homeTeam+visitingTeam.stats shape as AHL's, including the
  // same fake hits/faceoffAttempts/faceoffWins/faceoffWinPercentage
  // fields (always 0 regardless of the real game) -- stripped here for
  // the same reason AHL's route strips them.
  if (url.pathname === '/echl/summary') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });

    const kvKey = `echl:gamesummary:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const htRes = await fetch(
      `${ECHL_HT_BASE}?feed=statviewfeed&view=gameSummary&game_id=${gameId}&key=${ECHL_HT_KEY}&client_code=echl&lang=en&league_id=`,
      { headers: ECHL_HT_HDR }
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
        id: parseInt(p.info?.id, 10) || 1,
        shortName: p.info?.shortName || '',
        longName: p.info?.longName || '',
      },
      stats: {
        homeGoals: parseInt(p.stats?.homeGoals || 0),
        homeShots: parseInt(p.stats?.homeShots || 0),
        visitingGoals: parseInt(p.stats?.visitingGoals || 0),
        visitingShots: parseInt(p.stats?.visitingShots || 0),
      },
      goals: (p.goals || []).map(g => ({
        game_goal_id: g.game_goal_id || null,
        time: g.time || '0:00',
        team: {
          id: parseInt(g.team?.id, 10) || null,
          abbreviation: normAbbr(g.team?.abbreviation),
        },
        scoredBy: g.scoredBy ? {
          id: parseInt(g.scoredBy.id, 10) || null,
          firstName: g.scoredBy.firstName || '',
          lastName: g.scoredBy.lastName || '',
          playerImageURL: g.scoredBy.playerImageURL || null,
        } : null,
        assists: (g.assists || []).map(a => ({
          id: parseInt(a.id, 10) || null,
          firstName: a.firstName || '',
          lastName: a.lastName || '',
        })),
        properties: {
          isPowerPlay: g.properties?.isPowerPlay || '0',
          isShortHanded: g.properties?.isShortHanded || '0',
          isEmptyNet: g.properties?.isEmptyNet || '0',
          isPenaltyShot: g.properties?.isPenaltyShot || '0',
          isGameWinningGoal: g.properties?.isGameWinningGoal || '0',
        },
      })),
    }));

    const mvps = (raw.mostValuablePlayers || []).map(mvp => ({
      team: {
        id: parseInt(mvp.team?.id, 10) || null,
        abbreviation: normAbbr(mvp.team?.abbreviation),
        name: mvp.team?.name || '',
      },
      player: {
        info: {
          id: parseInt(mvp.player?.info?.id, 10) || null,
          firstName: mvp.player?.info?.firstName || '',
          lastName: mvp.player?.info?.lastName || '',
          jerseyNumber: mvp.player?.info?.jerseyNumber || null,
          position: mvp.player?.info?.position || '',
          playerImageURL: mvp.player?.info?.playerImageURL || null,
        },
        stats: mvp.player?.stats || {},
      },
      isGoalie: !!mvp.isGoalie,
      playerImage: mvp.playerImage || mvp.player?.info?.playerImageURL?.replace('/120x160/', '/240x240/') || null,
      homeTeam: mvp.homeTeam === 1 || mvp.homeTeam === true,
    }));

    const official = (o) => ({
      firstName: o.firstName || '',
      lastName: o.lastName || '',
      jerseyNumber: o.jerseyNumber != null ? parseInt(o.jerseyNumber, 10) : null,
    });
    const headCoach = (coaches) => {
      const c = (coaches || []).find(c => c.role === 'Head Coach');
      return c ? { firstName: c.firstName || '', lastName: c.lastName || '' } : null;
    };

    // Strips hits/faceoffAttempts/faceoffWins/faceoffWinPercentage -- see
    // route comment above for why.
    const stripFakeStats = (stats) => {
      if (!stats) return {};
      const rest = { ...stats };
      delete rest.hits;
      delete rest.faceoffAttempts;
      delete rest.faceoffWins;
      delete rest.faceoffWinPercentage;
      return rest;
    };

    const payload = {
      periods,
      mvps,
      venue: raw.details?.venue || null,
      officials: {
        referees: (raw.referees || []).map(official),
        linesmen: (raw.linesmen || []).map(official),
      },
      coaches: {
        home: headCoach(raw.homeTeam?.coaches),
        away: headCoach(raw.visitingTeam?.coaches),
      },
      homeTeamStats: stripFakeStats(raw.homeTeam?.stats),
      visitingTeamStats: stripFakeStats(raw.visitingTeam?.stats),
    };
    await kvPut(env, kvKey, payload, 3600);
    return json(payload);
  }

  // GET /echl/preview?gameId=24296
  // Live proxy for HockeyTech's gameCenterPreview view -- season series/
  // H2H/streaks/leaders/special teams for an upcoming game. Mirrors
  // /ahl/preview exactly: returns the raw HockeyTech payload as-is, no
  // server-side reshaping. Confirmed live 2026-08-30 against a real ECHL
  // game that this view responds with the identical homeTeam/
  // visitingTeam/headToHeadRecords/previousMeetings shape as AHL's --
  // teamRecord.overall/past_10_games, powerPlayStats/penaltyKillStats
  // nested per-team, same as AHL (see ECHLGamePreviewPopup.jsx).
  // 30min TTL -- pre-game data (records, streaks) shifts daily.
  if (url.pathname === '/echl/preview') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:gcpreview:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);
    const htRes = await fetch(
      `${ECHL_HT_BASE}?feed=statviewfeed&view=gameCenterPreview&game_id=${gameId}&key=${ECHL_HT_KEY}&client_code=echl&lang=en&league_id=`,
      { headers: ECHL_HT_HDR }
    );
    if (!htRes.ok) return new Response(JSON.stringify({ error: `HockeyTech ${htRes.status}` }), { status: 502, headers: corsHeaders() });
    let raw;
    try {
      raw = unwrapJsonp(await htRes.text());
    } catch (e) {
      return new Response(JSON.stringify({ error: 'gameCenterPreview parse failed', detail: e.message }), { status: 502, headers: corsHeaders() });
    }
    await kvPut(env, kvKey, raw, 1800);
    return json(raw);
  }

  // GET /echl/game-box?gameId=24296
  // Per-game player box score, from echl_skater_game_box/echl_goalie_game_box
  // (already ingested in the foundation pass's echl_game_boxscore.py, both
  // season 73 and 76 fully backfilled). No hits/faceoff/blocked-shots/
  // skater-TOI columns at all -- same as AHL's table.
  if (url.pathname === '/echl/game-box') {
    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });
    const kvKey = `echl:gamebox:${gameId}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const [skaterRes, goalieRes, gameRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/echl_skater_game_box?game_id=eq.${gameId}&order=points.desc`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/echl_goalie_game_box?game_id=eq.${gameId}`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/echl_game_log?game_id=eq.${gameId}&select=home_team_id,away_team_id`, { headers: sbH }),
    ]);
    if (!skaterRes.ok || !goalieRes.ok) {
      return new Response(JSON.stringify({ error: 'Supabase error' }), { status: 502, headers: corsHeaders() });
    }
    const [skaters, goalies, gameRows] = await Promise.all([skaterRes.json(), goalieRes.json(), gameRes.ok ? gameRes.json() : []]);
    const gameTeamIds = gameRows[0] ? [gameRows[0].home_team_id, gameRows[0].away_team_id] : [];

    const playerIds = [...new Set([...skaters, ...goalies].map(r => r.player_id))];
    const nameMap = {};
    if (playerIds.length) {
      const nameRes = await fetch(
        `${SB_URL}/rest/v1/echl_players?player_id=in.(${playerIds.join(',')})&select=player_id,first_name,last_name`,
        { headers: sbH }
      );
      if (nameRes.ok) {
        for (const p of await nameRes.json()) {
          nameMap[p.player_id] = `${p.first_name || ''} ${p.last_name || ''}`.trim();
        }
      }
    }

    const withName = (r) => ({ ...r, player_name: nameMap[r.player_id] || null });
    const result = {
      gameId,
      homeTeamId: gameTeamIds[0] ?? null,
      awayTeamId: gameTeamIds[1] ?? null,
      skaters: skaters.map(withName),
      goalies: goalies.map(withName),
    };
    await kvPut(env, kvKey, result, 3600);
    return json(result);
  }

  // GET /echl/prediction?gameId=24296
  // Heuristic win-probability model + AI narrative, ported from
  // /ahl/prediction with the same Corsi-term omission -- echl_team_seasons
  // has no corsi_for_pct[_5v5] columns either. echl_game_log also has no
  // ot/shootout columns, so the streak calc can't distinguish an OT/SO
  // result -- every non-win just counts as a loss, same simplification
  // /echl/standings' own streak calc already uses.
  if (url.pathname === '/echl/prediction') {
    const limited = await checkAiRateLimit(env, request, 'echl-prediction');
    if (limited) return limited;

    const gameId = parseInt(url.searchParams.get('gameId') || '0', 10);
    if (!gameId) return new Response(JSON.stringify({ error: 'gameId required' }), { status: 400, headers: corsHeaders() });
    const forceRegen = url.searchParams.get('force') === '1';

    const kvKey = `echl:prediction:${gameId}`;
    if (!forceRegen) {
      const cached = await kvGet(env, kvKey);
      if (cached) return json(cached);
    }

    const gameRes = await fetch(
      `${SB_URL}/rest/v1/echl_game_log?game_id=eq.${gameId}&select=game_id,season_id,home_team_id,away_team_id`,
      { headers: sbH }
    );
    if (!gameRes.ok) return new Response(JSON.stringify({ error: `Supabase ${gameRes.status}` }), { status: 502, headers: corsHeaders() });
    const [game] = await gameRes.json();
    if (!game || !game.home_team_id || !game.away_team_id) {
      return new Response(JSON.stringify({ error: 'Game not found in echl_game_log' }), { status: 404, headers: corsHeaders() });
    }

    const seasonId = game.season_id;
    const homeId = game.home_team_id;
    const awayId = game.away_team_id;

    const seasonType = await resolveSeasonType(env, seasonId);
    const isPlayoff = seasonType === 'playoffs';

    const [teamsRes, logRes] = await Promise.all([
      fetch(`${SB_URL}/rest/v1/echl_team_seasons?team_id=in.(${homeId},${awayId})&season_id=eq.${seasonId}&season_type=eq.${seasonType}`, { headers: sbH }),
      fetch(`${SB_URL}/rest/v1/echl_game_log?season_id=eq.${seasonId}&game_state=eq.Final&order=game_id.desc&limit=500&select=game_id,home_team_id,away_team_id,home_score,away_score`, { headers: sbH }),
    ]);
    if (!teamsRes.ok) return new Response(JSON.stringify({ error: `Supabase ${teamsRes.status}` }), { status: 502, headers: corsHeaders() });
    const teamRows = await teamsRes.json();
    const games = logRes.ok ? await logRes.json() : [];

    const home = teamRows.find(t => t.team_id === homeId);
    const away = teamRows.find(t => t.team_id === awayId);
    if (!home || !away) {
      return new Response(JSON.stringify({ error: 'echl_team_seasons rows not found for both teams' }), { status: 404, headers: corsHeaders() });
    }

    // Streak -- every non-win counts as a plain loss, no OT/SO split (see
    // route comment above).
    const streakFor = (teamId) => {
      const results = games
        .filter(g => g.home_team_id === teamId || g.away_team_id === teamId)
        .map(g => {
          const isHomeG = g.home_team_id === teamId;
          const my = isHomeG ? g.home_score : g.away_score;
          const opp = isHomeG ? g.away_score : g.home_score;
          return my > opp ? 'W' : 'L';
        });
      let streak = 0, streakType = '';
      for (const res of results) {
        if (!streakType) { streakType = res; streak = 1; }
        else if (res === streakType) streak++;
        else break;
      }
      return streak ? `${streakType}${streak}` : 'unknown';
    };
    const homeStreak = streakFor(homeId);
    const awayStreak = streakFor(awayId);

    const h2hGames = games.filter(g =>
      (g.home_team_id === homeId && g.away_team_id === awayId) ||
      (g.home_team_id === awayId && g.away_team_id === homeId)
    );
    const h2hHomeWins = h2hGames.filter(g => {
      const homeWasHome = g.home_team_id === homeId;
      const myScore = homeWasHome ? g.home_score : g.away_score;
      const oppScore = homeWasHome ? g.away_score : g.home_score;
      return myScore > oppScore;
    }).length;
    const h2hRecord = h2hGames.length > 0
      ? `${h2hHomeWins}-${h2hGames.length - h2hHomeWins}`
      : 'no prior meetings';

    const homeAbbr = ECHL_TEAM_CODES[homeId] || `T${homeId}`;
    const awayAbbr = ECHL_TEAM_CODES[awayId] || `T${awayId}`;

    const hGp = home.gp || 1, aGp = away.gp || 1;
    const hGpg = (home.goals_for ?? 0) / hGp, aGpg = (away.goals_for ?? 0) / aGp;
    const hGag = (home.goals_against ?? 0) / hGp, aGag = (away.goals_against ?? 0) / aGp;
    const hPP = (home.pp_pct ?? 0) * 100, aPP = (away.pp_pct ?? 0) * 100;
    const hPK = (home.pk_pct ?? 0) * 100, aPK = (away.pk_pct ?? 0) * 100;

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const expHome = clamp(Math.sqrt(Math.max(hGpg, 0.5) * Math.max(aGag, 0.5)) + 0.12, 1.5, 5.0).toFixed(1);
    const expAway = clamp(Math.sqrt(Math.max(aGpg, 0.5) * Math.max(hGag, 0.5)) - 0.12, 1.5, 5.0).toFixed(1);

    // Win probability -- same additive heuristic as /ahl/prediction, minus
    // the Corsi term (no data source for it -- see route comment above).
    let homeScore = 0, awayScore = 0;
    if (!isPlayoff) {
      const ptsDiff = (home.points ?? 0) - (away.points ?? 0);
      homeScore += ptsDiff > 0 ? Math.min(ptsDiff / 20, 1) : 0;
      awayScore += ptsDiff < 0 ? Math.min(-ptsDiff / 20, 1) : 0;
    }
    if (hGpg > aGpg) homeScore += 0.6; else awayScore += 0.6;
    if (hGag < aGag) homeScore += 0.6; else awayScore += 0.6;
    if (hPP > aPP) homeScore += 0.4; else awayScore += 0.4;
    if (homeStreak.startsWith('W')) homeScore += 0.3;
    if (awayStreak.startsWith('W')) awayScore += 0.3;
    const totalScore = homeScore + awayScore || 1;
    const homeWinPct = Math.round((homeScore / totalScore) * 100);

    const prompt = `You are EyeWall Analytics, an ECHL hockey analytics assistant. Write a sharp, data-driven pre-game analysis. 2-3 sentences only. Be specific about the numbers. No filler. No "In this matchup" opener. Shot-attempt/possession data is not available for ECHL -- do not reference Corsi, possession, or shot-attempt share.

Game: ${homeAbbr} (HOME) vs ${awayAbbr} (AWAY)
Context: ${isPlayoff ? 'PLAYOFFS' : 'Regular Season'}

${homeAbbr} stats:
- Record: ${home.wins}-${home.losses}-${home.ot_losses}-${home.shootout_losses ?? 0} (${home.points} pts)
- GF/GA per game: ${hGpg.toFixed(2)} / ${hGag.toFixed(2)}
- PP%: ${hPP.toFixed(1)}% · PK%: ${hPK.toFixed(1)}%
- Current streak: ${homeStreak}

${awayAbbr} stats:
- Record: ${away.wins}-${away.losses}-${away.ot_losses}-${away.shootout_losses ?? 0} (${away.points} pts)
- GF/GA per game: ${aGpg.toFixed(2)} / ${aGag.toFixed(2)}
- PP%: ${aPP.toFixed(1)}% · PK%: ${aPK.toFixed(1)}%
- Current streak: ${awayStreak}

Head-to-head this season: ${homeAbbr} ${h2hRecord}
Expected score (Pythagorean): ${homeAbbr} ${expHome} - ${awayAbbr} ${expAway}
Model win probability: ${homeAbbr} ${homeWinPct}%${isPlayoff ? '\n\nNote: This is a playoff game. Ignore regular season points — focus on goaltending and recent form.' : ''}

Write the analysis now. Mention the single most decisive factor, one risk or concern, and a concrete expected-score range.`;

    let narrative = '';
    try {
      const aiResponse = await generateText(env, {
        messages: [{ role: 'user', content: prompt }],
      });
      narrative = aiResponse.response?.trim() || '';
    } catch (e) {
      console.error('ECHL prediction AI error:', e);
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
      generatedAt: new Date().toISOString(),
    };

    await kvPut(env, kvKey, result, 1800);
    return json(result);
  }

  // GET /echl/team-seasons/compare?teamId=8&seasons=73,76
  // One team across multiple seasons. Mirrors /ahl/team-seasons/compare
  // exactly -- echl_team_seasons already has this shape.
  if (url.pathname === '/echl/team-seasons/compare') {
    const teamId = parseInt(url.searchParams.get('teamId') || '0', 10);
    const seasons = (url.searchParams.get('seasons') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!teamId || seasons.length === 0) {
      return new Response(JSON.stringify({ error: 'teamId and seasons (comma-separated) are required' }), { status: 400, headers: corsHeaders() });
    }
    const kvKey = `echl:team-seasons:compare:${teamId}:${seasons.slice().sort().join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const res = await fetch(
      `${SB_URL}/rest/v1/echl_team_seasons?team_id=eq.${teamId}&season_id=in.(${seasons.join(',')})` +
      `&select=season_id,season_type,gp,wins,losses,ot_losses,shootout_losses,points,goals_for,goals_against,pp_pct,pk_pct`,
      { headers: sbH }
    );
    if (!res.ok) return new Response(JSON.stringify({ error: `Supabase ${res.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await res.json();

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // GET /echl/team-seasons/compare-teams?teamIds=8,99&season=73
  // Two-team, same-season comparison. Mirrors /ahl/team-seasons/compare-teams.
  if (url.pathname === '/echl/team-seasons/compare-teams') {
    const teamIds = (url.searchParams.get('teamIds') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
    const season = url.searchParams.get('season');
    if (teamIds.length !== 2 || teamIds.some(id => !id) || !season) {
      return new Response(JSON.stringify({ error: 'teamIds (exactly two, comma-separated) and season are required' }), { status: 400, headers: corsHeaders() });
    }

    const kvKey = `echl:team-seasons:compare-teams:${teamIds.slice().sort((a, b) => a - b).join(',')}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const res = await fetch(
      `${SB_URL}/rest/v1/echl_team_seasons?team_id=in.(${teamIds.join(',')})&season_id=eq.${season}` +
      `&select=team_id,season_id,season_type,gp,wins,losses,ot_losses,shootout_losses,points,goals_for,goals_against,pp_pct,pk_pct`,
      { headers: sbH }
    );
    if (!res.ok) return new Response(JSON.stringify({ error: `Supabase ${res.status}` }), { status: 502, headers: corsHeaders() });
    const rows = await res.json();

    await kvPut(env, kvKey, rows, 3600);
    return json(rows);
  }

  // GET /echl/team-seasons/head-to-head?teamIds=8,99
  // All-time head-to-head between two teams, across every season on record.
  // Mirrors /ahl/team-seasons/head-to-head exactly -- echl_game_log is the
  // same one-row-per-game-with-both-teams-in-columns shape, and
  // buildHeadToHeadPayload (shared.js) is fully sport-agnostic.
  if (url.pathname === '/echl/team-seasons/head-to-head') {
    const teamIds = (url.searchParams.get('teamIds') || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10));
    if (teamIds.length !== 2 || teamIds.some(id => !id)) {
      return new Response(JSON.stringify({ error: 'teamIds (exactly two, comma-separated) are required' }), { status: 400, headers: corsHeaders() });
    }
    const [teamA, teamB] = teamIds;

    const kvKey = `echl:team-seasons:head-to-head:${teamIds.slice().sort((a, b) => a - b).join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const res = await fetch(
      `${SB_URL}/rest/v1/echl_game_log?game_state=eq.Final` +
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

  // POST /echl/team-seasons/head-to-head/narrative
  // AI narrative layer on top of the head-to-head stats above. Mirrors
  // /ahl/team-seasons/head-to-head/narrative's prompt structure exactly
  // (hand-rolled per-league, not cross-imported) -- client posts the
  // payload it already fetched from /echl/team-seasons/head-to-head plus
  // display names (this Worker has no ECHL team-name map of its own --
  // echlConfig.js on the frontend does).
  if (url.pathname === '/echl/team-seasons/head-to-head/narrative' && request.method === 'POST') {
    const limited = await checkAiRateLimit(env, request, 'echl-h2h-narrative');
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

    const kvKey = `echl:h2h-narrative:${[teamA, teamB].slice().sort((a, b) => a - b).join(',')}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const aDisplay = teamADisplay || String(teamA);
    const bDisplay = teamBDisplay || String(teamB);
    const streakLine = currentStreak
      ? `Current streak: ${currentStreak.holder === 'A' ? aDisplay : bDisplay} has won ${currentStreak.count} straight.`
      : 'No active streak.';
    const thinSampleNote = isThinSample
      ? `\nIMPORTANT: Only ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'} exist between these teams. Do not describe this as a "trend," "rivalry," or "dominance" -- that's too small a sample to support it. It's fine to note the limited history plainly.`
      : '';

    const prompt = `You are Sticks, EyeWall's hockey analyst. Write a punchy 2-3 sentence head-to-head summary for ${aDisplay} vs ${bDisplay}.

All-time record (since 2025-26): ${aDisplay} ${allTimeRecord.teamAWins}-${allTimeRecord.teamBWins} ${bDisplay}, across ${totalMeetings} meeting${totalMeetings === 1 ? '' : 's'}.
Last ${recentWindow.size}: ${aDisplay} ${recentWindow.teamAWins}-${recentWindow.teamBWins} ${bDisplay}.
${streakLine}
${thinSampleNote}
Only reference the two teams named above and the numbers given -- no player names, no invented stats or games. Plain text only, no markdown, no bullet points.`;

    try {
      const aiResponse = await generateText(env, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
      });
      const narrative = (aiResponse.response || '').trim();
      if (!narrative) return json({ narrative: null });

      const result = { narrative };
      await kvPut(env, kvKey, result, 24 * 3600);
      return json(result);
    } catch (e) {
      console.error('[ECHL] head-to-head narrative AI error:', e);
      return new Response(JSON.stringify({ error: 'AI generation failed' }), { status: 502, headers: corsHeaders() });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders() });
}
