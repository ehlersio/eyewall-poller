// src/edge.js
// GET /nhl/edge/skater/:playerId/:season/:gameType
// GET /nhl/edge/goalie/:playerId/:season/:gameType
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
  const m = url.pathname.match(ROUTE);
  if (!m) return errorJson(400, { error: 'expected /nhl/edge/(skater|goalie)/:playerId/:season/:gameType (2 or 3)' });
  const [, kind, id, season, gt] = m;
  const playerId = Number(id);
  const gameType = Number(gt);
  const key = `nhl:edge:v2:${kind}:${playerId}:${season}:${gameType}`;

  const cached = await kvGet(env, key);
  if (cached) return cached.available ? json(cached) : errorJson(404, cached);

  const isPast = Number(season) < Number(await resolveNHLSeason(env));
  const ids = { kind, playerId, season, gameType };

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
  return json(body);
}
