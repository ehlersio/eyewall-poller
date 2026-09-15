// src/__tests__/pwhl-routes.characterization.test.js
// Characterization ("golden master") tests for pwhl.js: every route, the
// news fetch and the live-game push poll, written before moving pwhl.js
// onto shared.js's route helpers (cachedJson/sbRows). Each test snapshots
// what the code does today -- response status/body, every upstream request
// (URL, Range header, HockeyTech Referer, AI prompt), and every KV write
// with its TTL. A refactor must leave these snapshots unchanged; a diff is
// a behavior change to explain in the PR, not a snapshot to update blindly.
// Same approach as hockeytech-leagues.characterization.test.js.
//
// pwhl-routes.test.js keeps its assertion-style tests for the routes it
// already covered; this file adds the 11 routes nothing tested before
// (/players, /shots, /schedule, /roster, /lastgame, /pbp, /salaries,
// /league-players, /player-shots, GET /news, /today) and pins request URLs,
// cache keys and TTLs for all of them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache, flushWaitUntil } from './route-harness.js'

const sendPushMock = vi.hoisted(() => vi.fn())
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock }
})

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
    getAllPWHLSeasonTypes: vi.fn().mockResolvedValue({ 8: 'regular', 9: 'playoffs' }),
  }
})

import { handlePWHL, pollPWHL, fetchPWHLNews, PWHL_TEAM_CODES } from '../pwhl.js'

const SEASON     = 8
const PLAYOFFS   = 9
const TEAM_A     = 1 // BOS
const TEAM_B     = 2 // MIN
const GAME_ID    = 210
const SKATER_ID  = 36
const SKATER2_ID = 37
const GOALIE_ID  = 6
const SECRET     = 'test-poll-secret' // makeEnv()'s POLL_SECRET

// ── Fixtures ──────────────────────────────────────────────────────────

function filterByPlayerId(rows, params) {
  const f = params.get('player_id')
  if (!f) return rows
  if (f.startsWith('eq.')) return rows.filter(r => r.player_id === Number(f.slice(3)))
  if (f.startsWith('in.(')) {
    const ids = f.slice(4, -1).split(',').map(Number)
    return rows.filter(r => ids.includes(r.player_id))
  }
  return rows
}

function supabaseRows(table, params) {
  switch (table) {
    case 'team_seasons':
      return [
        { team_id: TEAM_A, season_id: SEASON, season_type: 'regular', gp: 30, wins: 18, losses: 8, ot_losses: 4, points: 58, goals_for: 90, goals_against: 70, pp_pct: 0.22, pk_pct: 0.84, corsi_for_pct: 53.2, corsi_for_pct_5v5: 52.4 },
        { team_id: TEAM_B, season_id: SEASON, season_type: 'regular', gp: 30, wins: 12, losses: 14, ot_losses: 4, points: 42, goals_for: 72, goals_against: 85, pp_pct: 0.17, pk_pct: 0.79, corsi_for_pct: 47.1, corsi_for_pct_5v5: null },
      ]
    case 'game_log':
      return [
        { game_id: GAME_ID,     season_id: SEASON, game_date: '2026-01-15', home_team_id: TEAM_A, away_team_id: TEAM_B, home_score: 3, away_score: 2, ot: true,  shootout: false, game_state: 'Final', game_status_code: 4 },
        { game_id: GAME_ID - 1, season_id: SEASON, game_date: '2026-01-10', home_team_id: TEAM_B, away_team_id: TEAM_A, home_score: 4, away_score: 1, ot: false, shootout: false, game_state: 'Final', game_status_code: 4 },
        { game_id: GAME_ID - 2, season_id: SEASON, game_date: '2026-01-05', home_team_id: TEAM_A, away_team_id: TEAM_B, home_score: 2, away_score: 3, ot: false, shootout: true,  game_state: 'Final', game_status_code: 4 },
      ]
    case 'players':
      return filterByPlayerId([
        { player_id: SKATER_ID,  first_name: 'Alex', last_name: 'Skater', position: 'F', jersey_number: 19,   team_id: TEAM_A, birth_date: '2001-03-04', birth_city: 'Boston', shoots: 'L' },
        { player_id: SKATER2_ID, first_name: 'Sam',  last_name: 'Winger', position: 'D', jersey_number: null, team_id: TEAM_A, birth_date: '2002-06-07', birth_city: null,     shoots: 'R' },
        { player_id: GOALIE_ID,  first_name: 'Gus',  last_name: 'Keeper', position: 'G', jersey_number: 30,   team_id: TEAM_B, birth_date: '1999-11-12', birth_city: 'Oslo',   shoots: 'L' },
      ], params)
    case 'player_seasons':
      return filterByPlayerId([
        { player_id: SKATER_ID,  team_id: TEAM_A, season_id: SEASON, season_type: 'regular', gp: 30, goals: 12, assists: 15, points: 27, shots: 90, shot_pct: 13.3, pp_goals: 4, sh_goals: 1, gw_goals: 2, pim: 10, plus_minus: 7,  toi_per_game: 18.5, xg_for: 9.1, finishing: 2.9, pct_goals: 91, pct_a1: 80, pct_penalties: 40, pct_finishing: 88 },
        { player_id: SKATER2_ID, team_id: TEAM_A, season_id: SEASON, season_type: 'regular', gp: 28, goals: 3,  assists: 9,  points: 12, shots: 40, shot_pct: 7.5,  pp_goals: 0, sh_goals: 0, gw_goals: 0, pim: 18, plus_minus: -2, toi_per_game: null, xg_for: null, finishing: null, pct_goals: null, pct_a1: null, pct_penalties: null, pct_finishing: null },
      ], params)
    case 'goalie_seasons':
      return filterByPlayerId([
        { player_id: GOALIE_ID, team_id: TEAM_B, season_id: SEASON, season_type: 'regular', gp: 25, wins: 12, losses: 9, ot_losses: 4, gaa: 2.41, sv_pct: 0.918, shutouts: 3, saves: 700, goals_against: 62, gsax: 4.2, gsax_per60: 0.17, ev_sv_pct: 0.9234, hd_sv_pct: 0.851, md_sv_pct: null, pk_sv_pct: 0.88, pct_gsax: 77, pct_gsax60: 70, pct_ev_sv: 81, pct_hd_sv: 65, pct_md_sv: null, pct_pk_sv: 59 },
      ], params)
    case 'shot_events':
      return [
        { game_id: GAME_ID, team_id: TEAM_A, shooter_id: SKATER_ID,  goalie_id: GOALIE_ID, event_type: 'goal',         period_id: 1, time_seconds: 300, x_norm: 80.5,  y_norm: -10.2, is_home: true },
        { game_id: GAME_ID, team_id: TEAM_A, shooter_id: SKATER_ID,  goalie_id: GOALIE_ID, event_type: 'shot',         period_id: 2, time_seconds: 900, x_norm: -60,   y_norm: 50,    is_home: true },
        { game_id: GAME_ID, team_id: TEAM_A, shooter_id: SKATER2_ID, goalie_id: null,      event_type: 'blocked_shot', period_id: 2, time_seconds: 950, x_norm: 40,    y_norm: 5,     is_home: true },
        { game_id: GAME_ID, team_id: TEAM_A, shooter_id: SKATER_ID,  goalie_id: null,      event_type: 'missed_shot',  period_id: 3, time_seconds: 100, x_norm: 'n/a', y_norm: 0,     is_home: true },
        { game_id: GAME_ID, team_id: TEAM_B, shooter_id: 7010,       goalie_id: 7003,      event_type: 'shot',         period_id: 1, time_seconds: 500, x_norm: 70,    y_norm: 12,    is_home: false },
      ]
    case 'pbp_events':
      return [
        { game_id: GAME_ID, event_type: 'hit',     period_id: 1, time_seconds: 120, team_id: TEAM_A, player_id: SKATER_ID,  secondary_player_id: 7010 },
        { game_id: GAME_ID, event_type: 'penalty', period_id: 1, time_seconds: 400, team_id: null,   player_id: SKATER2_ID, secondary_player_id: null },
        { game_id: GAME_ID, event_type: 'faceoff', period_id: 2, time_seconds: 0,   team_id: TEAM_B, player_id: 7010,       secondary_player_id: SKATER_ID },
      ]
    case 'skater_game_box':
      return [{ game_id: GAME_ID, player_id: SKATER_ID, team_id: TEAM_A, season_id: SEASON, goals: 1, assists: 1, points: 2, shots: 4, toi_seconds: 1100 }]
    case 'goalie_game_box':
      return [{ game_id: GAME_ID, player_id: GOALIE_ID, team_id: TEAM_B, season_id: SEASON, saves: 25, shots_against: 28, goals_against: 3, toi_seconds: 3700 }]
    case 'salaries':
      return [
        { team_id: TEAM_A, season: '2025-26', player_name: 'Alex Skater', salary: 55000 },
        { team_id: TEAM_A, season: '2025-26', player_name: 'Sam Winger',  salary: 35000 },
      ]
    default:
      return []
  }
}

const person = (id, firstName, lastName, jerseyNumber = null) => ({ id: String(id), firstName, lastName, jerseyNumber })

function pbpEvents() {
  const goal = (id, time, period, properties) => ({
    event: 'goal',
    details: {
      game_goal_id: String(id), time, period: { id: period },
      team: { id: String(TEAM_A), abbreviation: 'x - BOS' },
      scoredBy: person(SKATER_ID, 'Alex', 'Skater', '19'),
      assists: [person(SKATER2_ID, 'Sam', 'Winger')],
      properties: { isPowerPlay: '0', ...properties },
      plus_players: [person(SKATER2_ID, 'Sam', 'Winger')], minus_players: [],
      xLocation: 150, yLocation: 80,
    },
  })
  return [
    { event: 'faceoff', details: { time: '0:00', period: { id: '1' }, homePlayer: person(SKATER_ID, 'Alex', 'Skater'), visitingPlayer: person(7010, 'Opp', 'Center'), homeWin: '1', xLocation: 0, yLocation: 0 } },
    { event: 'shot', details: { time: '1:10', period: { id: '1' }, shooterTeamId: String(TEAM_B), shooter: person(7010, 'Opp', 'Center'), goalie: person(7003, 'Home', 'Goalie'), shotType: 'Wrist', shotQuality: 'Quality', isGoal: false, xLocation: 100, yLocation: 50 } },
    { event: 'blocked_shot', details: { time: '2:30', period: { id: '1' }, shooterTeamId: String(TEAM_A), shooter: person(SKATER2_ID, 'Sam', 'Winger'), blocker: person(7012, 'Opp', 'Blocker'), isGoal: false } },
    { event: 'hit', details: { time: '3:00', period: { id: '1' }, teamId: String(TEAM_B), player: person(7012, 'Opp', 'Blocker'), onPlayer: person(SKATER_ID, 'Alex', 'Skater'), xLocation: 20, yLocation: -30 } },
    goal(1, '4:00', '1', { isPowerPlay: '1' }),
    { event: 'penalty', details: { game_penalty_id: '901', time: '8:00', period: { id: '1' }, againstTeam: { id: String(TEAM_B), abbreviation: 'MIN' }, takenBy: person(7010, 'Opp', 'Center'), servedBy: null, minutes: '2.00', description: 'Min-Hooking', isPowerPlay: true, isBench: false } },
    goal(2, '2:00', '2', { isShortHanded: '1' }),
    { event: 'shootout', details: { time: '0:00', period: { id: 'SO' } } },
    goal(3, '15:00', '3', { isEmptyNet: '1', isGameWinningGoal: '1' }),
    { event: 'goalie_change', details: { time: '18:00', period: { id: '3' }, team_id: String(TEAM_B), goalieComingIn: null, goalieGoingOut: person(GOALIE_ID, 'Gus', 'Keeper') } },
  ]
}

function hockeytechPayload(view) {
  switch (view) {
    case 'player':
      return [{
        careerStats: [{ sections: [
          { title: 'Regular Season', data: [
            { row: { season_name: '2025-26', team_name: 'Boston', games_played: '30', goals: '12' } },
            { row: { season_name: 'Total', team_name: '', games_played: '90', goals: '31', points: '70', shooting_percentage: '12.5' } },
          ] },
          { title: 'Playoffs', data: [{ row: { season_name: 'Total', team_name: '', games_played: '8', goals: '3' } }] },
        ] }],
        draftInfo: [{ sections: [{ title: '', data: [{ row: { draft_team: 'Boston', draft_round: '3', draft_year: '2023' } }] }] }],
        gameByGame: [{ sections: [{ title: '', data: Array.from({ length: 7 }, (_, i) => ({ row: { game: `Jan ${i + 1}`, goals: String(i % 2), assists: '1', points: String((i % 2) + 1) } })) }] }],
        info: { display_drafts: true, bio: '<ul><li><p>Captain &amp; leader</p></li><li><p>All-Star in 2025</p></li></ul>' },
        media: { images: [
          { url: 'https://img.example/a.jpg', is_primary: '0', width: '100', height: '100' },
          { url: 'https://img.example/b.jpg', is_primary: '1', width: '240', height: '240' },
        ] },
      }]
    case 'transactions':
      return [{ sections: [
        { title: 'transaction_results', data: [
          { row: { transaction_date: '2026-08-14', player_name: 'Neena Brick (F)', team_name: 'Boston', transaction_type: 'ADD', transaction: 'Signed', from: '' } },
          { row: { transaction_date: '2026-08-10', player_name: 'Sam Winger (D)', team_city: 'Minnesota', transaction_type: 'ADD', transaction: 'Signed' } },
        ] },
        { title: 'num_results', data: [{ row: { total: '2' } }] },
      ] }]
    case 'gameSummary':
      return {
        periods: [
          { info: { id: '1', shortName: '1st', longName: '1st Period' }, stats: { homeGoals: '2', homeShots: '12', visitingGoals: '1', visitingShots: '9' },
            goals: [{ game_goal_id: '555', time: '5:00', team: { id: String(TEAM_A), abbreviation: 'x - BOS' }, scoredBy: { ...person(SKATER_ID, 'Alex', 'Skater'), playerImageURL: 'https://assets.leaguestat.com/pwhl/120x160/36.jpg' }, assists: [person(SKATER2_ID, 'Sam', 'Winger')], properties: { isPowerPlay: '1' } }] },
          { info: { id: 'OT' }, stats: {}, goals: [] },
        ],
        mostValuablePlayers: [
          { team: { id: String(TEAM_A), abbreviation: 'BOS', name: 'Boston Fleet' }, player: { info: { ...person(SKATER_ID, 'Alex', 'Skater', '19'), position: 'F', playerImageURL: 'https://assets.leaguestat.com/pwhl/120x160/36.jpg' }, stats: { goals: 2 } }, isGoalie: false, homeTeam: 1 },
          { team: { id: String(TEAM_B), abbreviation: 'MIN', name: 'Minnesota Frost' }, player: { info: { ...person(GOALIE_ID, 'Gus', 'Keeper', '30'), position: 'G' }, stats: { saves: 25 } }, isGoalie: true, homeTeam: 0, playerImage: 'https://img.example/g.jpg' },
        ],
        referees: [{ firstName: 'Ref', lastName: 'One', jerseyNumber: '12' }],
        linesmen: [{ firstName: 'Line', lastName: 'Two', jerseyNumber: null }],
        homeTeam: {
          coaches: [{ role: 'General Manager', firstName: 'GM', lastName: 'Home' }, { role: 'Head Coach', firstName: 'Head', lastName: 'Home' }],
          stats: { goals: 3, shots: 30, hits: 14, faceoffWinPercentage: 55 },
          skaters: [{ info: { id: String(SKATER_ID), firstName: 'Alex', lastName: 'Skater' }, stats: { faceoffWins: '6', faceoffAttempts: '10' } }],
          goalies: [{ info: { id: '7003', firstName: 'Home', lastName: 'Goalie' }, stats: { saves: '26', shotsAgainst: '28', goalsAgainst: '2', timeOnIce: '60:00' } }],
        },
        visitingTeam: {
          coaches: [],
          stats: { goals: 2, shots: 28 },
          skaters: [
            { info: { id: '7010', firstName: 'Opp', lastName: 'Center' }, stats: { faceoffWins: '4', faceoffAttempts: '10' } },
            { info: { id: '7012', firstName: 'Opp', lastName: 'Blocker' }, stats: { faceoffAttempts: '0' } },
          ],
          goalies: [{ info: { id: String(GOALIE_ID), firstName: 'Gus', lastName: 'Keeper' }, stats: { saves: '25', shots: '28', goalsAgainst: '3', toi: '59:10' } }],
        },
        details: { venue: 'Fixture Arena' },
      }
    case 'gameCenterPreview':
      return {
        homeTeam: {
          teamInfo: { id: String(TEAM_A), abbreviation: 'BOS', name: 'Boston Fleet' }, goalsFor: 90, goalsAgainst: 70,
          teamRecord: { streak: '2-0-0-0', overall: { formattedRecord: '18-8-4' }, past_10_games: { formattedRecord: '7-2-1' } },
          leadingScorers: [{ info: { firstName: 'Alex', lastName: 'Skater' }, stats: { points: 27 } }],
          leadingRookie: { info: { firstName: 'Sam', lastName: 'Winger' }, stats: { points: 12 } },
          leadingPIM: null,
          powerPlayStats: { overall: { pct: 22 } }, penaltyKillStats: { overall: { pct: 84 } },
          longestStreaks: { wins: 5 },
        },
        visitingTeam: { teamInfo: { id: String(TEAM_B), abbreviation: 'MIN', name: 'Minnesota Frost' }, teamRecord: {}, leadingScorers: [] },
        previousMeetings: [{ gameId: String(GAME_ID - 1), datePlayed: '2026-01-10', homeTeamId: String(TEAM_B), homeCity: 'Minnesota', homeScore: '4', visitingTeamId: String(TEAM_A), visitingCity: 'Boston', visitingScore: '1' }],
        headToHeadRecords: { currentYear: { wins: 2 } },
      }
    case 'gameCenterPlayByPlay':
      return pbpEvents()
    default:
      return null
  }
}

function rssXml(feed) {
  return `<?xml version="1.0"?><rss><channel>
<item><title>${feed} PWHL headline one</title><link>https://news.example/${feed}/one</link><description><![CDATA[<p>First &amp; story</p>]]></description><pubDate>Wed, 14 Jan 2026 12:00:00 GMT</pubDate></item>
<item><title>${feed} PWHL headline two</title><link>https://news.example/${feed}/two</link><description>Second story</description><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate></item>
<item><title>${feed} unrelated story</title><link>https://news.example/${feed}/three</link><description>Nothing to see</description><pubDate>Thu, 15 Jan 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`
}

// ── Upstream + KV recording ──────────────────────────────────────────

const okJson = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })
const okText = (text) => ({ ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) })
const FAILED = { ok: false, status: 503, json: async () => ({}), text: async () => '' }

// Routes every fetch() by host: OpenRouter (AI), Supabase REST (by table
// suffix), HockeyTech (by view, JSONP-wrapped like the real feed), and
// anything else is treated as an RSS news source.
function installUpstream({ failSupabase = false, failHosts = [], overrides = {} } = {}) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (failHosts.some(h => u.hostname.includes(h))) return FAILED
    if (u.hostname === 'openrouter.ai') {
      return okJson({ choices: [{ message: { content: 'Fixture PWHL narrative.' } }] })
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      if (failSupabase) return FAILED
      const suffix = u.pathname.slice('/rest/v1/'.length).replace(/^pwhl_/, '')
      return okJson(overrides[suffix] ?? supabaseRows(suffix, u.searchParams))
    }
    if (u.hostname === 'lscluster.hockeytech.com') {
      return okText(`(${JSON.stringify(hockeytechPayload(u.searchParams.get('view')))})`)
    }
    return okText(rssXml(u.hostname))
  })
}

function upstreamCalls() {
  return globalThis.fetch.mock.calls.map(([input, opts = {}]) => {
    const headers = opts.headers || {}
    const call = { url: String(input) }
    if (opts.method && opts.method !== 'GET') call.method = opts.method
    if (headers.Range) call.range = headers.Range
    if (headers.Referer) call.referer = headers.Referer
    if (call.url.includes('openrouter.ai')) {
      const body = JSON.parse(opts.body)
      call.aiPrompt = body.messages.map(m => m.content).join('\n')
      call.maxTokens = body.max_tokens
    }
    return call
  })
}

function makeRecordingEnv(initial = {}, extra = {}) {
  const cache = makeFakeCache(initial)
  const kvWrites = []
  const put = cache.put
  const del = cache.delete
  cache.put = async (key, value, opts) => { kvWrites.push({ key, ttl: opts?.expirationTtl ?? null }); return put(key, value) }
  cache.delete = async (key) => { kvWrites.push({ key, deleted: true }); return del(key) }
  return { env: makeEnv({ CACHE: cache, ...extra }), kvWrites }
}

// A route that throws (instead of returning an error Response) is recorded
// as { threw } -- that's what the Worker's top-level handler would see.
async function callRoute(env, path, { method = 'GET', body, ctx = makeCtx() } = {}) {
  try {
    const res = await handlePWHL(makeRequest(path, { method, body }), env, ctx, new URL(`https://example.com${path}`))
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed }
  } catch (e) {
    return { threw: e.message }
  }
}

// ── Route table ───────────────────────────────────────────────────────
// `missing` is the same route without a required param (400 path).
// `notCached` marks a response the route deliberately doesn't cache, so a
// repeat call goes upstream again. `overrides` replaces a table's rows.

const H2H_BODY = {
  teamA: TEAM_A, teamB: TEAM_B, teamADisplay: 'Boston Fleet', teamBDisplay: 'Minnesota Frost', totalMeetings: 3,
  allTimeRecord: { teamAWins: 2, teamBWins: 1 }, recentWindow: { size: 3, teamAWins: 2, teamBWins: 1 },
  currentStreak: { holder: 'A', count: 1 }, isThinSample: true,
}
const NARRATIVE_BODY = {
  carAbbr: 'BOS', oppAbbr: 'MIN', carName: 'Boston Fleet', oppName: 'Minnesota Frost', periodLabel: '1st Period',
  corsiForPct: 54.2, carSOG: 30, oppSOG: 28, carGoals: 3, oppGoals: 2, carHits: 14, carFOPct: 55, carHDCF: 9, oppHDCF: 6,
  penaltyCount: 5, carPenaltyCount: 2, bestPeriod: { period: 1, corsiForPct: 61 }, worstPeriod: { period: 3, corsiForPct: 44 },
  primaryGoalieName: 'Home Goalie',
  goals: [
    { isCar: true, scorerName: 'Alex Skater', time: '5:00', period: 1, strength: 'pp' },
    { isCar: false, time: '12:00', period: 2, strength: 'ev' },
  ],
}

const ROUTES = [
  { name: 'standings',                        path: `/pwhl/standings?season=${SEASON}` },
  { name: 'standings (default season)',       path: '/pwhl/standings' },
  { name: 'team-seasons/compare',             path: `/pwhl/team-seasons/compare?teamId=${TEAM_A}&seasons=${SEASON},${PLAYOFFS}`, missing: `/pwhl/team-seasons/compare?teamId=${TEAM_A}` },
  { name: 'team-seasons/compare-teams',       path: `/pwhl/team-seasons/compare-teams?teamIds=${TEAM_A},${TEAM_B}&season=${SEASON}`, missing: `/pwhl/team-seasons/compare-teams?teamIds=${TEAM_A}&season=${SEASON}` },
  { name: 'team-seasons/head-to-head',        path: `/pwhl/team-seasons/head-to-head?teamIds=${TEAM_A},${TEAM_B}`, missing: `/pwhl/team-seasons/head-to-head?teamIds=${TEAM_A}` },
  { name: 'team-seasons/head-to-head/narrative', method: 'POST', path: '/pwhl/team-seasons/head-to-head/narrative', body: H2H_BODY },
  { name: 'team-seasons/head-to-head/narrative (incomplete body)', method: 'POST', path: '/pwhl/team-seasons/head-to-head/narrative', body: { teamA: TEAM_A } },
  { name: 'players',                          path: `/pwhl/players?teamId=${TEAM_A}&season=${SEASON}`, missing: '/pwhl/players' },
  { name: 'shots',                            path: `/pwhl/shots?teamId=${TEAM_A}&season=${SEASON}`, missing: '/pwhl/shots' },
  { name: 'team-season-summary',              path: `/pwhl/team-season-summary?teamId=${TEAM_A}&season=${SEASON}`, missing: '/pwhl/team-season-summary' },
  { name: 'team-season-summary (no completed games)', path: `/pwhl/team-season-summary?teamId=${TEAM_A}&season=${SEASON}`, overrides: { game_log: [] } },
  { name: 'schedule',                         path: `/pwhl/schedule?teamId=${TEAM_A}&season=${SEASON}`, missing: '/pwhl/schedule' },
  { name: 'roster',                           path: `/pwhl/roster?teamId=${TEAM_A}`, missing: '/pwhl/roster' },
  { name: 'game-box',                         path: `/pwhl/game-box?gameId=${GAME_ID}`, missing: '/pwhl/game-box' },
  { name: 'player-game-log',                  path: `/pwhl/player-game-log?playerId=${SKATER_ID}&seasonId=${SEASON}`, missing: `/pwhl/player-game-log?playerId=${SKATER_ID}` },
  { name: 'player/landing (skater)',          path: `/pwhl/player/landing?id=${SKATER_ID}&season=${SEASON}`, missing: '/pwhl/player/landing' },
  { name: 'player/landing (goalie, latest season)', path: `/pwhl/player/landing?id=${GOALIE_ID}` },
  { name: 'player/landing (unknown player)',  path: '/pwhl/player/landing?id=1', notCached: true },
  { name: 'player/percentiles',               path: `/pwhl/player/percentiles?id=${SKATER_ID}&season=${SEASON}`, missing: '/pwhl/player/percentiles' },
  { name: 'player/percentiles (no row, playoffs)', path: '/pwhl/player/percentiles?id=999&seasonType=playoffs' },
  { name: 'goalie/percentiles',               path: `/pwhl/goalie/percentiles?id=${GOALIE_ID}&season=${SEASON}`, missing: '/pwhl/goalie/percentiles' },
  { name: 'player/career',                    path: `/pwhl/player/career?id=${SKATER_ID}`, missing: '/pwhl/player/career' },
  { name: 'transactions',                     path: `/pwhl/transactions?season=${SEASON}` },
  { name: 'lastgame',                         path: `/pwhl/lastgame?teamId=${TEAM_A}&season=${SEASON}`, missing: '/pwhl/lastgame' },
  { name: 'lastgame (no completed game)',     path: `/pwhl/lastgame?teamId=${TEAM_A}&season=${SEASON}`, overrides: { game_log: [] }, notCached: true },
  { name: 'pbp',                              path: `/pwhl/pbp?gameId=${GAME_ID}`, missing: '/pwhl/pbp' },
  { name: 'pbp (game not in the log)',        path: `/pwhl/pbp?gameId=${GAME_ID}`, overrides: { game_log: [] } },
  { name: 'salaries',                         path: `/pwhl/salaries?teamId=${TEAM_A}`, missing: '/pwhl/salaries' },
  { name: 'league-players',                   path: `/pwhl/league-players?season=${SEASON}` },
  { name: 'scout (skater)', method: 'POST',   path: '/pwhl/scout', notCached: true,
    body: { name: 'Alex Skater', position: 'F', seasonLabel: '2025-26', isGoalie: false, stats: { gp: 30, goals: 12, assists: 15, points: 27, plus_minus: 7, shot_pct: 13.33 } } },
  { name: 'scout (goalie)', method: 'POST',   path: '/pwhl/scout', notCached: true,
    body: { name: 'Gus Keeper', position: 'G', seasonLabel: '2025-26', isGoalie: true, stats: { gp: 25, wins: 12, sv_pct: 0.918, gaa: 2.41 } } },
  { name: 'scout (no name)', method: 'POST',  path: '/pwhl/scout', body: { position: 'F', stats: {} } },
  { name: 'player-shots',                     path: `/pwhl/player-shots?playerId=${SKATER_ID}&season=${SEASON}`, missing: '/pwhl/player-shots' },
  { name: 'goalie-shots',                     path: `/pwhl/goalie-shots?goalieId=${GOALIE_ID}&season=${SEASON}`, missing: '/pwhl/goalie-shots' },
  { name: 'today',                            path: `/pwhl/today?season=${SEASON}` },
  { name: 'live/:gameId',                     path: `/pwhl/live/${GAME_ID}`, missing: '/pwhl/live/abc' },
  { name: 'summary',                          path: `/pwhl/summary?gameId=${GAME_ID}`, missing: '/pwhl/summary' },
  { name: 'summary/narrative (game)', method: 'POST', path: `/pwhl/summary/narrative?gameId=${GAME_ID}&period=game&carAbbr=bos`, body: NARRATIVE_BODY },
  { name: 'summary/narrative (period)', method: 'POST', path: `/pwhl/summary/narrative?gameId=${GAME_ID}&period=1&carAbbr=BOS`, body: NARRATIVE_BODY },
  { name: 'preview',                          path: `/pwhl/preview?gameId=${GAME_ID}`, missing: '/pwhl/preview' },
  { name: 'prediction',                       path: `/pwhl/prediction?gameId=${GAME_ID}`, missing: '/pwhl/prediction' },
  { name: 'prediction (force regenerate)',    path: `/pwhl/prediction?gameId=${GAME_ID}&force=1`, notCached: true },
  { name: 'unknown route',                    path: '/pwhl/no-such-route' },
]

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Fixed in-season evening (18:30 ET, Jan 15) so the poll season gate,
  // "today" ET date, recordHealth timestamps and generatedAt are stable.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-15T23:30:00Z'))
  sendPushMock.mockReset().mockResolvedValue('ok')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('team code map', () => {
  expect(PWHL_TEAM_CODES).toMatchSnapshot()
})

describe.each(ROUTES)('$name', (R) => {
  const opts = { method: R.method, body: R.body }

  it('response, upstream requests and KV writes; repeat call', async () => {
    installUpstream({ overrides: R.overrides })
    const { env, kvWrites } = makeRecordingEnv()

    const first = await callRoute(env, R.path, opts)
    expect({ ...first, upstream: upstreamCalls(), kvWrites }).toMatchSnapshot()

    const callsBefore = globalThis.fetch.mock.calls.length
    const second = await callRoute(env, R.path, opts)
    expect(second).toEqual(first)
    if (R.notCached) expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(callsBefore)
    else expect(globalThis.fetch.mock.calls.length).toBe(callsBefore)
  })

  it('Supabase unavailable', async () => {
    installUpstream({ failSupabase: true, overrides: R.overrides })
    const { env, kvWrites } = makeRecordingEnv()
    expect({ ...(await callRoute(env, R.path, opts)), kvWrites }).toMatchSnapshot()
  })

  it('HockeyTech and AI unavailable', async () => {
    installUpstream({ failHosts: ['hockeytech', 'openrouter'], overrides: R.overrides })
    const { env, kvWrites } = makeRecordingEnv()
    expect({ ...(await callRoute(env, R.path, opts)), kvWrites }).toMatchSnapshot()
  })

  if (R.missing) {
    it('missing required param', async () => {
      installUpstream()
      const { env } = makeRecordingEnv()
      expect({ ...(await callRoute(env, R.missing)), upstream: upstreamCalls() }).toMatchSnapshot()
    })
  }
})

describe('news', () => {
  it('GET /pwhl/news with a cold cache returns [] and fetches every source in the background', async () => {
    installUpstream()
    const { env, kvWrites } = makeRecordingEnv()
    const ctx = makeCtx()

    const res = await callRoute(env, '/pwhl/news', { ctx })
    await flushWaitUntil(ctx)
    const stored = JSON.parse(await env.CACHE.get('pwhl:news'))
    const health = Object.fromEntries(
      [...env.CACHE._store].filter(([k]) => k.startsWith('health:')).map(([k, v]) => [k, JSON.parse(v)])
    )
    expect({ res, upstream: upstreamCalls(), kvWrites, stored, health }).toMatchSnapshot()

    expect(await callRoute(env, '/pwhl/news')).toEqual({ status: 200, body: stored })
  })

  it('fetchPWHLNews: a failing source is recorded in health and skipped; cached articles are merged in', async () => {
    installUpstream({ failHosts: ['thescore'] })
    const existing = [{ id: 'kept-1', url: 'https://news.example/kept', title: 'Kept', publishedAt: '2026-01-01T00:00:00.000Z' }]
    const { env, kvWrites } = makeRecordingEnv({ 'pwhl:news': existing })

    const merged = await fetchPWHLNews(env)
    const health = Object.fromEntries(
      [...env.CACHE._store].filter(([k]) => k.startsWith('health:')).map(([k, v]) => [k, JSON.parse(v)])
    )
    expect({ merged, health, kvWrites, upstream: upstreamCalls() }).toMatchSnapshot()
  })

  it('fetchPWHLNews: every source down caches an empty list briefly', async () => {
    installUpstream({ failHosts: ['thehockeynews', 'thescore', 'nytimes', 'sportsnet'] })
    const { env, kvWrites } = makeRecordingEnv()
    expect({ merged: await fetchPWHLNews(env), kvWrites }).toMatchSnapshot()
  })

  it('POST /pwhl/news/bust requires the secret, then clears the cache', async () => {
    const { env, kvWrites } = makeRecordingEnv({ 'pwhl:news': [{ id: 'x' }] })
    const denied = await callRoute(env, '/pwhl/news/bust', { method: 'POST' })
    const busted = await callRoute(env, `/pwhl/news/bust?secret=${SECRET}`, { method: 'POST' })
    expect({ denied, busted, kvWrites, remaining: await env.CACHE.get('pwhl:news') }).toMatchSnapshot()
  })

  it('POST /pwhl/news/ingest requires the secret, rejects non-arrays, and merges with the cached list', async () => {
    const existing = [
      { id: 'old-1', url: 'https://news.example/a?utm_source=x', title: 'Old A', publishedAt: '2026-01-10T00:00:00.000Z' },
      { id: 'old-2', url: 'https://news.example/b', title: 'Old B', publishedAt: '2026-01-01T00:00:00.000Z' },
    ]
    const { env, kvWrites } = makeRecordingEnv({ 'pwhl:news': existing })
    const incoming = [
      { id: 'new-1', url: 'https://news.example/a', title: 'New A (same link)', publishedAt: '2026-01-14T00:00:00.000Z' },
      { id: 'new-2', url: 'https://news.example/c', title: 'New C', publishedAt: '2026-01-12T00:00:00.000Z' },
    ]
    const denied = await callRoute(env, '/pwhl/news/ingest', { method: 'POST', body: incoming })
    const bad = await callRoute(env, `/pwhl/news/ingest?secret=${SECRET}`, { method: 'POST', body: { not: 'an array' } })
    const ok = await callRoute(env, `/pwhl/news/ingest?secret=${SECRET}`, { method: 'POST', body: incoming })
    const stored = JSON.parse(await env.CACHE.get('pwhl:news'))
    expect({ denied, bad, ok, stored, kvWrites }).toMatchSnapshot()
  })
})

describe('POST /pwhl/cache/bust', () => {
  it('requires the secret and a teamId, then deletes the team and league keys', async () => {
    const { env, kvWrites } = makeRecordingEnv()
    const denied = await callRoute(env, `/pwhl/cache/bust?teamId=${TEAM_A}`, { method: 'POST' })
    const noTeam = await callRoute(env, `/pwhl/cache/bust?secret=${SECRET}`, { method: 'POST' })
    const busted = await callRoute(env, `/pwhl/cache/bust?secret=${SECRET}&teamId=${TEAM_A}&season=${SEASON}`, { method: 'POST' })
    const withGame = await callRoute(env, `/pwhl/cache/bust?secret=${SECRET}&teamId=${TEAM_A}&gameId=${GAME_ID}`, { method: 'POST' })
    expect({ denied, noTeam, busted, withGame, kvWrites }).toMatchSnapshot()
  })
})

describe('poll', () => {
  const sub = (endpoint, abbr, extra = {}) => ({ endpoint, keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `PWHL:${abbr}`, ...extra })
  const subsFor = () => [
    sub('https://push.example/home', PWHL_TEAM_CODES[TEAM_A]),
    sub('https://push.example/away', PWHL_TEAM_CODES[TEAM_B]),
    sub('https://push.example/away-no-opp-goals', PWHL_TEAM_CODES[TEAM_B], { prefs: { oppGoal: false } }),
    { endpoint: 'https://push.example/nhl', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'NHL:CAR' },
  ]
  const liveGame = (overrides = {}) => ({
    game_id: GAME_ID, home_team_id: TEAM_A, away_team_id: TEAM_B,
    home_score: 3, away_score: 0, game_state: 'In Progress', game_status_code: 2, ...overrides,
  })
  const finalGame = () => liveGame({ home_score: 4, away_score: 2, game_state: 'Final', game_status_code: 4 })
  const pushes = () => sendPushMock.mock.calls.map(([s, payload]) => ({ to: s.endpoint, ...payload }))

  it('does nothing in the offseason', async () => {
    vi.setSystemTime(new Date('2026-08-15T16:00:00Z'))
    installUpstream()
    const { env } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
    await pollPWHL(env)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('does nothing without a VAPID private key', async () => {
    installUpstream()
    const { env } = makeRecordingEnv({ 'push:subs': subsFor() })
    await pollPWHL(env)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('does nothing when today\'s schedule read fails', async () => {
    installUpstream({ failSupabase: true })
    const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
    await pollPWHL(env)
    expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()
  })

  it('live game: start, period, goal, hat-trick, power-play and pulled-goalie pushes; a second poll sends nothing new', async () => {
    installUpstream({ overrides: { game_log: [liveGame()] } })
    const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })

    await pollPWHL(env)
    expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()

    sendPushMock.mockClear()
    await pollPWHL(env)
    expect(sendPushMock).not.toHaveBeenCalled()
  })

  it('a game already final the first time it is polled gets no game-over push', async () => {
    installUpstream({ overrides: { game_log: [finalGame()] } })
    const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
    await pollPWHL(env)
    expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()
  })

  it('a game followed live gets exactly one game-over push when it goes final', async () => {
    installUpstream({ overrides: { game_log: [liveGame()] } })
    const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
    await pollPWHL(env)

    installUpstream({ overrides: { game_log: [finalGame()] } })
    sendPushMock.mockClear()
    kvWrites.length = 0
    await pollPWHL(env)
    expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()

    sendPushMock.mockClear()
    globalThis.fetch.mockClear()
    await pollPWHL(env)
    expect(sendPushMock).not.toHaveBeenCalled()
    expect(upstreamCalls().map(c => c.url).filter(u => u.includes('hockeytech'))).toEqual([])
  })

  it('prunes subscriptions whose push endpoint has expired', async () => {
    installUpstream({ overrides: { game_log: [liveGame()] } })
    sendPushMock.mockImplementation(async (s) => (s.endpoint === 'https://push.example/away' ? 'expired' : 'ok'))
    const { env } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
    await pollPWHL(env)
    const remaining = JSON.parse(await env.CACHE.get('push:subs')).map(s => s.endpoint)
    expect(remaining).toMatchSnapshot()
  })
})
