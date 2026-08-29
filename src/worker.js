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

import { handleNHL, poll, refreshPPUnits, TEAM_CONFIGS, fetchNews } from './nhl.js';
import { handlePWHL, pollPWHL, PWHL_TEAM_CODES, fetchPWHLNews } from './pwhl.js';
import { handleAHL } from './ahl.js';
import { corsHeaders, json, kvGet, kvPut, sbError, badRequest, sbHeaders, SB_URL, SB_ANON } from './shared.js';
import { getSeasonsConfig, refreshSeasonsCache, getAllPWHLSeasonTypes, getAllPWHLSeasons, resolveNHLSeason, resolvePWHLSeason } from './seasons.js';

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

  // Season-by-season "is this comparable yet" signal for the
  // season-over-season comparison feature (Session 64). Distinct from
  // /config/seasons (current season only) — this enumerates every season
  // that actually has team_seasons/pwhl_team_seasons rows, with a
  // per-season team count and a comparable flag. "Comparable" means
  // strictly more than half of the league's current active team count has
  // a row for that season — catches an in-progress/partial season (e.g.
  // PWHL mid-playoffs, or a freshly flipped NHL season before the pipeline
  // has caught every team) without hiding a season that's just naturally
  // missing a couple of laggard teams. Deliberately strict > not >=: a
  // season sitting at exactly half (PWHL season 9's 4-of-12 today) is the
  // case this flag exists to catch, not to wave through.
  //
  // Active team count is read live from TEAM_CONFIGS/PWHL_TEAM_CODES — the
  // same maps every other roster-aware route in this Worker already uses —
  // never hardcoded, since PWHL's 2026-27 expansion changes that number
  // (12 today, was 8 before DET/HAM/LV/SJS were wired in).
  //
  // This season-level flag is independent of the per-team "does THIS team
  // have a row" check the frontend still needs — a comparable season can
  // still be missing one specific team's row. Two separate signals, not
  // one collapsed into the other.
  if (url.pathname === '/config/seasons/comparison') {
    const kvKey  = 'config:seasons:comparison';
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const sbH = { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
    const nhlActiveTeamCount  = Object.keys(TEAM_CONFIGS).length;
    const pwhlActiveTeamCount = Object.keys(PWHL_TEAM_CODES).length;

    let nhlSeasons = [];
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/team_seasons?select=season,team&game_type=eq.2&limit=1000`,
        { headers: sbH }
      );
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      const rows = await r.json();
      const bySeason = new Map();
      for (const row of rows) {
        if (!bySeason.has(row.season)) bySeason.set(row.season, new Set());
        bySeason.get(row.season).add(row.team);
      }
      nhlSeasons = [...bySeason.entries()]
        .map(([season, teams]) => ({
          season,
          teamCount: teams.size,
          comparable: teams.size > nhlActiveTeamCount / 2,
        }))
        .sort((a, b) => b.season - a.season); // season is a Supabase bigint (number), not a string
    } catch (e) {
      console.warn(`NHL comparison-seasons query failed: ${e.message}`);
    }

    let pwhlSeasons = [];
    try {
      const [r, meta] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/pwhl_team_seasons?select=season_id,team_id&limit=2000`, { headers: sbH }),
        getAllPWHLSeasons(env),
      ]);
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      const rows = await r.json();
      const metaById = new Map((meta || []).map(m => [m.seasonId, m]));
      const bySeason = new Map();
      for (const row of rows) {
        if (!bySeason.has(row.season_id)) bySeason.set(row.season_id, new Set());
        bySeason.get(row.season_id).add(row.team_id);
      }
      pwhlSeasons = [...bySeason.entries()]
        .map(([seasonId, teams]) => ({
          seasonId,
          seasonType: metaById.get(seasonId)?.seasonType ?? null,
          startYear:  metaById.get(seasonId)?.startYear ?? null,
          teamCount:  teams.size,
          comparable: teams.size > pwhlActiveTeamCount / 2,
        }))
        .sort((a, b) => b.seasonId - a.seasonId);
    } catch (e) {
      console.warn(`PWHL comparison-seasons query failed: ${e.message}`);
    }

    const result = {
      nhl:  { activeTeamCount: nhlActiveTeamCount,  seasons: nhlSeasons },
      pwhl: { activeTeamCount: pwhlActiveTeamCount, seasons: pwhlSeasons },
    };
    await kvPut(env, kvKey, result, 3600); // 1hr — matches /team-seasons' own cache TTL
    return json(result);
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
  //
  // Live season vs. schedule-released season (Session 66): the live NHL
  // season can be flipped intentionally (e.g. once the new season's
  // schedule is published, well before any games are played) while
  // `player_seasons` for it stays genuinely empty until real games start
  // generating rows in October. Zero rows for the live season is that gap,
  // not an error — same shape TeamComparisonPopup.jsx's `isPending` already
  // handles for team comparisons ("never trust the live-current season's
  // own data, assume pending"). Here the useful equivalent is one season
  // back: last season's team assignment is the best available signal until
  // the new season's data exists, so it's used as an explicit, flagged
  // fallback (`teamStale: true`) rather than surfacing `team: null` for
  // literally every NHL player. Flagged, not silent, because it can be
  // wrong in one specific way this fallback can't detect: a player who
  // changed teams over the summer (free agency/trade) shows their OLD team
  // until the new season's real rows land — the frontend must not present
  // a stale team the same way as a confirmed-current one.
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

    async function fetchTeamByPlayer(season) {
      const res = await fetch(
        `${SB_URL}/rest/v1/player_seasons?season=eq.${season}&game_type=eq.2&select=player_id,team,updated_at&order=updated_at.desc`,
        { headers: sbH }
      );
      const rows = res.ok ? await res.json() : [];
      const byPlayer = {};
      for (const row of rows) {
        if (!(row.player_id in byPlayer)) byPlayer[row.player_id] = row.team; // first hit = most recently updated
      }
      return byPlayer;
    }

    const teamByPlayer = await fetchTeamByPlayer(nhlSeason);

    // Only reached when the live season has zero player_seasons rows at all
    // (season flipped ahead of real games existing, per the note above) —
    // if the live season has real data, per-player misses are a separate,
    // rarer thing (e.g. a brand-new call-up) that this fallback intentionally
    // does not paper over, same as before this change.
    let priorTeamByPlayer = {};
    let priorSeason = null;
    if (Object.keys(teamByPlayer).length === 0) {
      priorSeason = String(Number(nhlSeason) - 10001); // 20262027 -> 20252026
      priorTeamByPlayer = await fetchTeamByPlayer(priorSeason);
    }

    const nhlIndex = nhlPlayers.map(p => {
      const liveTeam = teamByPlayer[p.id];
      if (liveTeam) return { id: p.id, name: p.name, team: liveTeam, position: p.position, sport: 'nhl' };
      const priorTeam = priorTeamByPlayer[p.id];
      if (priorTeam) {
        // Rookie/expansion players correctly have no prior-season row
        // either — falls through to team: null below, same as a player
        // with no data at all (not a second, different empty state).
        return { id: p.id, name: p.name, team: priorTeam, teamStale: true, teamSeason: priorSeason, position: p.position, sport: 'nhl' };
      }
      return { id: p.id, name: p.name, team: null, position: p.position, sport: 'nhl' };
    });

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

  // GET /trivia/today?sport=nhl&team=CAR (team optional — omit for the
  // easy/hard tiers only, pass it to also get that team's medium-tier
  // question). Phase 2 (daily trivia). One request returns all three tiers
  // at once since the frontend always renders all three cards together —
  // three small Supabase reads inside one Worker round-trip rather than
  // three separate frontend fetches.
  //
  // trivia_questions has no owner/RLS-per-user concern (anon-readable,
  // same posture as /milestones' table) — the correct_index/explanation
  // are included in this response rather than split into a second
  // post-answer endpoint. A user could open devtools and see the answer
  // early; accepted for a low-stakes trivia feature, not worth the extra
  // round-trip/complexity of a server-tracked reveal step.
  if (url.pathname === '/trivia/today') {
    const sport = url.searchParams.get('sport')?.toLowerCase();
    if (!sport || !['nhl', 'pwhl'].includes(sport)) {
      return badRequest('sport must be nhl or pwhl');
    }
    const team = url.searchParams.get('team')?.toUpperCase() || null;
    // French/English localization, Track B Phase B2. Applied uniformly to
    // all three tiers including hard, even though hard is hand-curated
    // with no admin UI and every existing hard row defaults to locale='en'
    // (Track B Phase B0's schema default) -- there is no French hard-tier
    // content yet. A French request's hard tier will legitimately come back
    // empty until Matt adds French hard rows by hand; that's the same
    // "not published yet" empty state this route already falls back to for
    // other gaps, not a bug in this filter.
    const locale = url.searchParams.get('locale') === 'fr' ? 'fr' : 'en';

    const today  = new Date().toISOString().slice(0, 10);
    const kvKey  = `trivia:${today}:${sport}:${team || 'ALL'}:${locale}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    // fallback=true swaps the exact-date match for "most recent row on or
    // before today" — used for the hard tier only. Easy/medium are
    // AI-generated fresh every night for both leagues, so an exact-date
    // miss there means "not published yet" and should show the empty
    // state. Hard is hand-curated with no admin UI (see
    // trivia_questions.py's docstring) — Matt adds rows in batches, not
    // nightly, so an exact-date match would go silent on every day between
    // batches. Falling back to the latest past row means the tier only
    // goes empty if literally zero hard rows exist yet for that sport, not
    // every day content hasn't been added since the last batch.
    async function fetchTier(tier, teamFilter, { fallback = false } = {}) {
      const dateFilter = fallback
        ? `question_date=lte.${today}&order=question_date.desc`
        : `question_date=eq.${today}`;
      const filter = `?${dateFilter}&tier=eq.${tier}&sport=eq.${sport}&team=eq.${teamFilter}&locale=eq.${locale}&limit=1`;
      const r = await fetch(`${SB_URL}/rest/v1/trivia_questions${filter}`, { headers: sbHeaders() });
      if (!r.ok) return null;
      const rows = await r.json();
      return rows[0] || null;
    }

    const [easy, medium, hard] = await Promise.all([
      fetchTier('easy', 'ALL'),
      team ? fetchTier('medium', team) : Promise.resolve(null),
      fetchTier('hard', 'ALL', { fallback: true }),
    ]);

    const result = { easy, medium, hard };
    // Short TTL when nothing (or only some tiers) came back — don't pin an
    // incomplete pre-publish snapshot in KV for a full day (same guard
    // /draft/picks uses for its own "has the nightly pipeline actually
    // finished publishing yet" gap).
    const ttl = (easy || medium || hard) ? 24 * 3600 : 60;
    await kvPut(env, kvKey, result, ttl);
    return json(result);
  }

  // GET /news/latest?sport=nhl&team=CAR | ?sport=pwhl — cheap "is there
  // anything new" check for the News tab's read-state badge (Session 92).
  // Deliberately reuses the exact KV entry /news and /pwhl/news already
  // populate (news:${team} / pwhl:news) instead of a second parallel
  // fetch — if that cache is warm, this is a pure KV read, no Supabase/RSS
  // call at all. If cold, triggers the same background warm those routes
  // use and returns null for now (identical "empty now, real data next
  // request" shape as /news itself) rather than duplicating fetch logic.
  if (url.pathname === '/news/latest') {
    const sport = url.searchParams.get('sport')?.toLowerCase();
    if (!sport || !['nhl', 'pwhl'].includes(sport)) {
      return badRequest('sport must be nhl or pwhl');
    }

    if (sport === 'pwhl') {
      const cached = await kvGet(env, 'pwhl:news');
      if (!cached) {
        ctx.waitUntil(fetchPWHLNews(env).catch(e => console.warn('PWHL news bg fetch:', e.message)));
        return json({ latestId: null, publishedAt: null });
      }
      const latest = cached[0] || null;
      return json({ latestId: latest?.link || latest?.title || null, publishedAt: latest?.publishedAt || null });
    }

    const team = url.searchParams.get('team')?.toUpperCase();
    if (!team) return badRequest('team is required for sport=nhl');
    const cached = await kvGet(env, `news:${team}`);
    if (!cached) {
      ctx.waitUntil(fetchNews(env, team).catch(e => console.warn(`News bg fetch ${team}:`, e.message)));
      return json({ latestId: null, publishedAt: null });
    }
    const latest = cached[0] || null;
    return json({ latestId: latest?.link || latest?.title || null, publishedAt: latest?.publishedAt || null });
  }

  // GET /milestones/latest?sport=nhl|pwhl — same badge purpose as
  // /news/latest, but milestones has no existing "all teams, unfiltered"
  // KV entry to reuse (the real /milestones route's KV key always
  // includes team+limit), so this does its own minimal limit=1 query
  // instead. milestones.game_date is a date, not a timestamp — day
  // granularity is what's available (no insertion timestamp on this
  // table), accepted as good enough for a boolean "seen/unseen" badge.
  //
  // Season-scoped, matching /milestones' own filter (added same session) —
  // otherwise this could flag "unseen milestone!" for an id that no
  // longer appears anywhere in the now-season-scoped list, which would
  // be a strictly worse experience than no badge at all.
  if (url.pathname === '/milestones/latest') {
    const sport = url.searchParams.get('sport')?.toLowerCase();
    if (!sport || !['nhl', 'pwhl'].includes(sport)) {
      return badRequest('sport must be nhl or pwhl');
    }
    const isPwhl = sport === 'pwhl';
    const season = isPwhl ? (await resolvePWHLSeason(env)).seasonId : await resolveNHLSeason(env);
    const kvKey  = `milestones:latest:${sport}:${season}`;
    const cached = await kvGet(env, kvKey);
    if (cached) return json(cached);

    const r = await fetch(
      `${SB_URL}/rest/v1/milestones?select=id,game_date&order=game_date.desc,id.desc&limit=1&is_pwhl=eq.${isPwhl}&season=eq.${season}`,
      { headers: sbHeaders() }
    );
    if (!r.ok) return sbError(r.status);
    const rows = await r.json();
    const result = { latestId: rows[0]?.id ?? null, gameDate: rows[0]?.game_date ?? null };
    await kvPut(env, kvKey, result, 3600); // 1hr — matches /milestones' own TTL
    return json(result);
  }

  // Route PWHL endpoints
  if (url.pathname.startsWith('/pwhl/')) {
    return handlePWHL(request, env, ctx, url);
  }

  // Route AHL endpoints
  if (url.pathname.startsWith('/ahl/')) {
    return handleAHL(request, env, ctx, url);
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
