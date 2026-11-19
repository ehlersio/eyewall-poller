// League-wide read routes for the public API (eyewall-api, 2026-11): the
// app reads these per team or per game, while an outside caller wants every
// team or every game at once. eyewall-api calls them over a Service Binding
// and reshapes them into its stable /v1 schemas, so the rows here stay as
// the tables hold them.
//
//   GET /config/teams?league=nhl|pwhl|ahl|echl
//     { league, teams: [{ id, code, name }] } -- current teams only (the
//     historical ids the maps keep for labelling old seasons are left out),
//     from the same maps the routes and AI prompts use.
//   GET /win-probs?league=...&date=YYYY-MM-DD | &gameId=N
//     { league, games: [row] } -- the logged pre-game Elo probabilities:
//     game_win_probs (eyewall-pipeline's win_probs.py) for the NHL,
//     {league}_game_win_probs (hockeytech_elo.py) for the others. These are
//     the numbers the public scorecard grades. 30-min KV.
//   GET /playoff-odds/league?league=...[&season=]
//     { league, season, runDate, stale, teams: [row] } -- every team's row
//     from the latest nightly run (playoff_odds / {league}_playoff_odds).
//     1hr KV.
//   GET /nhl/power-rankings/league[?season=]
//     { season, runDate, teams: [{ team, rank, prior_rank }] } -- every
//     team from the latest power_rankings_narratives run (eyewall-pipeline's
//     power_rankings.py), the league-wide view the per-team /power-rankings
//     doesn't give. Narratives stay on the per-team route. 1hr KV.
//   GET /game-shot-xg?league=...&date=YYYY-MM-DD | &gameId=N | &season=N|latest
//     { league, season, rows: [row] } -- each team's xG per game from
//     EyeWall's own shot models (eyewall-pipeline's game_shot_xg.py):
//     game_shot_xg for the NHL (rows per team for situation 'all' and
//     '5v5'), {league}_game_shot_xg for the others (one row per team).
//     `season` (NHL season or HockeyTech season id, or `latest`) pages past
//     PostgREST's 1,000-row cap for the bulk files. Never MoneyPuck's
//     game_xg. 1hr KV; empty answers aren't cached.
//
// A missing table or a failed read answers the empty shape with
// `unavailable: true`, uncached, like leagueOddsRankings.js.

import { TEAM_CONFIGS } from './nhl.js';
import { PWHL_TEAM_CODES, PWHL_TEAM_NAMES } from './pwhl.js';
import { AHL_TEAM_CODES, AHL_TEAM_NAMES, AHL_HISTORICAL_TEAM_IDS } from './ahl.js';
import { ECHL_TEAM_CODES, ECHL_TEAM_NAMES, ECHL_HISTORICAL_TEAM_IDS } from './echl.js';
import { badRequest, cachedJson, json, sbParam, sbRowsIfTable, SB_URL } from './shared.js';
import { isPlayoffOddsStale } from './playoffOdds.js';
import { isOddsRunStale, ODDS_BASE_COLUMNS, ODDS_COLUMNS } from './leagueOddsRankings.js';

export const PUBLIC_LEAGUES = ['nhl', 'pwhl', 'ahl', 'echl'];

const WIN_PROBS_TTL = 1800;
const ODDS_TTL = 3600;
const TEAMS_MAX_AGE = 3600;
const SHOT_XG_TTL = 3600;
const PAGE = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const NHL_ODDS_COLUMNS = 'team,season,run_date,playoff_pct,division_pct,proj_points,points_p10,points_p90,' +
  'current_points,games_played,games_remaining,elo_rating,sims';
const NHL_WIN_PROB_COLUMNS = 'game_id,game_date,game_type,season,home_team,away_team,neutral,' +
  'home_rating,away_rating,home_win_prob,run_date';
const HT_WIN_PROB_COLUMNS = 'game_id,season_id,game_date,home_team_id,away_team_id,' +
  'home_rating,away_rating,home_win_prob,run_date';

const NHL_SHOT_XG_COLUMNS = 'game_id,season,game_type,game_date,team,opponent,is_home,situation,' +
  'attempts,goals,xg,model,updated_at';
const HT_SHOT_XG_COLUMNS = 'game_id,season_id,season_type,game_date,team_id,opponent_id,is_home,' +
  'attempts,goals,xg,model,updated_at';

class ReadFailed extends Error {}

function hockeyTechTeams(codes, names, historical = []) {
  const skip = new Set(historical.map(String));
  return Object.entries(codes)
    .filter(([id]) => !skip.has(String(id)))
    .map(([id, code]) => ({ id: Number(id), code, name: names[id] ?? null }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// Current teams per league. Pure, exported for tests.
export function leagueTeams(league) {
  switch (league) {
    case 'nhl':
      return Object.values(TEAM_CONFIGS)
        .map(t => ({ id: t.teamId, code: t.abbr, name: t.displayName }))
        .sort((a, b) => a.code.localeCompare(b.code));
    case 'pwhl': return hockeyTechTeams(PWHL_TEAM_CODES, PWHL_TEAM_NAMES);
    case 'ahl':  return hockeyTechTeams(AHL_TEAM_CODES, AHL_TEAM_NAMES, AHL_HISTORICAL_TEAM_IDS);
    case 'echl': return hockeyTechTeams(ECHL_TEAM_CODES, ECHL_TEAM_NAMES, ECHL_HISTORICAL_TEAM_IDS);
    default: return null;
  }
}

function leagueParam(url) {
  const league = (url.searchParams.get('league') || '').toLowerCase();
  return PUBLIC_LEAGUES.includes(league) ? league : null;
}

// Rows, [] for a table that doesn't exist yet, ReadFailed otherwise.
async function rows(path) {
  const r = await sbRowsIfTable(`${SB_URL}/rest/v1/${path}`);
  if (r === null) return [];
  if (r instanceof Response) throw new ReadFailed(`Supabase ${r.status}`);
  return r;
}

async function winProbs(env, league, url) {
  const rawDate = url.searchParams.get('date');
  const gameId = sbParam(url.searchParams.get('gameId'), { type: 'int', name: 'gameId' });
  if (rawDate && !DATE_RE.test(rawDate)) return badRequest('date must be YYYY-MM-DD');
  if (!rawDate && !gameId) return badRequest('date or gameId required');
  const filter = gameId ? `game_id=eq.${gameId}` : `game_date=eq.${rawDate}`;
  const nhl = league === 'nhl';
  const tableName = nhl ? 'game_win_probs' : `${league}_game_win_probs`;
  const cols = nhl ? NHL_WIN_PROB_COLUMNS : HT_WIN_PROB_COLUMNS;
  const empty = { league, games: [] };

  return cachedJson(env, `public:win-probs:${league}:${gameId ? `g${gameId}` : rawDate}`, WIN_PROBS_TTL, async () => {
    try {
      const games = await rows(`${tableName}?select=${cols}&${filter}&order=game_id.asc&limit=200`);
      // An empty answer isn't cached: tomorrow's games are logged the
      // morning before, and a date asked early would otherwise stay empty.
      return games.length ? { league, games } : json(empty, { maxAge: 0 });
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.warn(`[${league}] win-probs unavailable: ${e.message}`);
      return json({ ...empty, unavailable: true });
    }
  });
}

async function leaguePlayoffOdds(env, league, url) {
  const season = sbParam(url.searchParams.get('season'), { type: 'int', name: 'season' });
  const nhl = league === 'nhl';
  const tableName = nhl ? 'playoff_odds' : `${league}_playoff_odds`;
  const seasonCol = nhl ? 'season' : 'season_id';
  const empty = { league, season: season ? Number(season) : null, runDate: null, stale: false, teams: [] };

  return cachedJson(env, `public:playoff-odds:${league}:${season || 'latest'}`, ODDS_TTL, async () => {
    try {
      const bySeason = season ? `&${seasonCol}=eq.${season}` : '';
      const [run] = await rows(`${tableName}?select=${seasonCol},run_date${bySeason}&order=run_date.desc&limit=1`);
      if (!run) return json(empty);
      const runFilter = `${seasonCol}=eq.${run[seasonCol]}&run_date=eq.${run.run_date}`;
      let teams;
      if (nhl) {
        teams = await rows(`${tableName}?select=${NHL_ODDS_COLUMNS}&${runFilter}&order=playoff_pct.desc&limit=100`);
      } else {
        // games_played comes from an owner-run migration; without it
        // PostgREST answers 400 (rows() -> []), so retry without the column.
        teams = await rows(`${tableName}?select=${ODDS_COLUMNS}&${runFilter}&order=team_id.asc&limit=100`);
        if (!teams.length) {
          teams = (await rows(`${tableName}?select=${ODDS_BASE_COLUMNS}&${runFilter}&order=team_id.asc&limit=100`))
            .map(r => ({ ...r, games_played: null }));
        }
      }
      if (!teams.length) return json(empty);
      return {
        league,
        season: Number(run[seasonCol]),
        runDate: run.run_date,
        stale: nhl ? isPlayoffOddsStale(run.run_date) : isOddsRunStale(run.run_date),
        teams,
      };
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.warn(`[${league}] league playoff-odds unavailable: ${e.message}`);
      return json({ ...empty, unavailable: true });
    }
  });
}

async function nhlPowerRankingsLeague(env, url) {
  const season = sbParam(url.searchParams.get('season'), { type: 'int', name: 'season' });
  const empty = { season: season ? Number(season) : null, runDate: null, teams: [] };
  return cachedJson(env, `public:nhl-power-rankings:${season || 'latest'}`, ODDS_TTL, async () => {
    try {
      const bySeason = season ? `&season=eq.${season}` : '';
      const [run] = await rows(`power_rankings_narratives?select=season,generated_date${bySeason}&order=generated_date.desc&limit=1`);
      if (!run) return json(empty);
      const teams = await rows(
        `power_rankings_narratives?select=team,rank,prior_rank&season=eq.${run.season}` +
        `&generated_date=eq.${run.generated_date}&order=rank.asc&limit=100`
      );
      if (!teams.length) return json(empty);
      return { season: Number(run.season), runDate: run.generated_date, teams };
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.warn(`[nhl] league power-rankings unavailable: ${e.message}`);
      return json({ ...empty, unavailable: true });
    }
  });
}

// Every row of a filtered read, paged in a fixed order (`path` has its
// select, filter and order; limit/offset are added here).
async function allRows(path, maxPages = 20) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const batch = await rows(`${path}&limit=${PAGE}&offset=${page * PAGE}`);
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
  throw new ReadFailed(`more than ${maxPages * PAGE} rows`);
}

async function gameShotXg(env, league, url) {
  const rawDate = url.searchParams.get('date');
  const gameId = sbParam(url.searchParams.get('gameId'), { type: 'int', name: 'gameId' });
  const rawSeason = url.searchParams.get('season');
  const latest = rawSeason === 'latest';
  const season = latest ? null : sbParam(rawSeason, { type: 'int', name: 'season' });
  if (rawDate && !DATE_RE.test(rawDate)) return badRequest('date must be YYYY-MM-DD');
  if (!rawDate && !gameId && !season && !latest) return badRequest('date, gameId or season required');
  const nhl = league === 'nhl';
  const tableName = nhl ? 'game_shot_xg' : `${league}_game_shot_xg`;
  const cols = nhl ? NHL_SHOT_XG_COLUMNS : HT_SHOT_XG_COLUMNS;
  const seasonCol = nhl ? 'season' : 'season_id';
  const order = nhl ? 'game_id.asc,team.asc,situation.asc' : 'game_id.asc,team_id.asc';
  const key = gameId ? `g${gameId}` : rawDate ? rawDate : `s${latest ? 'latest' : season}`;
  const empty = { league, season: season ? Number(season) : null, rows: [] };

  return cachedJson(env, `public:game-shot-xg:${league}:${key}`, SHOT_XG_TTL, async () => {
    try {
      let filter;
      let resolvedSeason = season ? Number(season) : null;
      if (gameId) filter = `game_id=eq.${gameId}`;
      else if (rawDate) filter = `game_date=eq.${rawDate}`;
      else {
        if (latest) {
          const [top] = await rows(`${tableName}?select=${seasonCol}&order=${seasonCol}.desc&limit=1`);
          if (!top) return json(empty, { maxAge: 0 });
          resolvedSeason = Number(top[seasonCol]);
        }
        filter = `${seasonCol}=eq.${resolvedSeason}`;
      }
      const found = await allRows(`${tableName}?select=${cols}&${filter}&order=${order}`);
      if (!found.length) return json({ ...empty, season: resolvedSeason }, { maxAge: 0 });
      return { league, season: resolvedSeason ?? Number(found[0][seasonCol]), rows: found };
    } catch (e) {
      if (!(e instanceof ReadFailed)) throw e;
      console.warn(`[${league}] game-shot-xg unavailable: ${e.message}`);
      return json({ ...empty, unavailable: true });
    }
  });
}

// The Response for one of the routes above, or null for any other path.
export async function handlePublicData(request, env, url) {
  const route = url.pathname;
  if (request.method === 'GET' && route === '/nhl/power-rankings/league') return nhlPowerRankingsLeague(env, url);
  if (request.method !== 'GET' ||
      (route !== '/config/teams' && route !== '/win-probs' && route !== '/playoff-odds/league' &&
        route !== '/game-shot-xg')) {
    return null;
  }
  const league = leagueParam(url);
  if (!league) return badRequest(`league must be one of ${PUBLIC_LEAGUES.join(', ')}`);
  if (route === '/config/teams') return json({ league, teams: leagueTeams(league) }, { maxAge: TEAMS_MAX_AGE });
  if (route === '/win-probs') return winProbs(env, league, url);
  if (route === '/game-shot-xg') return gameShotXg(env, league, url);
  return leaguePlayoffOdds(env, league, url);
}
