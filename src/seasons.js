/**
 * seasons.js — EyeWall Analytics Worker
 *
 * Single source of truth for "what season is it right now" across both
 * leagues. Resolved live from the NHL and HockeyTech APIs, cached in KV,
 * with a hardcoded fallback seed and a manual KV override escape hatch.
 *
 * Consumed by:
 *   - GET /config/seasons            (frontend + Python pipeline read this)
 *   - GET /config/seasons/pwhl-types (Python pipeline only — id -> season_type
 *     map for arbitrary/historical season_ids, added Session 37 so pipeline
 *     modules stop silently guessing "regular" for an id they don't recognize)
 *   - nhl.js's per-team `season`     (currently hardcoded per-team, see note below)
 *   - pwhl.js's PWHL_SEASON          (currently a module const, see note below)
 *
 * NOTE ON SCOPE (2026-07): this module and the /config/seasons endpoint
 * are complete and self-contained. Wiring nhl.js's 32 hardcoded
 * TEAM_CONFIGS.season fields and pwhl.js's PWHL_SEASON/fallback literals
 * to actually READ from this is a separate follow-up — both of those are
 * consumed synchronously in many call sites (including at module-load
 * time for the poll() path), so swapping them to read an async KV value
 * needs to touch each call site deliberately rather than a blind
 * find-and-replace. Until that follow-up lands, this module resolves and
 * serves the correct value, but nhl.js/pwhl.js's *own* internal use of
 * season still needs its yearly manual flip as before.
 *
 * NHL BOUNDARY CASE — resolved 2026-09: resolveNHLSeason()'s original
 * gamesPlayed-based check only ever flips once real games have been
 * played, which is far too late for schedule/roster-facing UI (the
 * frontend's TEAM_CONFIG.season, used for the Schedule tab and rosters,
 * not just stats). nextSeasonHasImminentSchedule() covers that gap by
 * separately checking whether the season AFTER the gamesPlayed-accepted
 * one already has a published schedule with its first game (preseason
 * counts) within SCHEDULE_LOOKAHEAD_DAYS -- verified live 2026-09-11: with
 * no override set, this correctly resolves to 20262027 (CAR's real
 * preseason opener 9 days out) even though standings/now still only has
 * real 20252026 data. Still genuinely unverified: the transition all the
 * way through to gamesPlayed > 0 actually landing once real regular-
 * season games are played in late Sept/Oct, and the frontend's
 * _getTeamStats() prior-season-stats fallback behaving correctly through
 * that whole window (see eyewallanalytics's nhlApi.js) -- worth a
 * deliberate check-in once real games start.
 *
 * PWHL remains as it was -- resolvePWHLSeason() uses HockeyTech's own
 * season_type field (which already has a real "preseason" value) rather
 * than a games-played count, a different mechanism not touched here.
 *
 * If auto-detection ever misbehaves for either league, use the manual
 * override below rather than redeploying under time pressure:
 *
 *   wrangler kv key put --binding=CACHE "config:season:nhl:override" '"20262027"'
 *   wrangler kv key put --binding=CACHE "config:season:pwhl:override" \
 *     '{"seasonId":9,"seasonType":"regular","startYear":2026}'
 *
 * Delete the override key(s) once live resolution is confirmed correct
 * again — they take priority over everything else, including the cache.
 */

import { kvGet, kvPut, HT_BASE, HT_KEY, HT_HDR, unwrapJsonp } from './shared.js';

const NHL_BASE = 'https://api-web.nhle.com/v1';

// ── Fallback seeds ────────────────────────────────────────────
// Only used if live resolution fails AND no cached value exists AND no
// override is set — i.e. a total cold start with the outside world
// unreachable. Update these once more at the real October 2026 flip;
// if live resolution is working correctly, they should never need
// touching again after that.
const FALLBACK_NHL_SEASON = '20252026';
const FALLBACK_PWHL = { seasonId: 8, seasonType: 'regular', startYear: 2025 };
const FALLBACK_AHL = { seasonId: 90, seasonType: 'regular' };

const TTL_SECONDS = 6 * 3600; // re-check every 6 hours

// Reference team for the schedule look-ahead below — arbitrary. Every
// team's schedule for a given season is published at essentially the same
// time, so any one team is an equally good proxy for "has next season's
// schedule been published, and how far off is its first game." Not
// imported from nhl.js's own DEFAULT_TEAM_ABBR — that would create a
// circular import (nhl.js already imports resolveNHLSeason from this
// module), and this module is deliberately self-contained (see the
// NOTE ON SCOPE below).
const SCHEDULE_LOOKAHEAD_TEAM = 'CAR';
// Treat next season as current once its first scheduled game (preseason
// counts, not just regular season) is within this many days. Gives
// schedule/roster-facing UI a real head start instead of waiting for
// actual games to be played — see resolveNHLSeason's comment for why
// gamesPlayed alone is too late a signal for that use case.
const SCHEDULE_LOOKAHEAD_DAYS = 21;

// ── NHL ───────────────────────────────────────────────────────

// Does `seasonId` have a published schedule with its first game (any
// gameType, preseason included) within SCHEDULE_LOOKAHEAD_DAYS of today?
// Never throws — any failure (bad response, network error, no schedule
// published yet) resolves false, same "don't guess" posture as the rest
// of this module.
export async function nextSeasonHasImminentSchedule(seasonId) {
  try {
    const res = await fetch(`${NHL_BASE}/club-schedule-season/${SCHEDULE_LOOKAHEAD_TEAM}/${seasonId}`);
    if (!res.ok) return false;
    const data = await res.json();
    const games = data?.games || [];
    if (!games.length) return false;
    const firstDate = games.reduce(
      (min, g) => (g.gameDate && g.gameDate < min ? g.gameDate : min),
      games[0].gameDate
    );
    if (!firstDate) return false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + SCHEDULE_LOOKAHEAD_DAYS);
    return new Date(firstDate) <= cutoff;
  } catch {
    return false;
  }
}

export async function resolveNHLSeason(env) {
  const override = await kvGet(env, 'config:season:nhl:override');
  if (override) return override;

  const cached = await kvGet(env, 'config:season:nhl');
  if (cached) return cached.seasonId;

  try {
    const res = await fetch(`${NHL_BASE}/standings/now`);
    if (!res.ok) throw new Error(`standings/now ${res.status}`);
    const data = await res.json();
    const rows = data?.standings || [];
    const candidate = rows[0]?.seasonId;
    const gamesPlayed = rows.reduce((sum, r) => sum + (r.gamesPlayed || 0), 0);

    // gamesPlayed > 0 only ever flips once REAL games have been played —
    // correct for "does this season have real stats," but far too late
    // for schedule/roster-facing UI, which should show the new season
    // once its schedule exists and is imminent, not once it's underway.
    // The look-ahead below covers that gap: it always checks one season
    // past whatever gamesPlayed accepted (or the fallback, if it didn't),
    // since that's the only season that could plausibly be imminent.
    let resolved = null;
    if (candidate && gamesPlayed > 0) {
      resolved = String(candidate);
    } else {
      console.warn(
        `NHL season resolve: candidate=${candidate} totalGamesPlayed=${gamesPlayed} — ` +
        `no real data behind this candidate, checking look-ahead before falling back`
      );
    }

    const base = resolved || FALLBACK_NHL_SEASON;
    const nextCandidate = String(Number(base) + 10001);
    if (await nextSeasonHasImminentSchedule(nextCandidate)) {
      resolved = nextCandidate;
    }

    if (!resolved) {
      // No live candidate AND next season isn't imminent yet — same
      // "don't cache a guess, keep re-checking every request" posture as
      // before this change, so a genuine live transition isn't masked by
      // a stale cached fallback for up to TTL_SECONDS.
      console.warn(`NHL season resolve: using fallback ${FALLBACK_NHL_SEASON}`);
      return FALLBACK_NHL_SEASON;
    }

    await kvPut(
      env, 'config:season:nhl',
      { seasonId: resolved, resolvedAt: new Date().toISOString(), source: 'live' },
      TTL_SECONDS
    );
    return resolved;
  } catch (e) {
    console.warn(`NHL season resolve failed: ${e.message} — using fallback ${FALLBACK_NHL_SEASON}`);
    return FALLBACK_NHL_SEASON;
  }
}

// ── PWHL ──────────────────────────────────────────────────────
// Derives seasonId, seasonType ("regular"/"preseason"/"playoffs"), and
// startYear from bootstrap's seasons[] (name + start_date) — this is what
// lets the Python pipeline's SEASON_TYPE_MAP / SEASON_YEAR_MAP stop
// needing a new hand-added entry every time HockeyTech assigns a new
// season_id, at least for whichever season is currently "live".

// HockeyTech's three feeds don't punctuate season names consistently: the
// PWHL's 2026-27 season is "2026-27 Pre-Season" where every prior year was
// "Preseason", and the AHL/ECHL write "All-Star" and "All Star". Matching
// on letters alone makes these checks independent of hyphens, spaces and
// case -- before this, "Pre-Season" fell through to "regular", so from its
// start date the live path would have called the PWHL preseason the
// current regular season (the pipeline's SEASON_TYPE_MAP hardcodes id 10
// to sidestep exactly that; see pwhl_stats.py).
export function seasonNameKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z]/g, '');
}

export function deriveSeasonType(name) {
  const n = seasonNameKey(name);
  if (n.includes('playoff')) return 'playoffs';
  if (n.includes('preseason')) return 'preseason';
  if (n.includes('showcase')) return 'showcase';
  return 'regular';
}

export function deriveStartYear(startDate, name) {
  if (startDate) {
    const y = new Date(startDate).getFullYear();
    if (!isNaN(y)) return y;
  }
  // Fallback: pull a leading 4-digit year out of the name, e.g.
  // "2025-26 Regular Season" → 2025
  const m = (name || '').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : FALLBACK_PWHL.startYear;
}

// Shared bootstrap fetch, cached under its own KV key (`config:season:pwhl:bootstrap`,
// same 6hr TTL as everything else here). Both resolvePWHLSeason() (picks the
// single "current" season) and getAllPWHLSeasonTypes() (answers "what type is
// season N" for ANY id, current or historical) need HockeyTech's full
// seasons[] list — this fetches it once instead of twice for two questions
// that come from the same underlying response. Does NOT catch its own
// errors — callers decide what "bootstrap unavailable" means for them
// (resolvePWHLSeason falls back to FALLBACK_PWHL; getAllPWHLSeasonTypes
// returns null).
async function fetchPWHLBootstrap(env) {
  const cached = await kvGet(env, 'config:season:pwhl:bootstrap');
  if (cached) return cached;

  // feed=modulekit (used here previously) returns a 200 OK with a bogus
  // {"SiteKit":{...,"Undefined":"Undefined Tab bootstrap"}} shape and no
  // seasons/teams data at all — silently falling through to
  // FALLBACK_PWHL below every single time, which went undetected because
  // the fallback happened to look plausible. feed=statviewfeed, plus the
  // extra params below, is the real shape confirmed via a captured
  // browser DevTools request against thepwhl.com on 2026-07-05.
  // callback=angular.callbacks._0 deliberately omitted — that's Angular's
  // JSONP callback naming; unwrapJsonp() expects a plain (...)-wrapped
  // body, same as every other statviewfeed call elsewhere in this repo.
  const url =
    `${HT_BASE}?feed=statviewfeed&view=bootstrap&season=&game_id=&pageName=leadersExtended` +
    `&key=${HT_KEY}&client_code=pwhl&site_id=0&league_id=&league_code=&conference=-1&division=-1&lang=en`;
  const res = await fetch(url, { headers: HT_HDR });
  if (!res.ok) throw new Error(`bootstrap ${res.status}`);
  const data = unwrapJsonp(await res.text());

  const seasons = (data?.seasons || []).map(s => ({
    id: String(s.id),
    seasonType: deriveSeasonType(s.name),
    startYear: deriveStartYear(s.start_date, s.name),
    hide_in_standings: !!s.hide_in_standings,
    start_date: s.start_date,
  }));
  const parsed = {
    currentSeasonId: data?.current_season_id != null ? String(data.current_season_id) : null,
    seasons,
  };

  await kvPut(env, 'config:season:pwhl:bootstrap', parsed, TTL_SECONDS);
  return parsed;
}

export async function resolvePWHLSeason(env) {
  const override = await kvGet(env, 'config:season:pwhl:override');
  if (override) return override;

  const cached = await kvGet(env, 'config:season:pwhl');
  if (cached) return cached;

  try {
    const { currentSeasonId, seasons } = await fetchPWHLBootstrap(env);
    const currentSeason = seasons.find(s => s.id === currentSeasonId);

    // Reject bootstrap's "current" season if it's hidden from standings —
    // the observed 2026-07 case: current_season_id pointed at a
    // not-yet-started preseason with zero games.
    //
    // Falling back to "most recent non-hidden season of ANY type" seemed
    // right at first (matches what the site's own standings widget does),
    // but it's wrong for this app specifically: almost every endpoint in
    // pwhl.js hardcodes `season_type=eq.regular` on top of whatever
    // season_id it's given. Resolving to a playoffs-type season_id (e.g.
    // "9") makes those queries return nothing at all — not sparse data,
    // literally empty — for every team, including the two that actually
    // played in that postseason. Caught via real Cypress failures across
    // standings/players/team/shot-map views, 2026-07-06.
    //
    // So: prefer the most recent non-hidden REGULAR season specifically.
    // Only fall back to "most recent of any type" if no regular season
    // exists at all in the response (shouldn't happen in practice).
    let chosen = currentSeason;
    if (!chosen || chosen.hide_in_standings) {
      const nonHidden = seasons.filter(s => !s.hide_in_standings);
      const regularSeasons = nonHidden.filter(s => s.seasonType === 'regular');
      const pool = regularSeasons.length > 0 ? regularSeasons : nonHidden;
      chosen = pool.sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
    }

    if (!chosen) {
      console.warn('PWHL season resolve: no usable season in bootstrap — using fallback');
      return FALLBACK_PWHL;
    }

    const resolved = {
      seasonId: Number(chosen.id),
      seasonType: chosen.seasonType,
      startYear: chosen.startYear,
      resolvedAt: new Date().toISOString(),
      source: 'live',
    };

    await kvPut(env, 'config:season:pwhl', resolved, TTL_SECONDS);
    return resolved;
  } catch (e) {
    console.warn(`PWHL season resolve failed: ${e.message} — using fallback`);
    return FALLBACK_PWHL;
  }
}

// Answers "what type is season N" for ANY season_id HockeyTech's bootstrap
// knows about — current, historical, or a not-yet-hidden-toggled future
// one — unlike resolvePWHLSeason() which only ever returns a single
// "current" answer. Backs the Python pipeline's get_season_type(), which
// needs this to stop guessing "regular" for season_ids it doesn't
// recognize (Session 37 follow-up). Returns null (not a thrown error) on
// any failure — callers should treat null as "couldn't get real data
// right now," not as license to guess.
export async function getAllPWHLSeasonTypes(env) {
  try {
    const { seasons } = await fetchPWHLBootstrap(env);
    const map = {};
    for (const s of seasons) map[s.id] = s.seasonType;
    return map;
  } catch (e) {
    console.warn(`PWHL season-type map resolve failed: ${e.message}`);
    return null;
  }
}

// Full per-season metadata (id, type, startYear) for every non-hidden PWHL
// season HockeyTech's bootstrap knows about. Unlike getAllPWHLSeasonTypes()
// (id -> type only), this keeps startYear too — the season-comparison
// picker (Session 64) needs a real label ("2024-25"), not just
// "regular"/"playoffs". Shares fetchPWHLBootstrap's cache with
// resolvePWHLSeason()/getAllPWHLSeasonTypes() — still one HockeyTech call
// backing three questions. Returns null (not a thrown error) on failure,
// same convention as getAllPWHLSeasonTypes().
export async function getAllPWHLSeasons(env) {
  try {
    const { seasons } = await fetchPWHLBootstrap(env);
    return seasons
      .filter(s => !s.hide_in_standings)
      .map(s => ({ seasonId: Number(s.id), seasonType: s.seasonType, startYear: s.startYear }));
  } catch (e) {
    console.warn(`PWHL season list resolve failed: ${e.message}`);
    return null;
  }
}

// ── AHL ───────────────────────────────────────────────────────
// Different HockeyTech client (client_code=ahl, key=ccb91f29d6744675,
// site_id=3 -- see eyewall-pipeline's docs/hockeytech-ahl-api-notes.md)
// from PWHL's, and a different feed/view: `modulekit&view=seasons`, not
// `statviewfeed&view=bootstrap`. Confirmed live 2026-08-29: without a
// `callback=` param this feed returns bare JSON (no parens at all), which
// unwrapJsonp() already handles correctly (it only strips a leading `(`
// if present, otherwise passes the text through to JSON.parse
// unchanged) -- no separate unwrap needed for this feed vs PWHL's.
//
// AHL's `seasons` feed has no `hide_in_standings` flag the way PWHL's
// bootstrap does, so "is this candidate season real" is decided purely by
// `career === "1"` (skips All-Star Challenge entries) AND `start_date` not
// being in the future (skips an already-announced-but-not-started
// upcoming season) -- mirrors eyewall-pipeline's ahl_stats.py
// resolve_current_season() exactly, including its reasoning: a naive
// "max season_id with career=1" picked a season with zero games in
// testing (2026-27, starts October) instead of the actually-current one.
// Exported (2026-08-29) so ahl.js can call HockeyTech directly for routes
// beyond season resolution (e.g. /ahl/player/career) -- same constants,
// just no longer module-private.
export const AHL_HT_BASE = 'https://lscluster.hockeytech.com/feed/index.php';
export const AHL_HT_KEY = 'ccb91f29d6744675';
export const AHL_HT_HDR = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://theahl.com/' };

function ahlSeasonTypeFromName(name, playoff, career) {
  const n = seasonNameKey(name);
  if (playoff === '1' || n.includes('playoffs')) return 'playoffs';
  if (n.includes('preseason')) return 'preseason';
  if (n.includes('allstar')) return 'allstar';
  if (career === '1') return 'regular';
  return 'other';
}

async function fetchAHLSeasons(env) {
  const cached = await kvGet(env, 'config:season:ahl:seasons');
  if (cached) return cached;
  const url = `${AHL_HT_BASE}?feed=modulekit&view=seasons&key=${AHL_HT_KEY}&client_code=ahl&site_id=3&lang=en`;
  const res = await fetch(url, { headers: AHL_HT_HDR });
  if (!res.ok) throw new Error(`AHL seasons ${res.status}`);
  const data = unwrapJsonp(await res.text());
  const seasons = data?.SiteKit?.Seasons || [];
  await kvPut(env, 'config:season:ahl:seasons', seasons, TTL_SECONDS);
  return seasons;
}

export async function resolveAHLSeason(env) {
  const override = await kvGet(env, 'config:season:ahl:override');
  if (override) return override;

  const cached = await kvGet(env, 'config:season:ahl');
  if (cached) return cached;

  try {
    const seasons = await fetchAHLSeasons(env);
    const today = new Date().toISOString().slice(0, 10);
    const started = seasons.filter(s => s.career === '1' && (s.start_date || '9999') <= today);
    if (!started.length) {
      console.warn('AHL season resolve: no started career season in feed — using fallback');
      return FALLBACK_AHL;
    }
    const latest = started.reduce((a, b) => (Number(b.season_id) > Number(a.season_id) ? b : a));
    const resolved = {
      seasonId: Number(latest.season_id),
      seasonType: ahlSeasonTypeFromName(latest.season_name, latest.playoff, latest.career),
      resolvedAt: new Date().toISOString(),
      source: 'live',
    };
    await kvPut(env, 'config:season:ahl', resolved, TTL_SECONDS);
    return resolved;
  } catch (e) {
    console.warn(`AHL season resolve failed: ${e.message} — using fallback`);
    return FALLBACK_AHL;
  }
}

// AHL equivalent of getAllPWHLSeasonTypes() -- id -> seasonType for every
// season AHL's feed knows about (current + historical), for the same
// "don't guess regular for an unrecognized id" reasoning.
export async function getAllAHLSeasonTypes(env) {
  try {
    const seasons = await fetchAHLSeasons(env);
    const map = {};
    for (const s of seasons) map[String(s.season_id)] = ahlSeasonTypeFromName(s.season_name, s.playoff, s.career);
    return map;
  } catch (e) {
    console.warn(`AHL season-type map resolve failed: ${e.message}`);
    return null;
  }
}

// AHL equivalent of getAllPWHLSeasons() -- {seasonId, seasonType, startYear}
// for every season AHL's feed knows about. Added 2026-08-30: AHLTeamView.jsx
// has claimed since Phase 4 of the AHL/PWHL parity plan that
// "/config/seasons/comparison's AHL entry" exists, but it never actually
// did -- worker.js's route only ever built nhl/pwhl keys, so
// SeasonComparisonPicker's `data?.ahl?.seasons ?? []` was always empty and
// AHL's "Compare Seasons" mode inside TeamComparisonPopup has been showing
// its "no seasons available" empty state since that phase shipped. This
// (plus the matching worker.js block) fixes it for AHL and gives ECHL's own
// new Compare Seasons feature (parity plan Phase 4 equivalent) working
// season labels from day one, instead of reproducing the same gap a third
// time.
//
// Also served whole as GET /config/seasons/ahl-seasons, which
// eyewall-pipeline's hockeytech_stats.py reads for any season's type and
// its start/end dates (the game-log pull's date window) -- hence
// seasonName/startDate/endDate, which the comparison route doesn't use.
export async function getAllAHLSeasons(env) {
  try {
    const seasons = await fetchAHLSeasons(env);
    return seasons.map(s => ({
      seasonId: Number(s.season_id),
      seasonName: s.season_name || null,
      seasonType: ahlSeasonTypeFromName(s.season_name, s.playoff, s.career),
      startYear: deriveStartYear(s.start_date, s.season_name),
      startDate: s.start_date || null,
      endDate: s.end_date || null,
    }));
  } catch (e) {
    console.warn(`AHL season list resolve failed: ${e.message}`);
    return null;
  }
}

// ── ECHL ──────────────────────────────────────────────────────
// Same HockeyTech/LeagueStat vendor as AHL, different client
// (client_code=echl, key=2c2b89ea7345cae8, site_id=0, league_id=1 --
// see eyewall-pipeline's ECHL_BUILD_BRIEF.md/hockeytech-ahl-api-notes.md).
// Structurally identical to AHL's block above -- same modulekit/seasons
// feed shape, same career=1/start_date-not-future resolution logic,
// confirmed live 2026-08-30.
//
// One real operational difference from AHL (and PWHL/OHL/WHL/QMJHL):
// this key is NOT exposed on echl.com's own site -- it was rebuilt on
// Laravel/Livewire and renders stats server-side, so the usual
// "open the network tab" recovery path doesn't work here. This key was
// recovered from sportsdataverse-py's league registry
// (sportsdataverse/hockeytech/_leagues.py) and independently re-verified
// live against the real feed. If this key ever stops working, re-check
// that registry first -- a network-tab hunt on echl.com will not work,
// for the same reason it didn't during the original investigation.
export const ECHL_HT_BASE = 'https://lscluster.hockeytech.com/feed/index.php';
export const ECHL_HT_KEY = '2c2b89ea7345cae8';
export const ECHL_HT_HDR = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://echl.com/' };

const FALLBACK_ECHL = { seasonId: 73, seasonType: 'regular' };

function echlSeasonTypeFromName(name, playoff, career) {
  const n = seasonNameKey(name);
  if (playoff === '1' || n.includes('playoffs')) return 'playoffs';
  if (n.includes('preseason')) return 'preseason';
  if (n.includes('allstar')) return 'allstar';
  if (career === '1') return 'regular';
  return 'other';
}

async function fetchECHLSeasons(env) {
  const cached = await kvGet(env, 'config:season:echl:seasons');
  if (cached) return cached;
  const url = `${ECHL_HT_BASE}?feed=modulekit&view=seasons&key=${ECHL_HT_KEY}&client_code=echl&site_id=0&lang=en`;
  const res = await fetch(url, { headers: ECHL_HT_HDR });
  if (!res.ok) throw new Error(`ECHL seasons ${res.status}`);
  const data = unwrapJsonp(await res.text());
  const seasons = data?.SiteKit?.Seasons || [];
  await kvPut(env, 'config:season:echl:seasons', seasons, TTL_SECONDS);
  return seasons;
}

export async function resolveECHLSeason(env) {
  const override = await kvGet(env, 'config:season:echl:override');
  if (override) return override;

  const cached = await kvGet(env, 'config:season:echl');
  if (cached) return cached;

  try {
    const seasons = await fetchECHLSeasons(env);
    const today = new Date().toISOString().slice(0, 10);
    const started = seasons.filter(s => s.career === '1' && (s.start_date || '9999') <= today);
    if (!started.length) {
      console.warn('ECHL season resolve: no started career season in feed — using fallback');
      return FALLBACK_ECHL;
    }
    const latest = started.reduce((a, b) => (Number(b.season_id) > Number(a.season_id) ? b : a));
    const resolved = {
      seasonId: Number(latest.season_id),
      seasonType: echlSeasonTypeFromName(latest.season_name, latest.playoff, latest.career),
      resolvedAt: new Date().toISOString(),
      source: 'live',
    };
    await kvPut(env, 'config:season:echl', resolved, TTL_SECONDS);
    return resolved;
  } catch (e) {
    console.warn(`ECHL season resolve failed: ${e.message} — using fallback`);
    return FALLBACK_ECHL;
  }
}

// ECHL equivalent of getAllAHLSeasonTypes() -- id -> seasonType for every
// season ECHL's feed knows about (current + historical).
export async function getAllECHLSeasonTypes(env) {
  try {
    const seasons = await fetchECHLSeasons(env);
    const map = {};
    for (const s of seasons) map[String(s.season_id)] = echlSeasonTypeFromName(s.season_name, s.playoff, s.career);
    return map;
  } catch (e) {
    console.warn(`ECHL season-type map resolve failed: ${e.message}`);
    return null;
  }
}

// ECHL equivalent of getAllAHLSeasons() -- see that function's comment for
// why this exists (fixes a real, already-shipped gap in AHL's own
// /config/seasons/comparison entry, and gives ECHL's own Compare Seasons
// feature the same working season labels from day one).
// Also served whole as GET /config/seasons/echl-seasons (see getAllAHLSeasons()).
export async function getAllECHLSeasons(env) {
  try {
    const seasons = await fetchECHLSeasons(env);
    return seasons.map(s => ({
      seasonId: Number(s.season_id),
      seasonName: s.season_name || null,
      seasonType: echlSeasonTypeFromName(s.season_name, s.playoff, s.career),
      startYear: deriveStartYear(s.start_date, s.season_name),
      startDate: s.start_date || null,
      endDate: s.end_date || null,
    }));
  } catch (e) {
    console.warn(`ECHL season list resolve failed: ${e.message}`);
    return null;
  }
}

// ── Combined config endpoint ──────────────────────────────────

export async function getSeasonsConfig(env) {
  const [nhl, pwhl, ahl, echl] = await Promise.all([
    resolveNHLSeason(env),
    resolvePWHLSeason(env),
    resolveAHLSeason(env),
    resolveECHLSeason(env),
  ]);
  return { nhl: { seasonId: nhl }, pwhl, ahl, echl };
}

// Called from scheduled() (runs every ~60s). This does NOT force a
// network re-fetch on every tick — resolveNHLSeason/resolvePWHLSeason/
// resolveAHLSeason/resolveECHLSeason already check the KV cache first and
// only hit the network when the 6-hour TTL has actually lapsed. Calling
// them here just means the cache gets warmed automatically shortly after
// expiry, instead of on whatever unlucky user request happens to hit it
// first.
export async function refreshSeasonsCache(env) {
  await Promise.all([
    resolveNHLSeason(env),
    resolvePWHLSeason(env),
    resolveAHLSeason(env),
    resolveECHLSeason(env),
  ]);
}
