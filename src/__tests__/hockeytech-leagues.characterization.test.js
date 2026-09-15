// src/__tests__/hockeytech-leagues.characterization.test.js
// Characterization ("golden master") tests for ahl.js and echl.js, written
// before merging the two near-identical files into one shared HockeyTech-
// league implementation. Every route, the live-game poll, and the news
// fetch run for BOTH leagues against the same fixed fixtures, and each test
// snapshots what the code actually does today: response status/body, every
// upstream request (URL, Range header, HockeyTech Referer, AI prompt), and
// every KV write with its TTL. A refactor must leave these snapshots
// unchanged -- any diff is a behavior change to explain in the PR, not a
// snapshot to update blindly.
//
// Fixtures are keyed by table suffix (ahl_game_log / echl_game_log ->
// 'game_log') and HockeyTech view, so one set drives both leagues; the
// per-league values (season ids, team ids) come from LEAGUES below.

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
    resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 90, seasonType: 'regular' }),
    getAllAHLSeasonTypes: vi.fn().mockResolvedValue({ 90: 'regular', 92: 'playoffs' }),
    resolveECHLSeason: vi.fn().mockResolvedValue({ seasonId: 73, seasonType: 'regular' }),
    getAllECHLSeasonTypes: vi.fn().mockResolvedValue({ 73: 'regular', 76: 'playoffs' }),
  }
})

import { handleAHL, pollAHL, fetchAHLNews, AHL_TEAM_CODES } from '../ahl.js'
import { handleECHL, pollECHL, fetchECHLNews, ECHL_TEAM_CODES } from '../echl.js'

const LEAGUES = [
  { key: 'ahl',  handle: handleAHL,  poll: pollAHL,  fetchNews: fetchAHLNews,  codes: AHL_TEAM_CODES,  season: 90, playoffSeason: 92, teamA: 335, teamB: 323 },
  { key: 'echl', handle: handleECHL, poll: pollECHL, fetchNews: fetchECHLNews, codes: ECHL_TEAM_CODES, season: 73, playoffSeason: 76, teamA: 8,   teamB: 99 },
]

const GAME_ID    = 1028992
const SKATER_ID  = 6681
const SKATER2_ID = 6682
const GOALIE_ID  = 7001
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

function supabaseRows(L, table, params) {
  const { season, teamA, teamB } = L
  switch (table) {
    case 'team_seasons':
      return [
        { team_id: teamA, season_id: season, season_type: 'regular', gp: 40, wins: 24, losses: 12, ot_losses: 3, shootout_losses: 1, points: 52, goals_for: 130, goals_against: 105, pp_pct: 0.21, pk_pct: 0.83 },
        { team_id: teamB, season_id: season, season_type: 'regular', gp: 40, wins: 18, losses: 17, ot_losses: 4, shootout_losses: 1, points: 41, goals_for: 112, goals_against: 118, pp_pct: 0.17, pk_pct: 0.8 },
      ]
    case 'game_log':
      return [
        { game_id: GAME_ID,     season_id: season, game_date: '2026-01-15', home_team_id: teamA, away_team_id: teamB, home_score: 4, away_score: 2, game_state: 'Final', game_status_code: 4 },
        { game_id: GAME_ID - 1, season_id: season, game_date: '2026-01-10', home_team_id: teamB, away_team_id: teamA, home_score: 3, away_score: 1, game_state: 'Final', game_status_code: 4 },
        { game_id: GAME_ID - 2, season_id: season, game_date: '2026-01-05', home_team_id: teamA, away_team_id: teamB, home_score: 5, away_score: 3, game_state: 'Final', game_status_code: 4 },
      ]
    case 'players':
      return filterByPlayerId([
        { player_id: SKATER_ID,  first_name: 'Alex', last_name: 'Skater', position: 'C',  jersey_number: 19,   team_id: teamA, birth_date: '2001-03-04', birth_place: 'Toronto, ON', shoots: 'L', height_inches: 72, weight_lbs: 190 },
        { player_id: SKATER2_ID, first_name: 'Sam',  last_name: 'Winger', position: 'LW', jersey_number: null, team_id: teamA, birth_date: '2002-06-07', birth_place: null,          shoots: 'R', height_inches: 70, weight_lbs: 180 },
        { player_id: GOALIE_ID,  first_name: 'Gus',  last_name: 'Keeper', position: 'G',  jersey_number: 30,   team_id: teamB, birth_date: '1999-11-12', birth_place: 'Oslo, NO',    shoots: 'L', height_inches: 75, weight_lbs: 200 },
      ], params)
    case 'player_seasons':
      return [
        { player_id: SKATER_ID,  team_id: teamA, season_id: season, season_type: 'regular', gp: 40, goals: 15, assists: 20, points: 35, shots: 110, pp_goals: 5, sh_goals: 1, pim: 12, plus_minus: 8 },
        { player_id: SKATER2_ID, team_id: teamA, season_id: season, season_type: 'regular', gp: 38, goals: 9,  assists: 11, points: 20, shots: 80,  pp_goals: 2, sh_goals: 0, pim: 20, plus_minus: -3 },
      ]
    case 'goalie_seasons':
      return [
        { player_id: GOALIE_ID, team_id: teamB, season_id: season, season_type: 'regular', gp: 30, wins: 17, losses: 9, ot_losses: 4, gaa: 2.61, sv_pct: 0.912, shutouts: 2, saves: 820, goals_against: 79 },
      ]
    case 'shot_events':
      return [
        { game_id: GAME_ID,     team_id: teamA, shooter_id: SKATER_ID,  event_type: 'goal',         period_id: 1, time_seconds: 300,  x_norm: 80.5, y_norm: -10.2 },
        { game_id: GAME_ID,     team_id: teamA, shooter_id: SKATER_ID,  event_type: 'shot',         period_id: 2, time_seconds: 900,  x_norm: -60,  y_norm: 50 },
        { game_id: GAME_ID,     team_id: teamB, shooter_id: GOALIE_ID,  event_type: 'shot',         period_id: 2, time_seconds: 1000, x_norm: 70,   y_norm: 12 },
        { game_id: GAME_ID - 1, team_id: teamA, shooter_id: SKATER2_ID, event_type: 'blocked_shot', period_id: 3, time_seconds: 100,  x_norm: 'n/a', y_norm: 0 },
      ]
    case 'skater_game_box':
      return [
        { game_id: GAME_ID,     player_id: SKATER_ID,  team_id: teamA, season_id: season, goals: 2, assists: 1, points: 3, shots: 5, penalty_minutes: 2, plus_minus: 2 },
        { game_id: GAME_ID - 2, player_id: SKATER2_ID, team_id: teamA, season_id: season, goals: 0, assists: 1, points: 1, shots: 2, penalty_minutes: 0, plus_minus: -1 },
      ]
    case 'goalie_game_box':
      return [
        { game_id: GAME_ID, player_id: GOALIE_ID, team_id: teamB, season_id: season, saves: 30, shots_against: 34, goals_against: 4, toi_seconds: 3600 },
      ]
    default:
      return []
  }
}

const person = (id, firstName, lastName, jerseyNumber = null) => ({ id: String(id), firstName, lastName, jerseyNumber })

function pbpEvents(L) {
  const { teamA, teamB } = L
  const goal = (id, time, period, properties) => ({
    event: 'goal',
    details: {
      game_goal_id: String(id), time, period: { id: period },
      team: { id: String(teamA), abbreviation: 'ahl - HOME' },
      scoredBy: person(SKATER_ID, 'Alex', 'Skater', '19'),
      assists: [person(SKATER2_ID, 'Sam', 'Winger')],
      properties: { isPowerPlay: '0', ...properties },
      plus_players: [person(SKATER2_ID, 'Sam', 'Winger')], minus_players: [],
      xLocation: 150, yLocation: 80,
    },
  })
  return [
    { event: 'shot', details: { time: '1:10', period: { id: '1' }, shooterTeamId: String(teamB), shooter: person(7002, 'Opp', 'Shooter'), goalie: person(7003, 'Home', 'Goalie'), shotType: 'Wrist', shotQuality: 'Quality', isGoal: false, xLocation: 100, yLocation: 50 } },
    goal(1, '4:00', '1', { isPowerPlay: '1' }),
    { event: 'penalty', details: { game_penalty_id: '901', time: '8:00', period: { id: '1' }, againstTeam: { id: String(teamB), abbreviation: 'AWY' }, takenBy: person(7002, 'Opp', 'Shooter'), servedBy: null, minutes: '2.00', description: 'Min-Hooking', isPowerPlay: true, isBench: false } },
    goal(2, '2:00', '2', { isShortHanded: '1' }),
    { event: 'penaltyshot', details: { time: '10:00', period: { id: '2' }, shooter_team: { id: String(teamB) }, shooter: person(7002, 'Opp', 'Shooter'), goalie: person(7003, 'Home', 'Goalie'), isGoal: false } },
    goal(3, '15:00', '3', { isEmptyNet: '1', isGameWinningGoal: '1' }),
    { event: 'goalie_change', details: { time: '18:00', period: { id: '3' }, team_id: String(teamB), goalieComingIn: null, goalieGoingOut: person(GOALIE_ID, 'Gus', 'Keeper') } },
    { event: 'faceoff', details: { time: '0:00', period: { id: '1' } } },
  ]
}

function hockeytechPayload(L, view) {
  const { teamA, teamB } = L
  switch (view) {
    case 'player':
      return [{
        careerStats: [{ sections: [
          { title: 'Regular Season', data: [
            { row: { season_name: '2025-26', team_name: 'Home', games_played: '40', goals: '15' } },
            { row: { season_name: 'Total', team_name: '', games_played: '120', goals: '41', points: '95', shooting_percentage: '12.5' } },
          ] },
          { title: 'Playoffs', data: [{ row: { season_name: 'Total', team_name: '', games_played: '8', goals: '3' } }] },
        ] }],
        draftInfo: [{ sections: [{ title: '', data: [{ row: { draft_team: 'Home', draft_round: '3', draft_year: '2019' } }] }] }],
        gameByGame: [{ sections: [{ title: '', data: Array.from({ length: 7 }, (_, i) => ({ row: { game: `Jan ${i + 1}`, goals: String(i % 2), assists: '1', points: String((i % 2) + 1) } })) }] }],
        info: { display_drafts: true, bio: '<ul><li><p>Captain &amp; leader</p></li><li><p>All-Star in 2025</p></li></ul>' },
        media: { images: [
          { url: 'https://img.example/a.jpg', is_primary: '0', width: '100', height: '100' },
          { url: 'https://img.example/b.jpg', is_primary: '1', width: '240', height: '240' },
        ] },
      }]
    case 'gameSummary':
      return {
        periods: [
          { info: { id: '1', shortName: '1st', longName: '1st Period' }, stats: { homeGoals: '2', homeShots: '12', visitingGoals: '1', visitingShots: '9' },
            goals: [{ game_goal_id: '555', time: '5:00', team: { id: String(teamA), abbreviation: 'ahl - HOME' }, scoredBy: { ...person(SKATER_ID, 'Alex', 'Skater'), playerImageURL: 'https://assets.leaguestat.com/x/120x160/6681.jpg' }, assists: [person(SKATER2_ID, 'Sam', 'Winger')], properties: { isPowerPlay: '1' } }] },
          { info: { id: 'OT' }, stats: {}, goals: [] },
        ],
        mostValuablePlayers: [
          { team: { id: String(teamA), abbreviation: 'HOME', name: 'Home Club' }, player: { info: { ...person(SKATER_ID, 'Alex', 'Skater', '19'), position: 'C', playerImageURL: 'https://assets.leaguestat.com/x/120x160/6681.jpg' }, stats: { goals: 2 } }, isGoalie: false, homeTeam: 1 },
          { team: { id: String(teamB), abbreviation: 'AWY', name: 'Away Club' }, player: { info: { ...person(GOALIE_ID, 'Gus', 'Keeper', '30'), position: 'G' }, stats: { saves: 30 } }, isGoalie: true, homeTeam: 0, playerImage: 'https://img.example/g.jpg' },
        ],
        referees: [{ firstName: 'Ref', lastName: 'One', jerseyNumber: '12' }],
        linesmen: [{ firstName: 'Line', lastName: 'Two', jerseyNumber: null }],
        homeTeam: { coaches: [{ role: 'Assistant Coach', firstName: 'Asst', lastName: 'Home' }, { role: 'Head Coach', firstName: 'Head', lastName: 'Home' }],
          stats: { goals: 4, shots: 34, powerPlayGoals: 1, hits: 0, faceoffAttempts: 0, faceoffWins: 0, faceoffWinPercentage: 0 } },
        visitingTeam: { coaches: [], stats: { goals: 2, shots: 28, hits: 0 } },
        details: { venue: 'Fixture Arena' },
      }
    case 'gameCenterPreview':
      return { homeTeam: { info: { id: String(teamA) } }, visitingTeam: { info: { id: String(teamB) } }, headToHeadRecords: [{ wins: 2 }] }
    case 'gameCenterPlayByPlay':
      return pbpEvents(L)
    default:
      return null
  }
}

function rssXml(feed) {
  return `<?xml version="1.0"?><rss><channel>
<item><title>${feed} headline one</title><link>https://news.example/${feed}/one</link><description><![CDATA[<p>First &amp; story</p>]]></description><pubDate>Wed, 14 Jan 2026 12:00:00 GMT</pubDate></item>
<item><title>${feed} headline two</title><link>https://news.example/${feed}/two</link><description>Second story</description><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`
}

// ── Upstream + KV recording ──────────────────────────────────────────

const okJson = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })
const okText = (text) => ({ ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) })
const FAILED = { ok: false, status: 503, json: async () => ({}), text: async () => '' }

// Routes every fetch() by host: OpenRouter (AI), Supabase REST (by table
// suffix), HockeyTech (by view, JSONP-wrapped like the real feed), and
// anything else is treated as an RSS news source.
function installUpstream(L, { failSupabase = false, failHosts = [], overrides = {} } = {}) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (failHosts.some(h => u.hostname.includes(h))) return FAILED
    if (u.hostname === 'openrouter.ai') {
      return okJson({ choices: [{ message: { content: `Fixture ${L.key.toUpperCase()} narrative.` } }] })
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      if (failSupabase) return FAILED
      const suffix = u.pathname.slice('/rest/v1/'.length).replace(new RegExp(`^${L.key}_`), '')
      return okJson(overrides[suffix] ?? supabaseRows(L, suffix, u.searchParams))
    }
    if (u.hostname === 'lscluster.hockeytech.com') {
      return okText(`(${JSON.stringify(hockeytechPayload(L, u.searchParams.get('view')))})`)
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

async function callRoute(L, env, path, { method = 'GET', body, ctx = makeCtx() } = {}) {
  const full = `/${L.key}${path}`
  const res = await L.handle(makeRequest(full, { method, body }), env, ctx, new URL(`https://example.com${full}`))
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

// ── Route table ───────────────────────────────────────────────────────
// path/missing take the league so ids match its fixtures; `missing` is the
// same route without its required param (400 path). `notCached` marks a
// response the route deliberately doesn't cache (a 404), so a repeat call
// goes upstream again.

const ROUTES = [
  { name: 'standings',                  path: L => `/standings?season=${L.season}` },
  { name: 'standings (playoff season)', path: L => `/standings?season=${L.playoffSeason}` },
  { name: 'standings (default season)', path: () => '/standings' },
  { name: 'schedule',                   path: L => `/schedule?teamId=${L.teamA}&season=${L.season}`, missing: L => `/schedule?season=${L.season}` },
  { name: 'roster',                     path: L => `/roster?teamId=${L.teamA}`, missing: () => '/roster' },
  { name: 'players',                    path: L => `/players?teamId=${L.teamA}&season=${L.season}`, missing: () => '/players' },
  { name: 'league-players',             path: L => `/league-players?season=${L.season}` },
  { name: 'shots',                      path: L => `/shots?teamId=${L.teamA}&season=${L.season}`, missing: () => '/shots' },
  { name: 'team-season-summary',        path: L => `/team-season-summary?teamId=${L.teamA}&season=${L.season}`, missing: () => '/team-season-summary' },
  { name: 'player/landing (skater)',    path: L => `/player/landing?id=${SKATER_ID}&season=${L.season}`, missing: () => '/player/landing' },
  { name: 'player/landing (playoff season)', path: L => `/player/landing?id=${SKATER_ID}&season=${L.playoffSeason}` },
  { name: 'player/landing (goalie, latest season)', path: () => `/player/landing?id=${GOALIE_ID}` },
  { name: 'player/landing (unknown player)', path: () => '/player/landing?id=1', notCached: true },
  { name: 'player/career',              path: () => `/player/career?id=${SKATER_ID}`, missing: () => '/player/career' },
  { name: 'player-shots',               path: L => `/player-shots?playerId=${SKATER_ID}&season=${L.season}`, missing: () => '/player-shots' },
  { name: 'player-game-log',            path: L => `/player-game-log?playerId=${SKATER_ID}&season=${L.season}`, missing: () => '/player-game-log' },
  { name: 'lastgame',                   path: L => `/lastgame?teamId=${L.teamA}&season=${L.season}`, missing: () => '/lastgame' },
  { name: 'summary',                    path: () => `/summary?gameId=${GAME_ID}`, missing: () => '/summary' },
  { name: 'preview',                    path: () => `/preview?gameId=${GAME_ID}`, missing: () => '/preview' },
  { name: 'game-box',                   path: () => `/game-box?gameId=${GAME_ID}`, missing: () => '/game-box' },
  { name: 'prediction',                 path: () => `/prediction?gameId=${GAME_ID}`, missing: () => '/prediction' },
  { name: 'team-seasons/compare',       path: L => `/team-seasons/compare?teamId=${L.teamA}&seasons=${L.season},${L.playoffSeason}`, missing: L => `/team-seasons/compare?teamId=${L.teamA}` },
  { name: 'team-seasons/compare-teams', path: L => `/team-seasons/compare-teams?teamIds=${L.teamA},${L.teamB}&season=${L.season}`, missing: L => `/team-seasons/compare-teams?teamIds=${L.teamA}&season=${L.season}` },
  { name: 'team-seasons/head-to-head',  path: L => `/team-seasons/head-to-head?teamIds=${L.teamA},${L.teamB}`, missing: L => `/team-seasons/head-to-head?teamIds=${L.teamA}` },
  {
    name: 'team-seasons/head-to-head/narrative', method: 'POST', path: () => '/team-seasons/head-to-head/narrative',
    body: L => ({
      teamA: L.teamA, teamB: L.teamB, teamADisplay: 'Home Club', teamBDisplay: 'Away Club', totalMeetings: 3,
      allTimeRecord: { teamAWins: 2, teamBWins: 1 }, recentWindow: { size: 3, teamAWins: 2, teamBWins: 1 },
      currentStreak: { holder: 'A', count: 1 }, isThinSample: true,
    }),
  },
  { name: 'today',                      path: L => `/today?season=${L.season}` },
  { name: 'live/:gameId',               path: () => `/live/${GAME_ID}`, missing: () => '/live/abc' },
  { name: 'unknown route',              path: () => '/no-such-route' },
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

describe.each(LEAGUES)('$key', (L) => {
  it('team code map', () => {
    expect(L.codes).toMatchSnapshot()
  })

  describe.each(ROUTES)('$name', (R) => {
    it('response, upstream requests and KV writes; repeat call', async () => {
      installUpstream(L)
      const { env, kvWrites } = makeRecordingEnv()
      const opts = { method: R.method, body: R.body?.(L) }

      const first = await callRoute(L, env, R.path(L), opts)
      expect({ ...first, upstream: upstreamCalls(), kvWrites }).toMatchSnapshot()

      const callsBefore = globalThis.fetch.mock.calls.length
      const second = await callRoute(L, env, R.path(L), opts)
      expect(second).toEqual(first)
      if (R.notCached) expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(callsBefore)
      else expect(globalThis.fetch.mock.calls.length).toBe(callsBefore)
    })

    it('Supabase unavailable', async () => {
      installUpstream(L, { failSupabase: true })
      const { env } = makeRecordingEnv()
      expect(await callRoute(L, env, R.path(L), { method: R.method, body: R.body?.(L) })).toMatchSnapshot()
    })

    if (R.missing) {
      it('missing required param', async () => {
        installUpstream(L)
        const { env } = makeRecordingEnv()
        const res = await callRoute(L, env, R.missing(L))
        expect({ ...res, upstream: upstreamCalls() }).toMatchSnapshot()
      })
    }
  })

  describe('news', () => {
    it('GET /news with a cold cache returns [] and fetches every source in the background', async () => {
      installUpstream(L)
      const { env, kvWrites } = makeRecordingEnv()
      const ctx = makeCtx()

      const res = await callRoute(L, env, '/news', { ctx })
      await flushWaitUntil(ctx)
      const stored = JSON.parse(await env.CACHE.get(`${L.key}:news`))
      const health = Object.fromEntries(
        [...env.CACHE._store].filter(([k]) => k.startsWith('health:')).map(([k, v]) => [k, JSON.parse(v)])
      )
      expect({ res, upstream: upstreamCalls(), kvWrites, stored, health }).toMatchSnapshot()

      expect(await callRoute(L, env, '/news')).toEqual({ status: 200, body: stored })
    })

    it('fetchNews: a failing source is recorded in health and skipped; cached articles are merged in', async () => {
      installUpstream(L, { failHosts: ['oursportscentral'] })
      const existing = [{ id: 'kept-1', url: 'https://news.example/kept', title: 'Kept', publishedAt: '2026-01-01T00:00:00.000Z' }]
      const { env, kvWrites } = makeRecordingEnv({ [`${L.key}:news`]: existing })

      const merged = await L.fetchNews(env)
      const health = Object.fromEntries(
        [...env.CACHE._store].filter(([k]) => k.startsWith('health:')).map(([k, v]) => [k, JSON.parse(v)])
      )
      expect({ merged, health, kvWrites, upstream: upstreamCalls() }).toMatchSnapshot()
    })

    it('POST /news/bust requires the secret, then clears the cache', async () => {
      const { env, kvWrites } = makeRecordingEnv({ [`${L.key}:news`]: [{ id: 'x' }] })
      const denied = await callRoute(L, env, '/news/bust', { method: 'POST' })
      const busted = await callRoute(L, env, `/news/bust?secret=${SECRET}`, { method: 'POST' })
      expect({ denied, busted, kvWrites, remaining: await env.CACHE.get(`${L.key}:news`) }).toMatchSnapshot()
    })

    it('POST /news/ingest requires the secret, rejects non-arrays, and merges with the cached list', async () => {
      const existing = [
        { id: 'old-1', url: 'https://news.example/a?utm_source=x', title: 'Old A', publishedAt: '2026-01-10T00:00:00.000Z' },
        { id: 'old-2', url: 'https://news.example/b', title: 'Old B', publishedAt: '2026-01-01T00:00:00.000Z' },
      ]
      const { env, kvWrites } = makeRecordingEnv({ [`${L.key}:news`]: existing })
      const incoming = [
        { id: 'new-1', url: 'https://news.example/a', title: 'New A (same link)', publishedAt: '2026-01-14T00:00:00.000Z' },
        { id: 'new-2', url: 'https://news.example/c', title: 'New C', publishedAt: '2026-01-12T00:00:00.000Z' },
      ]
      const denied = await callRoute(L, env, '/news/ingest', { method: 'POST', body: incoming })
      const bad = await callRoute(L, env, `/news/ingest?secret=${SECRET}`, { method: 'POST', body: { not: 'an array' } })
      const ok = await callRoute(L, env, `/news/ingest?secret=${SECRET}`, { method: 'POST', body: incoming })
      const stored = JSON.parse(await env.CACHE.get(`${L.key}:news`))
      expect({ denied, bad, ok, stored, kvWrites }).toMatchSnapshot()
    })
  })

  describe('poll', () => {
    const LEAGUE = L.key.toUpperCase()
    const sub = (endpoint, abbr, extra = {}) => ({ endpoint, keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `${LEAGUE}:${abbr}`, ...extra })
    const subsFor = () => [
      sub('https://push.example/home', L.codes[L.teamA]),
      sub('https://push.example/away', L.codes[L.teamB]),
      sub('https://push.example/away-no-opp-goals', L.codes[L.teamB], { prefs: { oppGoal: false } }),
      { endpoint: 'https://push.example/nhl', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'NHL:CAR' },
    ]
    const liveGame = (overrides = {}) => ({
      game_id: GAME_ID, home_team_id: L.teamA, away_team_id: L.teamB,
      home_score: 3, away_score: 0, game_state: 'In Progress', game_status_code: 2, ...overrides,
    })
    const pushes = () => sendPushMock.mock.calls.map(([s, payload]) => ({ to: s.endpoint, ...payload }))

    it('does nothing in the offseason', async () => {
      vi.setSystemTime(new Date('2026-07-15T16:00:00Z'))
      installUpstream(L)
      const { env } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
      await L.poll(env)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('does nothing without a VAPID private key', async () => {
      installUpstream(L)
      const { env } = makeRecordingEnv({ 'push:subs': subsFor() })
      await L.poll(env)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('live game: start, period, goal, hat-trick, power-play and pulled-goalie pushes; a second poll sends nothing new', async () => {
      installUpstream(L, { overrides: { game_log: [liveGame()] } })
      const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })

      await L.poll(env)
      expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()

      sendPushMock.mockClear()
      await L.poll(env)
      expect(sendPushMock).not.toHaveBeenCalled()
    })

    const finalGame = () => liveGame({ home_score: 4, away_score: 2, game_state: 'Final', game_status_code: 4 })

    it('a game already final the first time it is polled gets no game-over push', async () => {
      installUpstream(L, { overrides: { game_log: [finalGame()] } })
      const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
      await L.poll(env)
      expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()
    })

    it('a game followed live gets exactly one game-over push when it goes final', async () => {
      installUpstream(L, { overrides: { game_log: [liveGame()] } })
      const { env, kvWrites } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
      await L.poll(env)

      installUpstream(L, { overrides: { game_log: [finalGame()] } })
      sendPushMock.mockClear()
      kvWrites.length = 0
      await L.poll(env)
      expect({ upstream: upstreamCalls(), pushes: pushes(), kvWrites }).toMatchSnapshot()

      sendPushMock.mockClear()
      globalThis.fetch.mockClear()
      await L.poll(env)
      expect(sendPushMock).not.toHaveBeenCalled()
      // Only today's schedule is fetched -- no PBP call for a finished game.
      expect(upstreamCalls().map(c => c.url).filter(u => u.includes('hockeytech'))).toEqual([])
    })

    it('prunes subscriptions whose push endpoint has expired', async () => {
      installUpstream(L, { overrides: { game_log: [liveGame()] } })
      sendPushMock.mockImplementation(async (s) => (s.endpoint === 'https://push.example/away' ? 'expired' : 'ok'))
      const { env } = makeRecordingEnv({ 'push:subs': subsFor() }, { VAPID_PRIVATE_KEY: 'k' })
      await L.poll(env)
      const remaining = JSON.parse(await env.CACHE.get('push:subs')).map(s => s.endpoint)
      expect(remaining).toMatchSnapshot()
    })
  })
})
