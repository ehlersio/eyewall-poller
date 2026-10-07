/**
 * leagueOddsRankings.js — EyeWall Analytics Worker
 *
 * Read routes over two nightly pipeline outputs, for the three HockeyTech
 * leagues (PWHL, AHL, ECHL), contracts C10 and C12:
 *
 *   GET /{league}/playoff-odds?teamId=[&season=]
 *     eyewall-pipeline's hockeytech_playoff_odds.py: a Monte Carlo over the
 *     rest of the regular season from Elo win probabilities, one row per
 *     team per nightly run in {league}_playoff_odds (every run kept).
 *     -> { latest: {row}, history: [{ run_date, make_playoffs_pct,
 *          proj_points_p50 }] (that season, oldest first), stale }
 *     `stale`: the latest run is more than 48 h old (run_date anchored at
 *     noon UTC, as nhl.js /playoff-odds does), i.e. the nightly has missed
 *     two runs or the regular season is over. `make_playoffs_pct` and
 *     `win_division_pct` may be null (a format the pipeline couldn't
 *     verify); they're passed through, never filled in.
 *
 *   GET /{league}/power-rankings[?teamId=&limit=&season=&locale=fr]
 *     hockeytech_power_rankings.py: {league}_power_rankings (one row per
 *     team per run) and {league}_power_rankings_narratives (EyeWall AI text
 *     per team per run, en and fr).
 *     -> { latest: [{ team_id, rank, prior_rank, score, components }] (the
 *          most recent run, by rank, at most `limit`), narrative: { text,
 *          run_date } | null (the team's narrative from that same run, in
 *          `locale`), history: [{ run_date, rank }] (the team's last 28
 *          runs that season, oldest first) }
 *     Without teamId, narrative is null and history [].
 *
 * Without `season`, both read the season of the most recent run -- no
 * season resolution, since rows only exist once the pipeline has run.
 *
 * Both tables come from owner-run migrations and may not exist yet, so
 * neither route ever answers 5xx: a missing table (sbRowsIfTable -> null)
 * or no rows is the empty shape, and any other failed read is the empty
 * shape plus `unavailable: true`. Neither is cached, so the first nightly
 * run shows up at once; a real answer is cached an hour in KV.
 */

import { badRequest, cachedJson, json, sbParam, sbRowsIfTable, SB_URL, requestLocale, localeKeySuffix } from './shared.js';

export const ODDS_RANKINGS_LEAGUES = ['pwhl', 'ahl', 'echl'];
const ROUTE = /^\/(pwhl|ahl|echl)\/(playoff-odds|power-rankings)$/;

const TTL = 3600;
const ODDS_HISTORY_MAX = 250;  // more than a regular season of nightly runs
const RANKINGS_HISTORY = 28;
const RANKINGS_LIMIT_MAX = 100;
export const ODDS_STALE_HOURS = 48;

const ODDS_COLUMNS = 'season_id,team_id,run_date,make_playoffs_pct,win_division_pct,' +
  'proj_points_p10,proj_points_p50,proj_points_p90,current_points,games_remaining,sims,format';

// run_date is the pipeline's America/New_York date; noon UTC keeps the age
// from flipping on time zones.
export function isOddsRunStale(runDate, now = Date.now()) {
  const t = Date.parse(`${runDate}T12:00:00Z`);
  if (Number.isNaN(t)) return false;
  return (now - t) / 3600000 > ODDS_STALE_HOURS;
}

// A failed read (other than "no such table yet"), thrown so the route can
// answer its empty shape with `unavailable: true` instead of a 502.
class ReadFailed extends Error {}

// Rows of a read on a table that may not exist yet: [] when it doesn't.
async function rowsOrEmpty(url) {
  const rows = await sbRowsIfTable(url);
  if (rows === null) return [];
  if (rows instanceof Response) throw new ReadFailed(`Supabase ${rows.status}`);
  return rows;
}

const table = (league, name) => `${SB_URL}/rest/v1/${league}_${name}`;

async function playoffOdds(env, league, url) {
  const teamId = sbParam(url.searchParams.get('teamId'), { type: 'int', name: 'teamId' });
  if (!teamId) return badRequest('teamId required');
  const season = sbParam(url.searchParams.get('season'), { type: 'int', name: 'season' });
  const empty = { latest: null, history: [] };

  return cachedJson(env, `${league}:playoff-odds:${teamId}:${season || 'latest'}`, TTL, async () => {
    try {
      const bySeason = season ? `&season_id=eq.${season}` : '';
      const [latest] = await rowsOrEmpty(
        `${table(league, 'playoff_odds')}?select=${ODDS_COLUMNS}&team_id=eq.${teamId}${bySeason}&order=run_date.desc&limit=1`
      );
      if (!latest) return json(empty);
      const history = await rowsOrEmpty(
        `${table(league, 'playoff_odds')}?select=run_date,make_playoffs_pct,proj_points_p50` +
        `&team_id=eq.${teamId}&season_id=eq.${latest.season_id}&order=run_date.asc&limit=${ODDS_HISTORY_MAX}`
      );
      return { latest, history, stale: isOddsRunStale(latest.run_date) };
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.warn(`[${league}] playoff-odds unavailable: ${e.message}`);
      return json({ ...empty, unavailable: true });
    }
  });
}

async function powerRankings(env, league, url) {
  const teamId = sbParam(url.searchParams.get('teamId'), { type: 'int', name: 'teamId' });
  const season = sbParam(url.searchParams.get('season'), { type: 'int', name: 'season' });
  const rawLimit = parseInt(sbParam(url.searchParams.get('limit'), { type: 'int', name: 'limit' }) || '', 10);
  const limit = rawLimit > 0 ? Math.min(rawLimit, RANKINGS_LIMIT_MAX) : RANKINGS_LIMIT_MAX;
  const locale = requestLocale(url);
  const empty = { latest: [], narrative: null, history: [] };
  const kvKey = `${league}:power-rankings:${teamId || 'all'}:${season || 'latest'}:${limit}${localeKeySuffix(locale)}`;

  return cachedJson(env, kvKey, TTL, async () => {
    try {
      const bySeason = season ? `&season_id=eq.${season}` : '';
      const [run] = await rowsOrEmpty(
        `${table(league, 'power_rankings')}?select=season_id,run_date${bySeason}&order=run_date.desc&limit=1`
      );
      if (!run) return json(empty);
      const runFilter = `season_id=eq.${run.season_id}&run_date=eq.${run.run_date}`;

      const [latest, narrativeRows, historyRows] = await Promise.all([
        rowsOrEmpty(`${table(league, 'power_rankings')}?select=team_id,rank,prior_rank,score,components&${runFilter}&order=rank.asc&limit=${limit}`),
        teamId
          ? rowsOrEmpty(`${table(league, 'power_rankings_narratives')}?select=narrative,run_date&team_id=eq.${teamId}&${runFilter}&locale=eq.${locale}&limit=1`)
          : [],
        teamId
          ? rowsOrEmpty(`${table(league, 'power_rankings')}?select=run_date,rank&team_id=eq.${teamId}&season_id=eq.${run.season_id}&order=run_date.desc&limit=${RANKINGS_HISTORY}`)
          : [],
      ]);
      if (!latest.length) return json(empty);

      const n = narrativeRows[0];
      return {
        latest,
        narrative: n?.narrative ? { text: n.narrative, run_date: n.run_date } : null,
        history: historyRows.slice().reverse(),
      };
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.warn(`[${league}] power-rankings unavailable: ${e.message}`);
      return json({ ...empty, unavailable: true });
    }
  });
}

// The Response for /{pwhl,ahl,echl}/{playoff-odds,power-rankings}, or null
// for any other path (worker.js then routes it to the league's handler).
export async function handleOddsRankings(request, env, url) {
  const m = url.pathname.match(ROUTE);
  if (!m || request.method !== 'GET') return null;
  const [, league, route] = m;
  return route === 'playoff-odds' ? playoffOdds(env, league, url) : powerRankings(env, league, url);
}
