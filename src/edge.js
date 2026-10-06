// src/edge.js
// GET /nhl/edge/skater/:playerId/:season/:gameType
// GET /nhl/edge/goalie/:playerId/:season/:gameType
// GET /nhl/edge/team/:teamId/:season/:gameType
// GET /nhl/edge/leaders/:season/:gameType   (see handleEdgeLeaders below)
//
// One player's NHL EDGE tracking stats (skating speed, distance, shot speed,
// zone time; for goalies, save rates the NHL computes from tracking), trimmed
// to what the app's player Analytics tab shows. Every metric carries the
// NHL's own league average and percentile -- nothing here is computed or
// defaulted. gameType is 2 (regular season) or 3 (playoffs); EDGE has no
// preseason, and starts in 2021-22.
//
// Response (200):
//   { available: true, kind, playerId, season, gameType, gamesPlayed,
//     metrics: { [name]: Metric | null },
//     areas (goalies only): { [area]: Area } | null }
// Metric, for a measured quantity (speed, distance), in both unit systems:
//   { imperial, metric, pct, avg: { imperial, metric } }
// and for a count or a rate:
//   { value, pct, avg }
// pct is the NHL's percentile as 0-100, avg its league average. A metric is
// null when the NHL's payload doesn't carry it.
//
// Teams (2026-10, the Team page's Advanced tab) get `teamId` instead of
// `playerId`, and each metric carries the NHL's rank among the 32 teams
// (1 = best: most offensive-zone time, LEAST defensive-zone time) instead
// of a percentile:
//   { imperial, metric, rank, avg: { imperial, metric } } | { value, rank, avg }
//
// `areas` (2026-10) is the goalie's record in each of the NHL's 17 shot
// areas (react-hockey-rink's SHOT_AREAS, keyed by the NHL's own names):
//   { shots, goals, savePctg, pct }
// pct being that save % 's percentile among NHL goalies (0-100). An area
// he faced no shots from comes back with shots 0 and savePctg/pct null.
//
// "No data" and "failed" are told apart, so the app knows whether asking
// again can help:
//   404 { available: false } -- the NHL answered 404: no EDGE data for this
//     player, season and game type (a pre-2021-22 season, a skater asked
//     for as a goalie, a player who hasn't played). Cached, so it's cheap.
//   502 { error } -- the NHL was unreachable or errored. Never cached; the
//     app retries.
//
// Cache: the current season's numbers move after every game -> 6 hours; a
// past season's are settled -> 30 days. A 404 for the current season can
// turn into data after the player's next game -> 1 hour; a past season's
// -> 7 days.

import { kvGet, kvPut, json, errorJson } from './shared.js';
import { resolveNHLSeason } from './seasons.js';

const EDGE_BASE = 'https://api-web.nhle.com/v1/edge';
export const TTL_CURRENT = 6 * 3600;
export const TTL_PAST = 30 * 24 * 3600;
export const TTL_NONE_CURRENT = 3600;
export const TTL_NONE_PAST = 7 * 24 * 3600;

const ROUTE = /^\/nhl\/edge\/(skater|goalie)\/(\d{7})\/(\d{8})\/([23])$/;
const TEAM_ROUTE = /^\/nhl\/edge\/(team)\/(\d{1,2})\/(\d{8})\/([23])$/;

class Missing extends Error {}

const pctOf = (p) => (typeof p === 'number' ? Math.round(p * 100) : null);
const num = (v) => (typeof v === 'number' ? v : null);

// { imperial, metric, percentile, leagueAvg: { imperial, metric } }
export function measured(o) {
  if (!o || typeof o.imperial !== 'number' || typeof o.metric !== 'number') return null;
  return {
    imperial: o.imperial,
    metric: o.metric,
    pct: pctOf(o.percentile),
    avg: o.leagueAvg ? { imperial: num(o.leagueAvg.imperial), metric: num(o.leagueAvg.metric) } : null,
  };
}

// { value, percentile, leagueAvg } -- leagueAvg is a number or { value }
export function counted(o) {
  if (!o || typeof o.value !== 'number') return null;
  const avg = typeof o.leagueAvg === 'number' ? o.leagueAvg : num(o.leagueAvg?.value);
  return { value: o.value, pct: pctOf(o.percentile), avg };
}

// A flat row's `<field>`, `<field>Percentile`, `<field>LeagueAvg`
function flat(row, field, pctField = `${field}Percentile`, avgField = `${field}LeagueAvg`) {
  if (!row || typeof row[field] !== 'number') return null;
  return { value: row[field], pct: pctOf(row[pctField]), avg: num(row[avgField]) };
}

const byCode = (rows, key, code) => (Array.isArray(rows) ? rows.find(r => r?.[key] === code) : null) || null;

export function skaterMetrics(detail, shotSpeed, distance) {
  const zone = detail?.zoneTimeDetails;
  const allDistance = byCode(distance?.skatingDistanceDetails, 'strengthCode', 'all');
  return {
    topSpeed: measured(detail?.skatingSpeed?.speedMax),
    burstsOver20: counted(detail?.skatingSpeed?.burstsOver20),
    distancePer60: measured(allDistance?.distancePer60),
    topShotSpeed: measured(detail?.topShotSpeed),
    avgShotSpeed: measured(shotSpeed?.shotSpeedDetails?.avgShotSpeed),
    highDangerShots: flat(byCode(detail?.sogSummary, 'locationCode', 'high'), 'shots'),
    offensiveZoneTimeEv: zone ? flat(zone, 'offensiveZoneEvPctg', 'offensiveZoneEvPercentile', 'offensiveZoneEvLeagueAvg') : null,
  };
}

// The NHL's per-area goalie rows -> { [area]: { shots, goals, savePctg, pct } }
export function goalieAreas(shotLocation) {
  const rows = shotLocation?.shotLocationDetails;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = {};
  for (const r of rows) {
    if (!r?.area) continue;
    out[r.area] = {
      shots: num(r.shotsAgainst) ?? 0,
      goals: num(r.goalsAgainst) ?? 0,
      savePctg: num(r.savePctg),
      pct: pctOf(r.savePctgPercentile),
    };
  }
  return out;
}

// Team metrics: the NHL's rank among the 32 teams in place of a percentile
const rankOf = (r) => (typeof r === 'number' ? r : null);

export function rankedMeasure(o) {
  if (!o || typeof o.imperial !== 'number' || typeof o.metric !== 'number') return null;
  return {
    imperial: o.imperial,
    metric: o.metric,
    rank: rankOf(o.rank),
    avg: o.leagueAvg ? { imperial: num(o.leagueAvg.imperial), metric: num(o.leagueAvg.metric) } : null,
  };
}

export function rankedCount(o) {
  if (!o || typeof o.value !== 'number') return null;
  const avg = typeof o.leagueAvg === 'number' ? o.leagueAvg : num(o.leagueAvg?.value);
  return { value: o.value, rank: rankOf(o.rank), avg };
}

function rankedFlat(row, field, rankField, avgField) {
  if (!row || typeof row[field] !== 'number') return null;
  return { value: row[field], rank: rankOf(row[rankField]), avg: num(row[avgField]) };
}

export function teamMetrics(detail) {
  const zone = detail?.zoneTimeDetails;
  const all = byCode(detail?.sogSummary, 'locationCode', 'all');
  const high = byCode(detail?.sogSummary, 'locationCode', 'high');
  return {
    offensiveZoneTime: rankedFlat(zone, 'offensiveZonePctg', 'offensiveZoneRank', 'offensiveZoneLeagueAvg'),
    offensiveZoneTimeEv: rankedFlat(zone, 'offensiveZoneEvPctg', 'offensiveZoneEvRank', 'offensiveZoneEvLeagueAvg'),
    defensiveZoneTime: rankedFlat(zone, 'defensiveZonePctg', 'defensiveZoneRank', 'defensiveZoneLeagueAvg'),
    shotsOnGoal: rankedFlat(all, 'shots', 'shotsRank', 'shotsLeagueAvg'),
    highDangerShots: rankedFlat(high, 'shots', 'shotsRank', 'shotsLeagueAvg'),
    highDangerShootingPctg: rankedFlat(high, 'shootingPctg', 'shootingPctgRank', 'shootingPctgLeagueAvg'),
    topSpeed: rankedMeasure(detail?.skatingSpeed?.speedMax),
    burstsOver20: rankedCount(detail?.skatingSpeed?.burstsOver20),
    burstsOver22: rankedCount(detail?.skatingSpeed?.burstsOver22),
    distanceTotal: rankedMeasure(detail?.distanceSkated?.total),
    topShotSpeed: rankedMeasure(detail?.shotSpeed?.topShotSpeed),
    shotAttemptsOver90: rankedCount(detail?.shotSpeed?.shotAttemptsOver90),
  };
}

export function goalieMetrics(detail, fiveOnFive) {
  const s = fiveOnFive?.savePctg5v5Details;
  return {
    gamesAbove900Pct: counted(detail?.stats?.gamesAbove900),
    savePctg5v5Close: counted(s?.savePctgClose),
    longRangeSavePctg: flat(byCode(detail?.shotLocationSummary, 'locationCode', 'long'), 'savePctg'),
  };
}

// 200 -> body, 404 -> Missing, anything else -> Error
async function edgeGet(path, { optional = false } = {}) {
  const res = await fetch(`${EDGE_BASE}/${path}`);
  if (res.status === 404) {
    if (optional) return null;
    throw new Missing(path);
  }
  if (!res.ok) throw new Error(`EDGE ${res.status}`);
  return res.json();
}

async function build(kind, playerId, season, gameType) {
  const tail = `${playerId}/${season}/${gameType}`;
  if (kind === 'team') {
    const detail = await edgeGet(`team-detail/${tail}`);
    return { gamesPlayed: num(detail?.team?.gamesPlayed), metrics: teamMetrics(detail) };
  }
  if (kind === 'skater') {
    const [detail, shotSpeed, distance] = await Promise.all([
      edgeGet(`skater-detail/${tail}`),
      edgeGet(`skater-shot-speed-detail/${tail}`, { optional: true }),
      edgeGet(`skater-skating-distance-detail/${tail}`, { optional: true }),
    ]);
    return { gamesPlayed: num(detail?.player?.gamesPlayed), metrics: skaterMetrics(detail, shotSpeed, distance) };
  }
  const [detail, fiveOnFive, shotLocation] = await Promise.all([
    edgeGet(`goalie-detail/${tail}`),
    edgeGet(`goalie-5v5-detail/${tail}`, { optional: true }),
    edgeGet(`goalie-shot-location-detail/${tail}`, { optional: true }),
  ]);
  return {
    gamesPlayed: num(detail?.player?.gamesPlayed),
    metrics: goalieMetrics(detail, fiveOnFive),
    areas: goalieAreas(shotLocation),
  };
}

export async function handleEdge(request, env, url) {
  if (url.pathname.startsWith('/nhl/edge/leaders/')) return handleEdgeLeaders(request, env, url);
  const m = url.pathname.match(ROUTE) || url.pathname.match(TEAM_ROUTE);
  if (!m) return errorJson(400, { error: 'expected /nhl/edge/(skater|goalie)/:playerId/:season/:gameType or /nhl/edge/team/:teamId/:season/:gameType (2 or 3)' });
  const [, kind, id, season, gt] = m;
  const playerId = Number(id);
  const gameType = Number(gt);
  const key = `nhl:edge:v2:${kind}:${playerId}:${season}:${gameType}`;

  const cached = await kvGet(env, key);
  if (cached) return cached.available ? json(cached, { maxAge: TTL_CURRENT }) : errorJson(404, cached);

  const isPast = Number(season) < Number(await resolveNHLSeason(env));
  const ids = kind === 'team'
    ? { kind, teamId: playerId, season, gameType }
    : { kind, playerId, season, gameType };

  let data;
  try {
    data = await build(kind, playerId, season, gameType);
  } catch (e) {
    if (e instanceof Missing) {
      const body = { available: false, ...ids };
      await kvPut(env, key, body, isPast ? TTL_NONE_PAST : TTL_NONE_CURRENT);
      return errorJson(404, body);
    }
    return errorJson(502, { error: e.message });
  }

  const body = { available: true, ...ids, ...data };
  await kvPut(env, key, body, isPast ? TTL_PAST : TTL_CURRENT);
  return json(body, { maxAge: isPast ? TTL_PAST : TTL_CURRENT });
}

// ── League leaders ────────────────────────────────────────────────
// GET /nhl/edge/leaders/:season/:gameType -- the NHL's own EDGE top 10s
// for the League view's leaders: fastest skating speed, hardest shot,
// distance skated (season total) and offensive-zone time (%), all
// positions. Each row:
//   { playerId, firstName, lastName, team, position, headshot, ...value }
// speed / shot / distance rows carry { imperial, metric }, offensive-zone
// rows { value }. Speed and shot rows also carry `moment`, when the NHL
// clocked it: { date, away, home, period, periodType, time }.
// The NHL's top-10 rows have no player id field; it's the number at the
// end of their `slug` ("beck-malenstyn-8479359").
// 404 { available: false } when none of the four has data; a category
// the NHL 404s on its own comes back as []. Cache as for players.

const LEADER_ROUTE = /^\/nhl\/edge\/leaders\/(\d{8})\/([23])$/;

const LEADER_LISTS = {
  speed: { path: 'skater-speed-top-10/all/max', field: 'maxSpeed', kind: 'measure', moment: true },
  shotSpeed: { path: 'skater-shot-speed-top-10/all/max', field: 'hardestShot', kind: 'measure', moment: true },
  distance: { path: 'skater-distance-top-10/all/all/total', field: 'distanceTotal', kind: 'measure', moment: false },
  offensiveZoneTime: { path: 'skater-zone-time-top-10/all/all/offensive', field: 'offensiveZoneTime', kind: 'share', moment: false },
};

export function playerIdFromSlug(slug) {
  const m = /-(\d{7})$/.exec(slug || '');
  return m ? Number(m[1]) : null;
}

function momentOf(o) {
  if (!o?.gameDate) return null;
  return {
    date: o.gameDate,
    away: o.awayTeam?.abbrev ?? null,
    home: o.homeTeam?.abbrev ?? null,
    period: num(o.periodDescriptor?.number),
    periodType: o.periodDescriptor?.periodType ?? null,
    time: o.timeInPeriod ?? null,
  };
}

export function leaderRow(entry, list) {
  const p = entry?.player;
  const v = entry?.[list.field];
  if (!p) return null;
  const row = {
    playerId: playerIdFromSlug(p.slug),
    firstName: p.firstName?.default ?? null,
    lastName: p.lastName?.default ?? null,
    team: p.team?.abbrev ?? null,
    position: p.position ?? null,
    headshot: p.headshot ?? null,
  };
  if (list.kind === 'share') {
    if (typeof v !== 'number') return null;
    return { ...row, value: v };
  }
  if (typeof v?.imperial !== 'number' || typeof v?.metric !== 'number') return null;
  return {
    ...row,
    imperial: v.imperial,
    metric: v.metric,
    ...(list.moment ? { moment: momentOf(v.overlay) } : {}),
  };
}

export async function handleEdgeLeaders(request, env, url) {
  const m = url.pathname.match(LEADER_ROUTE);
  if (!m) return errorJson(400, { error: 'expected /nhl/edge/leaders/:season/:gameType (2 or 3)' });
  const [, season, gt] = m;
  const gameType = Number(gt);
  const key = `nhl:edge:v2:leaders:${season}:${gameType}`;

  const cached = await kvGet(env, key);
  if (cached) return cached.available ? json(cached, { maxAge: TTL_CURRENT }) : errorJson(404, cached);

  const isPast = Number(season) < Number(await resolveNHLSeason(env));
  const ids = { kind: 'leaders', season, gameType };

  let lists;
  try {
    lists = await Promise.all(Object.values(LEADER_LISTS).map(l => edgeGet(`${l.path}/${season}/${gameType}`, { optional: true })));
  } catch (e) {
    return errorJson(502, { error: e.message });
  }

  const categories = {};
  Object.entries(LEADER_LISTS).forEach(([name, list], i) => {
    categories[name] = (Array.isArray(lists[i]) ? lists[i] : []).map(e => leaderRow(e, list)).filter(Boolean);
  });

  if (Object.values(categories).every(rows => rows.length === 0)) {
    const body = { available: false, ...ids };
    await kvPut(env, key, body, isPast ? TTL_NONE_PAST : TTL_NONE_CURRENT);
    return errorJson(404, body);
  }

  const body = { available: true, ...ids, categories };
  await kvPut(env, key, body, isPast ? TTL_PAST : TTL_CURRENT);
  return json(body, { maxAge: isPast ? TTL_PAST : TTL_CURRENT });
}
