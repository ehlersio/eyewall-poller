// src/__tests__/nhl-routes.characterization.test.js
// Characterization ("golden master") tests for handleNHL's routes, written
// before moving nhl.js onto shared.js's route helpers (cachedJson/sbRows).
// Each test snapshots what the code does today -- response status/body,
// every upstream request (URL, Range header, AI prompt), and every KV write
// with its TTL. A refactor must leave these snapshots unchanged; a diff is a
// behavior change to explain in the PR, not a snapshot to update blindly.
// Same approach as the PWHL and AHL/ECHL suites.
//
// nhl-routes.test.js keeps its assertion-style tests (including poll()'s
// push notifications, which this file doesn't cover). This file adds the 16
// routes nothing tested before (/goalie-shots, /team-lines, /game-xg,
// /game-log, /xg-trend, /power-rankings, /game-predictions, /game-summary,
// /player-scouting, /team-skaters, /players-list, /special-teams,
// /draft/rankings, /draft/picks, /draft/order, /player/landing) and pins
// request URLs, cache keys and TTLs for every route.

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
    resolveNHLSeason: vi.fn().mockResolvedValue(20252026),
    resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
  }
})

import { handleNHL } from '../nhl.js'

const SEASON    = 20252026
const PRIOR     = 20242025
const GAME_ID   = 2025020500
const PLAYER_ID = 8478427
const GOALIE_ID = 8481611
const SECRET    = 'test-poll-secret' // makeEnv()'s POLL_SECRET

// ── Fixtures ──────────────────────────────────────────────────────────

const ROOT_TRADE   = '0123456789abcdef'
const NEXT_TRADE   = 'fedcba9876543210'
const ORIGIN_TRADE = 'aaaabbbbccccdddd'
const TRADES = {
  [ROOT_TRADE]:   { trade_id: ROOT_TRADE,   tx_date: '2025-07-01', teams: ['CAR', 'BOS'], via: [], descriptions: ['Acquired F A from BOS for a 2026 2nd.'] },
  [NEXT_TRADE]:   { trade_id: NEXT_TRADE,   tx_date: '2026-01-05', teams: ['BOS', 'TOR'], via: [], descriptions: ['Traded the 2026 2nd to TOR.'] },
  [ORIGIN_TRADE]: { trade_id: ORIGIN_TRADE, tx_date: '2024-06-28', teams: ['CAR', 'MTL'], via: [], descriptions: ['Acquired a 2026 2nd from MTL.'] },
}
const TRADE_ASSETS = [
  { trade_id: ROOT_TRADE, idx: 0, from_team: 'BOS', to_team: 'CAR', asset_type: 'player', player_name: 'Forward A', player_id: 8479000, position: 'C', rights: false, next_trade_id: null },
  { trade_id: ROOT_TRADE, idx: 1, from_team: 'CAR', to_team: 'BOS', asset_type: 'pick', pick_year: 2026, pick_round: 2, pick_conditional: false, pick_original_team: 'MTL', pick_note: 'future', next_trade_id: NEXT_TRADE },
  { trade_id: NEXT_TRADE, idx: 0, from_team: 'BOS', to_team: 'TOR', asset_type: 'pick', pick_year: 2026, pick_round: 2, pick_original_team: 'MTL', pick_note: 'future', next_trade_id: null },
  { trade_id: ORIGIN_TRADE, idx: 0, from_team: 'MTL', to_team: 'CAR', asset_type: 'pick', pick_year: 2026, pick_round: 2, pick_original_team: 'MTL', pick_note: 'future', next_trade_id: ROOT_TRADE },
]

function supabaseRows(table, params) {
  switch (table) {
    case 'player_seasons':
      if (params.get('game_type') === 'eq.3') return [{ player_id: PLAYER_ID, hits: 5, blocked_shots: 2, takeaways: 1, giveaways: 0 }]
      return [
        { player_id: PLAYER_ID, team: 'CAR', war: 3.1, games_played: 40, goals: 18, assists: 22, points: 40, pct_goals: 92, pct_a1: 81, on_ice_gf_pct: 0.56, results_vs_process_diff: 0.02 },
        { player_id: 8480830, team: 'CAR', war: 1.2, games_played: 38, goals: 8, assists: 12, points: 20, pct_goals: 60, pct_a1: 55, on_ice_gf_pct: null, results_vs_process_diff: null },
      ]
    case 'goalie_seasons':
      return [{ player_id: GOALIE_ID, team: 'CAR', games_played: 30, gsax: 12.1, gsax_per60: 0.4, qs_pct: 0.6, qs: 18, ev_sv_pct: 0.925, hd_sv_pct: 0.84, md_sv_pct: 0.9, pk_sv_pct: 0.87, pct_gsax: 88, pct_gsax60: 85, pct_ev_sv: 80, pct_hd_sv: 70, pct_md_sv: 60, pct_pk_sv: 50 }]
    case 'shot_events':
      return [
        { game_id: GAME_ID - 2, team: 'CAR', x: 70, y: -10, event_type: 'goal', period: 1, time_in_period: '04:00', shot_type: 'wrist' },
        { game_id: GAME_ID - 2, team: 'BOS', x: -60, y: 20, event_type: 'shot-on-goal', period: 2, time_in_period: '11:30', shot_type: 'slap' },
      ]
    case 'line_combinations':
      return [{ unit_type: 'F', rank: 1, name_a: 'Aho', name_b: 'Svechnikov', name_c: 'Jarvis', pos_a: 'C', pos_b: 'LW', pos_c: 'RW', toi_secs: 5400, xgf_pct: 0.58 }]
    case 'player_injuries':
      return [{ player_id: 8476882, player_name: 'Some Defenseman', status: 'Day-To-Day', comment: 'Lower body', espn_updated_at: '2026-01-14T18:00:00Z', injury_type: 'Leg', injury_side: 'Left', injury_detail: null, return_date: null }]
    case 'nhl_transactions':
      return [
        { id: 501, tx_date: '2026-01-12', team: 'CAR', description: 'Recalled F Joe Prospect from Chicago (AHL).', categories: ['recall'], primary_category: 'recall', counterparties: [] },
        { id: 502, tx_date: '2026-01-10', team: 'BOS', description: 'Placed D Some Guy on waivers.', categories: ['waivers'], primary_category: 'waivers', counterparties: [] },
      ]
    case 'trades': {
      // /trades/tree: the trade containing nhl_transactions row 501, the
      // trade one of its assets went on to, and the earlier trade that
      // brought in something it sent out.
      if (params.get('source_tx_ids')) return [TRADES[ROOT_TRADE]]
      const ids = (params.get('trade_id') || '').replace(/^in\.\(|\)$/g, '').split(',')
      return ids.filter(id => TRADES[id]).map(id => TRADES[id])
    }
    case 'trade_assets': {
      const next = params.get('next_trade_id')
      if (next) return next === `eq.${ROOT_TRADE}` ? [TRADE_ASSETS.find(a => a.trade_id === ORIGIN_TRADE)] : []
      const ids = (params.get('trade_id') || '').replace(/^in\.\(|\)$/g, '').split(',')
      return TRADE_ASSETS.filter(a => ids.includes(a.trade_id))
    }
    case 'game_scratches':
      return [
        { game_id: GAME_ID - 2, game_date: '2026-01-10', player_id: 8482000, player_name: 'Healthy Scratch', scratch_type: 'healthy' },
        { game_id: GAME_ID - 1, game_date: '2026-01-12', player_id: 8476882, player_name: 'Some Defenseman', scratch_type: 'injured' },
      ]
    case 'game_xg':
      return [
        { game_id: GAME_ID - 2, team: 'CAR', xgf: 3.1, xga: 2.2, xgf_pct: 0.585 },
        { game_id: GAME_ID - 2, team: 'BOS', xgf: 2.2, xga: 3.1, xgf_pct: 0.415 },
      ]
    case 'game_log':
      return [
        { game_id: GAME_ID - 2, season: SEASON, game_date: '2026-01-10', opponent: 'BOS', team_score: 4, opp_score: 2, home_team: true, team_scored_first: true, pp_goals: 1, pp_opps: 3, pk_goals_against: 0, pk_opps: 2, game_type: 2 },
        { game_id: GAME_ID - 1, season: SEASON, game_date: '2026-01-12', opponent: 'BOS', team_score: 1, opp_score: 3, home_team: false, team_scored_first: false, pp_goals: 0, pp_opps: 2, pk_goals_against: 1, pk_opps: 4, game_type: 2 },
      ]
    case 'team_seasons':
      return [
        { team: 'CAR', season: SEASON, games_played: 40, wins: 25, losses: 10, ot_losses: 5, points: 55, goals_for: 130, goals_against: 100, goals_for_pg: 3.25, goals_ag_pg: 2.5, pp_pct: 24.1, pk_pct: 82.3, xgf_pct: 0.55, roster_war_score: 71, corsi_for_pct: 0.54, corsi_for_pct_5v5: 0.55, magic_number: null, tragic_number: null, clinched: false, eliminated: false, hits: 900, penalties: 150 },
        { team: 'BOS', season: SEASON, games_played: 40, wins: 20, losses: 15, ot_losses: 5, points: 45, goals_for: 115, goals_against: 118, goals_for_pg: 2.9, goals_ag_pg: 2.95, pp_pct: null, pk_pct: 79.1, xgf_pct: 0.49, roster_war_score: 60, corsi_for_pct: 0.49, corsi_for_pct_5v5: null, magic_number: null, tragic_number: null, clinched: false, eliminated: false, hits: 1000, penalties: 170 },
      ]
    case 'power_rankings_narratives':
      return [{ narrative: 'Carolina keeps rolling.', rank: 3, prior_rank: 5, generated_date: '2026-01-14' }]
    case 'game_predictions':
      return [{ matchup_text: 'Matchup text.', prediction_text: 'Prediction text.', generated_at: '2026-01-15T12:00:00Z' }]
    case 'game_summaries':
      return [{ summary_text: 'Summary text.', card_text: 'Card text.', generated_at: '2026-01-13T04:00:00Z' }]
    case 'player_scouting':
      return [{ scouting_text: 'Scouting text.', generated_at: '2026-01-10T00:00:00Z' }]
    case 'player_narratives':
      return [{ narrative_text: 'Results vs process text.', generated_at: '2026-01-10T00:00:00Z' }]
    case 'players':
      return [{ id: PLAYER_ID, name: 'Sebastian Aho', position: 'C' }, { id: GOALIE_ID, name: 'Pyotr Kochetkov', position: 'G' }]
    case 'special_teams_units':
      return [
        { team: 'CAR', unit_type: 'PP', unit_number: 1, player_ids: [PLAYER_ID, 8480830] },
        { team: 'CAR', unit_type: 'PK', unit_number: 1, player_ids: [8476882] },
        { team: 'BOS', unit_type: 'PP', unit_number: 2, player_ids: [8477956] },
      ]
    case 'draft_rankings_2026':
      return [
        { category_id: 1, final_rank: 1, name: 'NA Skater One' },
        { category_id: 3, final_rank: 1, name: 'NA Goalie One' },
      ]
    case 'draft_picks_2026':
      return [{ pick_overall: 1, round: 1, team_abbrev: 'SJS', name: 'First Pick' }, { pick_overall: 2, round: 1, team_abbrev: 'CAR', name: 'Second Pick' }]
    case 'draft_pick_order_2026':
      return [{ pick_overall: 1, team_abbrev: 'SJS' }, { pick_overall: 2, team_abbrev: 'CAR' }]
    case 'draft_pick_history':
      return [{ draft_year: 2025, round: 1, pick_in_round: 20, overall_pick: 20, team: 'CAR', original_team: 'CAR', pick_chain: ['CAR'], times_traded: 0, player_id: 8485000, player_name: 'Recent Pick', position: 'D' }]
    case 'playoff_odds':
      return [{ season: SEASON, run_date: '2026-01-15', playoff_pct: 0.91, division_pct: 0.4, proj_points: 104, points_p10: 97, points_p90: 111, current_points: 55, games_played: 40, games_remaining: 42, elo_rating: 1560, sims: 10000, change: null }]
    case 'playoff_odds_game_impacts':
      return [{ game_id: GAME_ID, game_date: '2026-01-16', home_team: 'CAR', away_team: 'BOS', outcome: 'home_win', playoff_pct: 0.93 }]
    case 'team_injury_impact':
      return [{ season: SEASON, team: 'CAR', games_played: 40, man_games_lost: 12, war_lost: 0.8, players_injured: 2, rank_man_games: 20, rank_war_lost: 18, players: [], updated_at: '2026-01-15T08:00:00Z' }]
    case 'goalie_start_probs':
      return [{ team: 'CAR', goalie_id: GOALIE_ID, goalie_name: 'Pyotr Kochetkov', start_prob: 0.7, factors: {}, game_date: '2026-01-16', run_date: '2026-01-15' }]
    case 'projected_lines':
      return [
        { unit_type: 'F', rank: 1, player_ids: [8478427, 8480039, 8481708], names: ['Sebastian Aho', 'Andrei Svechnikov', 'Seth Jarvis'], positions: ['C', 'L', 'R'], filled_ids: [], basis: 'last_game', basis_game_id: GAME_ID - 1, basis_games: 1, generated_at: '2026-01-15T08:00:00Z' },
        { unit_type: 'D', rank: 1, player_ids: [8476958, 8479402], names: ['Jaccob Slavin', 'Jalen Chatfield'], positions: ['D', 'D'], filled_ids: [8479402], basis: 'last_game', basis_game_id: GAME_ID - 1, basis_games: 1, generated_at: '2026-01-15T08:00:00Z' },
      ]
    case 'prediction_scorecard':
      return [{ model: 'game_winner', kind: 'live', period: '2025-26', status: 'ok', n: 500, accuracy: 0.58, brier: 0.24, log_loss: 0.67, baseline: 0.5, calibration: [], recent: [], note: null, updated_at: '2026-01-15T08:00:00Z' }]
    case 'team_elo_ratings':
      return [{ team: 'CAR', rating: 1560 }, { team: 'BOS', rating: 1510 }]
    case 'milestones':
      return [{ id: 1, game_date: '2026-01-12', team: 'CAR', player_name: 'Sebastian Aho', milestone: 'hat_trick', season: String(SEASON) }]
    default:
      return []
  }
}

function nhlSchedule(abbr) {
  return {
    games: [
      { id: GAME_ID - 2, gameDate: '2026-01-10', gameType: 2, gameState: 'OFF', homeTeam: { abbrev: abbr, score: 4 }, awayTeam: { abbrev: 'BOS', score: 2 } },
      { id: GAME_ID - 1, gameDate: '2026-01-12', gameType: 2, gameState: 'FINAL', homeTeam: { abbrev: 'BOS', score: 3 }, awayTeam: { abbrev: abbr, score: 1 } },
      { id: GAME_ID, gameDate: '2026-01-16', gameType: 2, gameState: 'FUT', neutralSite: false, homeTeam: { abbrev: abbr }, awayTeam: { abbrev: 'BOS' } },
    ],
  }
}

function nhlApi(path) {
  const schedule = path.match(/^\/club-schedule-season\/([A-Z]+)\/\d+$/)
  if (schedule) return nhlSchedule(schedule[1])
  if (/^\/roster\/[A-Z]+\/current$/.test(path)) return { forwards: [{ id: PLAYER_ID, firstName: { default: 'Sebastian' } }], defensemen: [], goalies: [{ id: GOALIE_ID }] }
  const landing = path.match(/^\/player\/(\d+)\/landing$/)
  if (landing) return { playerId: Number(landing[1]), firstName: { default: 'Sebastian' }, lastName: { default: 'Aho' }, position: 'C' }
  // /nhl/today asks for an explicit date (and only looks ahead via
  // /schedule/{date} when that date is empty) -- NHL's own /score/now is
  // not "today" out of season. The frozen clock is 2026-01-15 ET.
  const score = path.match(/^\/score\/(\d{4}-\d{2}-\d{2})$/)
  if (score) {
    if (score[1] !== '2026-01-15') return { games: [] }
    return { games: [
      { id: GAME_ID, gameDate: '2026-01-15', gameType: 2, gameState: 'LIVE', homeTeam: { abbrev: 'CAR', score: 2 }, awayTeam: { abbrev: 'BOS', score: 1 },
        periodDescriptor: { number: 2, periodType: 'REG' }, clock: { timeRemaining: '12:34', inIntermission: false } },
      { id: GAME_ID + 1, gameDate: '2026-01-15', gameType: 2, gameState: 'OFF', homeTeam: { abbrev: 'TOR', score: 3 }, awayTeam: { abbrev: 'MTL', score: 4 },
        gameOutcome: { lastPeriodType: 'OT' } },
      { id: GAME_ID + 2, gameDate: '2026-01-15', gameType: 2, gameState: 'FUT', startTimeUTC: '2026-01-16T03:00:00Z', homeTeam: { abbrev: 'EDM' }, awayTeam: { abbrev: 'VAN' } },
    ] }
  }
  if (/^\/schedule\/\d{4}-\d{2}-\d{2}$/.test(path)) {
    return { gameWeek: [{ date: '2026-01-15', numberOfGames: 3 }], nextStartDate: '2026-01-16' }
  }
  if (path.startsWith('/gamecenter/')) return { plays: [] }
  if (path === '/standings/now') return { standings: [] }
  return null
}

const standingRow = (abbr, seasonId, extra = {}) => ({
  seasonId, teamAbbrev: { default: abbr }, gamesPlayed: 40, goalFor: 130, goalAgainst: 100,
  shotsForPerGame: 31.2, shotsAgainstPerGame: 27.5, streakCode: 'W', streakCount: 3,
  wins: 25, losses: 10, otLosses: 5, points: 55, powerPlayPct: 24.1, penaltyKillPct: 82.3, ...extra,
})
const STANDINGS_NOW = [standingRow('CAR', SEASON), standingRow('BOS', SEASON, { goalFor: 115, goalAgainst: 118, streakCode: 'L', streakCount: 1, wins: 20, losses: 15, points: 45, powerPlayPct: null })]
const STANDINGS_LAST_SEASON = STANDINGS_NOW.map(r => ({ ...r, seasonId: PRIOR }))

function rssXml(feed) {
  return `<?xml version="1.0"?><rss><channel>
<item><title>${feed} Hurricanes Canes headline</title><link>https://news.example/${feed}/one</link><description>Canes story</description><pubDate>Wed, 14 Jan 2026 12:00:00 GMT</pubDate></item>
<item><title>${feed} Bruins Boston headline</title><link>https://news.example/${feed}/two</link><description>Bruins story</description><pubDate>Thu, 15 Jan 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`
}

// ── Upstream + KV recording ──────────────────────────────────────────

// fetchNews() logs res.headers.get('content-type'), so every fake has one.
const contentType = (type) => ({ get: (name) => (name.toLowerCase() === 'content-type' ? type : null) })
const okJson = (data) => ({ ok: true, status: 200, headers: contentType('application/json'), json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })
const okText = (text) => ({ ok: true, status: 200, headers: contentType('text/xml'), text: async () => text, json: async () => JSON.parse(text) })
const FAILED = { ok: false, status: 503, headers: contentType(null), json: async () => ({}), text: async () => '' }

// Routes every fetch() by host: OpenRouter (AI), Supabase REST (by table),
// the NHL API (by path), and anything else is treated as an RSS source.
function installUpstream({ failSupabase = false, failHosts = [], overrides = {} } = {}) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (failHosts.some(h => u.hostname.includes(h))) return FAILED
    if (u.hostname === 'openrouter.ai') {
      return okJson({ choices: [{ message: { content: 'Fixture NHL narrative.' } }] })
    }
    if (u.pathname.startsWith('/rest/v1/')) {
      if (failSupabase) return FAILED
      const table = u.pathname.slice('/rest/v1/'.length)
      return okJson(overrides[table] ?? supabaseRows(table, u.searchParams))
    }
    if (u.hostname === 'api-web.nhle.com') {
      const data = nhlApi(u.pathname.replace(/^\/v1/, ''))
      return data == null ? { ...FAILED, status: 404 } : okJson(data)
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
async function callRoute(env, path, { method = 'GET', body, headers, ctx = makeCtx() } = {}) {
  try {
    const res = await handleNHL(makeRequest(path, { method, body, headers }), env, ctx, new URL(`https://example.com${path}`))
    const text = await res.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: res.status, body: parsed }
  } catch (e) {
    return { threw: e.message }
  }
}

// ── Route table ───────────────────────────────────────────────────────
// `missing` is the same route with a missing/invalid param. `notCached`
// marks a response the route deliberately doesn't cache, so a repeat call
// goes upstream again. `overrides` replaces a table's rows; `kv` seeds KV.

const H2H_BODY = {
  teamA: 'CAR', teamB: 'BOS', teamADisplay: 'Carolina Hurricanes', teamBDisplay: 'Boston Bruins', totalMeetings: 3,
  allTimeRecord: { teamAWins: 2, teamBWins: 1 }, recentWindow: { size: 3, teamAWins: 2, teamBWins: 1 },
  currentStreak: { holder: 'A', count: 1 }, isThinSample: true,
}
const NARRATIVE_BODY = {
  carAbbr: 'CAR', oppAbbr: 'BOS', isPlayoff: false, periodLabel: '2nd Period',
  corsiForPct: 56.1, carSOG: 31, oppSOG: 25, carGoals: 4, oppGoals: 2, carHits: 20, carFOPct: 52, carHDCF: 11, oppHDCF: 7,
  penaltyCount: 5, carPenaltyCount: 2, bestPeriod: { period: 2, corsiForPct: 62 }, worstPeriod: { period: 3, corsiForPct: 45 },
  primaryGoalieName: 'Pyotr Kochetkov',
  goals: [
    { isCar: true, scorerName: 'Sebastian Aho', time: '4:00', period: 1, strength: 'pp' },
    { isCar: false, scorerName: 'unknown', time: '12:00', period: 2 },
  ],
}

const ROUTES = [
  { name: 'news/refresh (no secret)',        path: '/news/refresh' },
  { name: 'schedule (historical season)',    path: `/schedule?team=BOS&season=${PRIOR}` },
  { name: 'roster',                          path: '/roster?team=BOS' },
  { name: 'nhl/today',                       path: '/nhl/today' },
  { name: 'player-analytics',                path: `/player-analytics?season=${SEASON}` },
  { name: 'player-analytics (default season)', path: '/player-analytics' },
  { name: 'player-analytics (empty season, prior-season fallback)', path: '/player-analytics', overrides: { player_seasons: [] } },
  { name: 'player-shots',                    path: `/player-shots?playerId=${PLAYER_ID}&team=car`, missing: '/player-shots' },
  { name: 'nhl/shots',                       path: `/nhl/shots?team=CAR&season=${SEASON}` },
  { name: 'goalie-shots',                    path: `/goalie-shots?goalieId=${GOALIE_ID}`, missing: '/goalie-shots' },
  { name: 'goalie-analytics',                path: '/goalie-analytics' },
  { name: 'goalie-analytics (empty season, prior-season fallback)', path: '/goalie-analytics', overrides: { goalie_seasons: [] } },
  { name: 'team-lines',                      path: '/team-lines?team=CAR' },
  { name: 'injuries',                        path: '/injuries?team=CAR' },
  { name: 'transactions (team)',             path: '/transactions?team=CAR', missing: '/transactions?team=car1' },
  { name: 'transactions (league)',           path: '/transactions?scope=league' },
  { name: 'trades/tree',                     path: '/trades/tree?tx=501', missing: '/trades/tree?tx=abc' },
  { name: 'scratches',                       path: '/scratches?team=CAR', missing: '/scratches?gameType=4' },
  { name: 'scratches (explicit season, playoffs)', path: `/scratches?team=CAR&season=${PRIOR}&gameType=3` },
  { name: 'scratches (empty season, prior-season fallback)', path: '/scratches?team=CAR', overrides: { game_scratches: [] } },
  { name: 'game-xg',                         path: `/game-xg?gameId=${GAME_ID - 2}`, missing: '/game-xg' },
  { name: 'game-log',                        path: `/game-log?team=CAR&season=${SEASON}&limit=10` },
  { name: 'game-log (default team, no limit)', path: '/game-log' },
  { name: 'xg-trend',                        path: '/xg-trend?team=CAR' },
  { name: 'team-seasons',                    path: '/team-seasons' },
  { name: 'team-seasons/compare',            path: `/team-seasons/compare?team=CAR&seasons=${SEASON},${PRIOR}`, missing: '/team-seasons/compare?team=CAR' },
  { name: 'team-seasons/compare-teams',      path: `/team-seasons/compare-teams?teams=CAR,BOS&season=${SEASON}`, missing: `/team-seasons/compare-teams?teams=CAR&season=${SEASON}` },
  { name: 'team-seasons/head-to-head',       path: '/team-seasons/head-to-head?teams=CAR,BOS', missing: '/team-seasons/head-to-head?teams=CAR' },
  { name: 'team-seasons/head-to-head/narrative', method: 'POST', path: '/team-seasons/head-to-head/narrative', body: H2H_BODY },
  { name: 'team-seasons/head-to-head/narrative (incomplete body)', method: 'POST', path: '/team-seasons/head-to-head/narrative', body: { teamA: 'CAR' } },
  { name: 'power-rankings',                  path: '/power-rankings?team=CAR&limit=1' },
  { name: 'game-predictions',                path: `/game-predictions?gameId=${GAME_ID}`, missing: '/game-predictions' },
  { name: 'game-summary',                    path: `/game-summary?gameId=${GAME_ID - 1}&team=car&locale=fr`, missing: `/game-summary?gameId=${GAME_ID - 1}` },
  { name: 'player-scouting',                 path: `/player-scouting?playerId=${PLAYER_ID}`, missing: '/player-scouting' },
  { name: 'player-results-vs-process',       path: `/player-results-vs-process?playerId=${PLAYER_ID}&locale=fr`, missing: '/player-results-vs-process' },
  { name: 'team-skaters',                    path: '/team-skaters?team=CAR&gameType=3' },
  { name: 'players-list',                    path: '/players-list' },
  { name: 'special-teams (cold cache)',      path: '/special-teams' },
  { name: 'special-teams (warm cache)',      path: `/special-teams?season=${SEASON}`, kv: { [`pp_units:${SEASON}`]: { CAR: { PP: { 1: [1, 2] }, PK: {} } } } },
  { name: 'special-teams (past season, cold cache)', path: `/special-teams?season=${PRIOR}` },
  { name: 'special-teams (season param ignores another season\'s cache)', path: `/special-teams?season=${PRIOR}`, kv: { [`pp_units:${SEASON}`]: { CAR: { PP: { 1: [1, 2] }, PK: {} } } } },
  { name: 'health',                          path: '/health', kv: { 'live:gameId': GAME_ID, 'live:gameIds': [GAME_ID], 'push:subs': [{ endpoint: 'x' }] } },
  { name: 'poll (no secret)',                path: '/poll' },
  { name: 'social/test (no secret)',         path: '/social/test' },
  { name: 'social/test (preview)',           path: `/social/test?secret=${SECRET}` },
  { name: 'moneypuck/refresh/all (no secret)', path: '/moneypuck/refresh/all' },
  { name: 'atom/ingest (no secret)', method: 'POST', path: '/atom/ingest', body: {} },
  { name: 'atom/ingest (not an object)', method: 'POST', path: `/atom/ingest?secret=${SECRET}`, body: 'null' },
  { name: 'moneypuck/ingest (no secret)', method: 'POST', path: '/moneypuck/ingest', body: 'x' },
  { name: 'moneypuck/ingest (too short)', method: 'POST', path: `/moneypuck/ingest?secret=${SECRET}`, body: 'name,team' },
  { name: 'moneypuck/refresh (no secret)',   path: '/moneypuck/refresh' },
  { name: 'pp-units/refresh (no secret)',    path: '/pp-units/refresh' },
  { name: 'summary/generate (no secret)',    path: '/summary/generate' },
  { name: 'summary/generate (no completed game cached)', path: `/summary/generate?secret=${SECRET}` },
  { name: 'prediction/analyze (in season)',  path: `/prediction/analyze?gameId=${GAME_ID}&team=CAR`, kv: { standings: STANDINGS_NOW } },
  { name: 'prediction/analyze (preseason fallback)', path: `/prediction/analyze?gameId=${GAME_ID}&team=CAR`, kv: { standings: STANDINGS_LAST_SEASON } },
  { name: 'prediction/analyze (force regenerate)', path: `/prediction/analyze?gameId=${GAME_ID}&team=CAR&force=1`, kv: { standings: STANDINGS_NOW }, notCached: true },
  { name: 'prediction/analyze (game not in schedule)', path: '/prediction/analyze?gameId=1&team=CAR', kv: { standings: STANDINGS_NOW } },
  { name: 'prediction/analyze (no gameId)',  path: '/prediction/analyze' },
  { name: 'push/test (no secret)',           path: '/push/test' },
  { name: 'summary/narrative (game)', method: 'POST', path: `/summary/narrative?gameId=${GAME_ID}&period=game&carAbbr=car`, body: NARRATIVE_BODY },
  { name: 'summary/narrative (period)', method: 'POST', path: `/summary/narrative?gameId=${GAME_ID}&period=2&carAbbr=CAR`, body: NARRATIVE_BODY },
  { name: 'summary/narrative (no period)', method: 'POST', path: `/summary/narrative?gameId=${GAME_ID}`, body: NARRATIVE_BODY },
  { name: 'draft/rankings (all)',            path: '/draft/rankings' },
  { name: 'draft/rankings (category)',       path: '/draft/rankings?category=1' },
  { name: 'draft/picks (all)',               path: '/draft/picks' },
  { name: 'draft/picks (full board)',        path: '/draft/picks?team=car&round=1', overrides: { draft_picks_2026: Array.from({ length: 224 }, (_, i) => ({ pick_overall: i + 1 })) } },
  { name: 'draft/order',                     path: '/draft/order' },
  { name: 'draft/order (team)',              path: '/draft/order?team=car' },
  { name: 'draft/pick-history',              path: '/draft/pick-history?team=CAR', missing: '/draft/pick-history?team=C4R' },
  { name: 'playoff-odds',                    path: '/playoff-odds?team=CAR', missing: '/playoff-odds?season=2025' },
  { name: 'playoff-odds (no runs yet)',      path: `/playoff-odds?team=CAR&season=${SEASON}`, overrides: { playoff_odds: [] }, notCached: true },
  { name: 'injury-impact',                   path: '/injury-impact?team=CAR', missing: '/injury-impact?team=CAROLINA' },
  { name: 'injury-impact (no rows yet)',     path: '/injury-impact?team=CAR', overrides: { team_injury_impact: [] }, notCached: true },
  { name: 'probable-starters',               path: `/probable-starters?game=${GAME_ID}`, missing: '/probable-starters?game=123' },
  { name: 'probable-starters (not in the window yet)', path: `/probable-starters?game=${GAME_ID}`, overrides: { goalie_start_probs: [] }, notCached: true },
  { name: 'projected-lines',                 path: '/projected-lines?team=car', missing: '/projected-lines?team=CAROLINA' },
  { name: 'projected-lines (no projection yet)', path: '/projected-lines?team=CAR', overrides: { projected_lines: [] }, notCached: true },
  { name: 'scorecard',                       path: '/scorecard' },
  { name: 'scorecard (empty table)',         path: '/scorecard', overrides: { prediction_scorecard: [] }, notCached: true },
  { name: 'elo/ratings',                     path: '/elo/ratings' },
  { name: 'elo/ratings (empty table)',       path: '/elo/ratings', overrides: { team_elo_ratings: [] }, notCached: true },
  { name: 'milestones',                      path: '/milestones?team=car&limit=5' },
  { name: 'milestones (pwhl)',               path: '/milestones?sport=PWHL' },
  { name: 'player/landing',                  path: `/player/landing?id=${PLAYER_ID}`, missing: '/player/landing' },
  { name: 'draft/analyze (no secret)', method: 'POST', path: '/draft/analyze', body: { prompt: 'x' } },
  { name: 'draft/analyze', method: 'POST', path: '/draft/analyze', headers: { 'X-Poll-Secret': SECRET }, body: { prompt: 'Analyze pick 20.' }, notCached: true },
  { name: 'draft/analyze (no prompt)', method: 'POST', path: '/draft/analyze', headers: { 'X-Poll-Secret': SECRET }, body: {} },
  { name: 'unknown route',                   path: '/no-such-route' },
]

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Fixed mid-season evening (18:30 ET, Jan 15) so dates, "since" years and
  // generatedAt are stable.
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

describe.each(ROUTES)('$name', (R) => {
  const opts = { method: R.method, body: R.body, headers: R.headers }

  it('response, upstream requests and KV writes; repeat call', async () => {
    installUpstream({ overrides: R.overrides })
    const { env, kvWrites } = makeRecordingEnv(R.kv)

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
    const { env, kvWrites } = makeRecordingEnv(R.kv)
    expect({ ...(await callRoute(env, R.path, opts)), kvWrites }).toMatchSnapshot()
  })

  it('NHL API and AI unavailable', async () => {
    installUpstream({ failHosts: ['api-web.nhle.com', 'openrouter'], overrides: R.overrides })
    const { env, kvWrites } = makeRecordingEnv(R.kv)
    expect({ ...(await callRoute(env, R.path, opts)), kvWrites }).toMatchSnapshot()
  })

  if (R.missing) {
    it('missing or invalid param', async () => {
      installUpstream()
      const { env } = makeRecordingEnv(R.kv)
      expect({ ...(await callRoute(env, R.missing, opts)), upstream: upstreamCalls() }).toMatchSnapshot()
    })
  }
})

// The route table's "NHL API and AI unavailable" case stops /prediction/analyze
// at "game not found" (no schedule) before it ever calls the AI -- this one
// takes only the AI down, so the route gets that far.
describe('AI unavailable on its own', () => {
  it.each([
    ['prediction/analyze (in season)', STANDINGS_NOW],
    ['prediction/analyze (preseason fallback)', STANDINGS_LAST_SEASON],
  ])('%s', async (_name, standings) => {
    installUpstream({ failHosts: ['openrouter'] })
    const { env, kvWrites } = makeRecordingEnv({ standings })
    expect({ ...(await callRoute(env, `/prediction/analyze?gameId=${GAME_ID}&team=CAR`)), kvWrites }).toMatchSnapshot()
  })
})

describe('background fetches', () => {
  it('GET /news with a cold cache returns [] and fetches the team\'s sources in the background', async () => {
    installUpstream()
    const { env, kvWrites } = makeRecordingEnv()
    const ctx = makeCtx()

    const res = await callRoute(env, '/news?team=BOS', { ctx })
    await flushWaitUntil(ctx)
    const stored = JSON.parse(await env.CACHE.get('news:BOS'))
    expect({ res, upstream: upstreamCalls(), kvWrites, storedCount: stored.length }).toMatchSnapshot()

    expect(await callRoute(env, '/news?team=BOS')).toEqual({ status: 200, body: stored })
  })

  it('GET /news/refresh with the secret fetches synchronously', async () => {
    installUpstream()
    const { env, kvWrites } = makeRecordingEnv()
    const res = await callRoute(env, `/news/refresh?secret=${SECRET}&team=BOS`)
    expect({ res, kvWrites }).toMatchSnapshot()
  })

  it('GET /schedule for the current season: [] now, cached in the background', async () => {
    installUpstream()
    const { env, kvWrites } = makeRecordingEnv()
    const ctx = makeCtx()

    const res = await callRoute(env, '/schedule?team=BOS', { ctx })
    await flushWaitUntil(ctx)
    expect({ res, upstream: upstreamCalls(), kvWrites }).toMatchSnapshot()

    globalThis.fetch.mockClear()
    const second = await callRoute(env, '/schedule?team=BOS')
    expect(second.body).toHaveLength(3)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('GET /cache/:key serves a hit; a schedule miss is 404 and fills the cache in the background', async () => {
    installUpstream()
    const { env, kvWrites } = makeRecordingEnv({ standings: STANDINGS_NOW })
    const ctx = makeCtx()

    const hit = await callRoute(env, '/cache/standings')
    const miss = await callRoute(env, `/cache/${encodeURIComponent(`schedule:BOS:${PRIOR}`)}`, { ctx })
    const otherMiss = await callRoute(env, '/cache/nothing-here')
    await flushWaitUntil(ctx)
    expect({ hitCount: hit.body.length, miss, otherMiss, upstream: upstreamCalls(), kvWrites }).toMatchSnapshot()
  })
})

describe('push subscriptions', () => {
  it('subscribe upserts Web Push and iOS subscribers; unsubscribe removes them', async () => {
    const { env, kvWrites } = makeRecordingEnv({ 'push:subs': [{ endpoint: 'https://push.example/old', keys: {}, teamAbbr: 'NHL:CAR', prefs: null }] })
    const web = await callRoute(env, '/push/subscribe', { method: 'POST', body: { endpoint: 'https://push.example/old', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'BOS', prefs: { goal: false } } })
    const ios = await callRoute(env, '/push/subscribe', { method: 'POST', body: { platform: 'ios', token: 'tok-1', teamAbbr: 'PWHL:MTL' } })
    const afterSubscribe = JSON.parse(await env.CACHE.get('push:subs'))
    const unsubIos = await callRoute(env, '/push/unsubscribe', { method: 'POST', body: { token: 'tok-1' } })
    const unsubWeb = await callRoute(env, '/push/unsubscribe', { method: 'POST', body: { endpoint: 'https://push.example/old' } })
    expect({ web, ios, afterSubscribe, unsubIos, unsubWeb, kvWrites }).toMatchSnapshot()
  })
})
