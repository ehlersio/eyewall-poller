/**
 * seasons.js — EyeWall Analytics Worker
 *
 * Single source of truth for "what season is it right now" across both
 * leagues. Resolved live from the NHL and HockeyTech APIs, cached in KV,
 * with a hardcoded fallback seed and a manual KV override escape hatch.
 *
 * Consumed by:
 *   - GET /config/seasons          (frontend + Python pipeline read this)
 *   - nhl.js's per-team `season`   (currently hardcoded per-team, see note below)
 *   - pwhl.js's PWHL_SEASON        (currently a module const, see note below)
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
 * IMPORTANT — UNTESTED BOUNDARY CASE: the "does this candidate season
 * actually have data" check below has only been validated against the
 * *offseason* case (no games in progress; standings/now and bootstrap
 * both fall back to the last season with real data). The behavior at the
 * real Sept/Oct 2026 season-start boundary — when a new season exists in
 * the schedule but has zero games played yet — has NOT been observed.
 * If auto-detection misbehaves at that boundary, use the manual override
 * below rather than redeploying under time pressure:
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

const TTL_SECONDS = 6 * 3600; // re-check every 6 hours

// ── NHL ───────────────────────────────────────────────────────

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

    if (!candidate || gamesPlayed === 0) {
      console.warn(
        `NHL season resolve: candidate=${candidate} totalGamesPlayed=${gamesPlayed} — ` +
        `no real data behind this candidate, using fallback ${FALLBACK_NHL_SEASON}`
      );
      return FALLBACK_NHL_SEASON;
    }

    const resolved = String(candidate);
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

function deriveSeasonType(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('playoff')) return 'playoffs';
  if (n.includes('preseason')) return 'preseason';
  if (n.includes('showcase')) return 'showcase';
  return 'regular';
}

function deriveStartYear(startDate, name) {
  if (startDate) {
    const y = new Date(startDate).getFullYear();
    if (!isNaN(y)) return y;
  }
  // Fallback: pull a leading 4-digit year out of the name, e.g.
  // "2025-26 Regular Season" → 2025
  const m = (name || '').match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : FALLBACK_PWHL.startYear;
}

export async function resolvePWHLSeason(env) {
  const override = await kvGet(env, 'config:season:pwhl:override');
  if (override) return override;

  const cached = await kvGet(env, 'config:season:pwhl');
  if (cached) return cached;

  try {
    const url =
      `${HT_BASE}?feed=modulekit&view=bootstrap&key=${HT_KEY}` +
      `&client_code=pwhl&lang=en&league_id=`;
    const res = await fetch(url, { headers: HT_HDR });
    if (!res.ok) throw new Error(`bootstrap ${res.status}`);
    const data = unwrapJsonp(await res.text());

    const seasons = data?.seasons || [];
    const currentId = data?.current_season_id;
    const currentSeason = seasons.find(s => String(s.id) === String(currentId));

    // Reject bootstrap's "current" season if it's hidden from standings —
    // the observed 2026-07 case: current_season_id pointed at a
    // not-yet-started preseason with zero games. Fall back to the most
    // recent non-hidden season by start_date instead, same "most recent
    // season with real data" rule the site's own widgets already follow.
    let chosen = currentSeason;
    if (!chosen || chosen.hide_in_standings) {
      const candidates = seasons
        .filter(s => !s.hide_in_standings)
        .sort((a, b) => new Date(b.start_date) - new Date(a.start_date));
      chosen = candidates[0];
    }

    if (!chosen) {
      console.warn('PWHL season resolve: no usable season in bootstrap — using fallback');
      return FALLBACK_PWHL;
    }

    const resolved = {
      seasonId: Number(chosen.id),
      seasonType: deriveSeasonType(chosen.name),
      startYear: deriveStartYear(chosen.start_date, chosen.name),
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

// ── Combined config endpoint ──────────────────────────────────

export async function getSeasonsConfig(env) {
  const [nhl, pwhl] = await Promise.all([
    resolveNHLSeason(env),
    resolvePWHLSeason(env),
  ]);
  return { nhl: { seasonId: nhl }, pwhl };
}

// Called from scheduled() (runs every ~60s). This does NOT force a
// network re-fetch on every tick — resolveNHLSeason/resolvePWHLSeason
// already check the KV cache first and only hit the network when the
// 6-hour TTL has actually lapsed. Calling them here just means the cache
// gets warmed automatically shortly after expiry, instead of on whatever
// unlucky user request happens to hit it first.
export async function refreshSeasonsCache(env) {
  await Promise.all([resolveNHLSeason(env), resolvePWHLSeason(env)]);
}
