/**
 * worker.js — EyeWall Analytics Worker
 *
 * Thin router. Delegates to nhl.js and pwhl.js.
 * Entry points: scheduled (cron poll) and fetch (HTTP).
 *
 * Environment variables (set in Cloudflare Worker dashboard or wrangler.toml secrets):
 *   POLL_SECRET       — protects /poll manual trigger
 *   VAPID_PUBLIC_KEY  — Web Push VAPID public key
 *   VAPID_PRIVATE_KEY — Web Push VAPID private key
 *   VAPID_SUBJECT     — mailto: or https: identifier
 *   NHL_SEASON        — e.g. "20252026" (legacy manual flip — nhl.js/pwhl.js
 *                        internals still read their own hardcoded season
 *                        until the follow-up described in seasons.js lands;
 *                        GET /config/seasons is the live-resolved value)
 *
 * KV namespace binding: CACHE
 */

import { handleNHL, poll, refreshPPUnits } from './nhl.js';
import { handlePWHL, pollPWHL, PWHL_TEAM_CODES } from './pwhl.js';
import { corsHeaders, json, kvGet, kvPut, sbError, SB_URL, SB_ANON } from './shared.js';
import { getSeasonsConfig, refreshSeasonsCache, getAllPWHLSeasonTypes, resolveNHLSeason } from './seasons.js';

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Live-resolved current season for both leagues. Frontend and the
  // Python pipeline both read this instead of a hardcoded constant.
  // See seasons.js for resolution + fallback logic.
  if (url.pathname === '/config/seasons') {
    const config = await getSeasonsConfig(env);
    return json(config);
  }

  // id -> season_type map for every PWHL season HockeyTech's bootstrap
  // knows about (current AND historical) — Python-pipeline-only, so
  // pwhl_pbp_events.py/pwhl_stats.py/pwhl_shot_events.py/pwhl_milestones.py
  // can look up an arbitrary season_id's real type instead of guessing
  // "regular" for one they don't recognize. See seasons.js's
  // getAllPWHLSeasonTypes() for the shared-fetch mechanism.
  if (url.pathname === '/config/seasons/pwhl-types') {
    const types = await getAllPWHLSeasonTypes(env);
    if (!types) {
      return new Response(
        JSON.stringify({ error: 'PWHL season types unavailable' }),
        { status: 502, headers: corsHeaders() }
      );
    }
    return json(types);
  }

  // Flat NHL+PWHL player list for the global player-search autocomplete —
  // {id, name, team, position, sport} per player. NHL's `players` table has
  // no team column; team comes from the most-recently-updated
  // player_seasons row for the live season at game_type 2 (regular season).
  // A trade produces >1 player_seasons row per season (one per team stint,
  // conflict key is player_id,season,team,game_type) but the pipeline only
  // keeps refreshing the current team's row on each run, so "most recently
  // updated" is the reliable signal for "current team" — the pre-trade row
  // goes stale. 6hr KV TTL matches /players-list's.
  if (url.pathname === '/players-search-index') {
    const kvKey  = 'players-search-index';
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };

    // NHL players — paginated the same way /players-list is (Supabase caps
    // responses at 1000 rows; the table has 1300+).
    const nhlPlayers = [];
    let offset = 0;
    while (true) {
      const r = await fetch(`${SB_URL}/rest/v1/players?select=id,name,position`, {
        headers: { ...sbH, 'Range-Unit': 'items', 'Range': `${offset}-${offset + 999}` },
      });
      if (!r.ok) return sbError(r.status);
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      nhlPlayers.push(...rows);
      if (rows.length < 1000) break;
      offset += 1000;
    }

    const nhlSeason = String(await resolveNHLSeason(env));
    const teamRes = await fetch(
      `${SB_URL}/rest/v1/player_seasons?season=eq.${nhlSeason}&game_type=eq.2&select=player_id,team,updated_at&order=updated_at.desc`,
      { headers: sbH }
    );
    const teamRows = teamRes.ok ? await teamRes.json() : [];
    const teamByPlayer = {};
    for (const row of teamRows) {
      if (!(row.player_id in teamByPlayer)) teamByPlayer[row.player_id] = row.team; // first hit = most recently updated
    }

    const nhlIndex = nhlPlayers.map(p => ({
      id: p.id, name: p.name, team: teamByPlayer[p.id] || null, position: p.position, sport: 'nhl',
    }));

    // PWHL players — pwhl_players has no season dimension (one row per
    // player, reflecting current team assignment only).
    const pwhlRes = await fetch(
      `${SB_URL}/rest/v1/pwhl_players?select=player_id,first_name,last_name,position,team_id&limit=500`,
      { headers: sbH }
    );
    if (!pwhlRes.ok) return sbError(pwhlRes.status);
    const pwhlRows = await pwhlRes.json();
    const pwhlIndex = pwhlRows
      .filter(p => p.first_name || p.last_name)
      .map(p => ({
        id: p.player_id,
        name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        team: PWHL_TEAM_CODES[p.team_id] || null,
        position: p.position,
        sport: 'pwhl',
      }));

    const index = [...nhlIndex, ...pwhlIndex];
    await kvPut(env, kvKey, index, 21600); // 6hr
    return json(index);
  }

  // Route PWHL endpoints
  if (url.pathname.startsWith('/pwhl/')) {
    return handlePWHL(request, env, ctx, url);
  }

  // Route everything else to NHL handler
  return handleNHL(request, env, ctx, url);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      poll(env, ctx),
      pollPWHL(env).catch(e => console.error('PWHL poll error:', e.message)),
      refreshPPUnits(env)
        .then(map => console.log(`PP units scheduled: ${Object.keys(map).length} teams`))
        .catch(e => console.error('PP units scheduled error:', e.message)),
      refreshSeasonsCache(env)
        .catch(e => console.error('Season cache refresh error:', e.message)),
    ]));
  },
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
