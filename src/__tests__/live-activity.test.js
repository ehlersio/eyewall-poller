// src/__tests__/live-activity.test.js
// Live Activities for the PWHL, AHL and ECHL (liveActivity.js): the
// HockeyTech ContentState, the multi-league /live-activity routes, and the
// HockeyTech pollers starting, updating and ending them. The NHL's own
// cases stay in nhl-routes.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import { events as pbp1029093, scorebar as realScorebar } from './fixtures/ahl-1029093-pbp.js'

const { sendPushMock, sendLiveActivityPushMock } = vi.hoisted(() => ({
  sendPushMock: vi.fn(),
  sendLiveActivityPushMock: vi.fn(),
}))
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock, sendLiveActivityPush: sendLiveActivityPushMock }
})

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 94, seasonType: 'regular' }),
    getAllAHLSeasons: vi.fn().mockResolvedValue([]),
    resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
    getPWHLScheduleSeasonIds: vi.fn().mockResolvedValue([8]),
  }
})

import {
  LA_TEAM_COLORS, hockeyTechPeriodName, hockeyTechLiveActivityState, handleLiveActivity, startLiveActivities, pushLiveActivities, laKeys,
} from '../liveActivity.js'
import { fetchScorebar, withLiveScorebar, scorebarIntermission, scorebarIntermissionState, hockeyTechNarrativeReady, scorebarLiveFields, deriveGameStatus, endedInFromPlays, hockeyTechPeriodName as sharedPeriodName } from '../shared.js'
import { handleNHL, TEAM_CONFIGS } from '../nhl.js'
import { pollAHL, AHL_TEAM_CODES, AHL_HISTORICAL_TEAM_IDS } from '../ahl.js'
import { ECHL_TEAM_CODES, ECHL_HISTORICAL_TEAM_IDS } from '../echl.js'
import { pollPWHL, PWHL_TEAM_CODES } from '../pwhl.js'

beforeEach(() => {
  sendPushMock.mockReset().mockResolvedValue('ok')
  sendLiveActivityPushMock.mockReset().mockResolvedValue('ok')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const currentAbbrs = (codes, historical) =>
  Object.entries(codes).filter(([id]) => !historical.includes(Number(id))).map(([, abbr]) => abbr).sort()

describe('LA_TEAM_COLORS', () => {
  it('has exactly the poller\'s current teams for every league, by the same abbrs', () => {
    expect(Object.keys(LA_TEAM_COLORS.nhl).sort()).toEqual(Object.keys(TEAM_CONFIGS).sort())
    expect(Object.keys(LA_TEAM_COLORS.pwhl).sort()).toEqual(Object.values(PWHL_TEAM_CODES).sort())
    expect(Object.keys(LA_TEAM_COLORS.ahl).sort()).toEqual(currentAbbrs(AHL_TEAM_CODES, AHL_HISTORICAL_TEAM_IDS))
    expect(Object.keys(LA_TEAM_COLORS.echl).sort()).toEqual(currentAbbrs(ECHL_TEAM_CODES, ECHL_HISTORICAL_TEAM_IDS))
  })
})

// ── ContentState ──────────────────────────────────────────────────────
// The scorebar's rows as the pollers see them: fetchScorebar()'s map laid
// over a game_log row with { withClock: true }.
async function overlaid(sbRow, gameRow) {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ SiteKit: { Scorebar: [sbRow] } }) }))
  const ht = { client: 'ahl', base: 'https://ht.example/feed', key: 'k', siteId: '3', leagueId: '4', headers: {} }
  const [row] = await withLiveScorebar(makeEnv({ CACHE: makeFakeCache({}) }), ht, [gameRow], { withClock: true })
  return row
}
const row1029093 = { game_id: 1029093, home_team_id: 373, away_team_id: 328, home_score: 0, away_score: 0, game_state: 'In Progress', game_status_code: 2 }

describe('hockeyTechPeriodName()', () => {
  it.each([
    ['1', '1st'], ['2', '2nd'], ['3', '3rd'],
    ['OT', 'OT'], ['2OT', '2OT'], ['3OT', '3OT'], // AHL
    ['OT1', 'OT'], ['OT2', '2OT'], ['OT4', '4OT'], // ECHL, PWHL
    ['SO', 'SO'], ['', ''], [null, ''], ['4', ''], ['P1', ''],
  ])('%s -> %s', (raw, label) => {
    expect(hockeyTechPeriodName(raw)).toBe(label)
  })
})

describe('scorebarLiveFields(): /today\'s period, clock and intermission', () => {
  const NONE = { period: null, periodType: null, periodLabel: null, clock: null, inIntermission: false }
  const live = (over) => ({ game_status_code: 2, game_state: 'In Progress', ...over })

  it('is the one hockeyTechPeriodName (re-exported from liveActivity.js)', () => {
    expect(hockeyTechPeriodName).toBe(sharedPeriodName)
  })

  it.each([
    ['1', '15:00', { period: 1, periodType: 'REG', periodLabel: '1st' }],
    ['3', '00:42', { period: 3, periodType: 'REG', periodLabel: '3rd' }],
    ['OT', '04:00', { period: 4, periodType: 'OT', periodLabel: 'OT' }],
    ['OT1', '04:00', { period: 4, periodType: 'OT', periodLabel: 'OT' }],
    ['2OT', '18:09', { period: 5, periodType: 'OT', periodLabel: '2OT' }],
    ['OT2', '04:36', { period: 5, periodType: 'OT', periodLabel: '2OT' }],
    ['OT3', '15:58', { period: 6, periodType: 'OT', periodLabel: '3OT' }],
    ['SO', '00:00', { period: null, periodType: 'SO', periodLabel: 'SO' }],
  ])('live in %s', (name, clock, want) => {
    expect(scorebarLiveFields(live({ period_name_short: name, game_clock: clock, intermission: false }), 'live'))
      .toEqual({ ...want, clock, inIntermission: false })
  })

  it('reports the intermission with the period and clock', () => {
    expect(scorebarLiveFields(live({ period_name_short: '1', game_clock: '00:00' }), 'live'))
      .toEqual({ period: 1, periodType: 'REG', periodLabel: '1st', clock: '00:00', inIntermission: true })
  })

  it('no period or clock on the scorebar: nulls, or the fallback period', () => {
    expect(scorebarLiveFields(live({}), 'live')).toEqual(NONE)
    expect(scorebarLiveFields(live({ period_name_short: 'P1', game_clock: '' }), 'live')).toEqual(NONE)
    expect(scorebarLiveFields(live({}), 'live', { fallbackPeriod: 2 }))
      .toEqual({ period: 2, periodType: 'REG', periodLabel: '2nd', clock: null, inIntermission: false })
    // game_log's numbering past the 3rd is unconfirmed: the number, no type.
    expect(scorebarLiveFields(live({}), 'live', { fallbackPeriod: 4 }))
      .toEqual({ period: 4, periodType: null, periodLabel: null, clock: null, inIntermission: false })
    // The scorebar's period wins over the fallback.
    expect(scorebarLiveFields(live({ period_name_short: '3', game_clock: '10:00' }), 'live', { fallbackPeriod: 2 }).period).toBe(3)
  })

  it('not live: nulls and no intermission, whatever the row says', () => {
    const row = { game_status_code: 4, period_name_short: 'OT', game_clock: '00:13', intermission: true }
    expect(scorebarLiveFields(row, 'final')).toEqual(NONE)
    expect(scorebarLiveFields({ game_status_code: 1, period_name_short: '1', game_clock: '20:00' }, 'pre', { fallbackPeriod: 1 })).toEqual(NONE)
    expect(scorebarLiveFields(null, 'live')).toEqual(NONE)
  })
})

describe('fetchScorebar() period fields', () => {
  it('keeps PeriodNameShort, GameClock and Intermission, but routes only see them with withClock', async () => {
    const live = { ...realScorebar.ahl1029093, GameStatus: '2', GameStatusString: 'In Progress', PeriodNameShort: '2', GameClock: '07:58', Intermission: '1' }
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ SiteKit: { Scorebar: [live] } }) }))
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    const ht = { client: 'ahl', base: 'https://ht.example/feed', key: 'k', siteId: '3', leagueId: '4', headers: {} }
    expect((await fetchScorebar(env, ht))[1029093]).toMatchObject({ period_name_short: '2', game_clock: '07:58', intermission: true })
    const [plain] = await withLiveScorebar(env, ht, [row1029093])
    expect(plain).toEqual({ ...row1029093, game_status_code: 2, game_state: 'In Progress', home_score: 5, away_score: 4, ended_in: null })
    const [clocked] = await withLiveScorebar(env, ht, [row1029093], { withClock: true })
    expect(clocked).toMatchObject({ period_name_short: '2', game_clock: '07:58', intermission: true })
  })
})

describe('fetchScorebar({ fresh }): the pollers\' once-a-minute read', () => {
  const ht = { client: 'ahl', base: 'https://ht.example/feed', key: 'k', siteId: '3', leagueId: '4', headers: { 'User-Agent': 'x' } }
  const sb = (GameClock) => ({ ...realScorebar.ahl1029093, GameStatus: '2', GameStatusString: `${GameClock} 3rd`, PeriodNameShort: '3', GameClock, Intermission: '0' })
  const stale = { 1029093: { game_status_code: 2, game_state: '12:00 3rd', home_score: 5, away_score: 4, ended_in: null, period_name_short: '3', game_clock: '12:00', intermission: false } }

  it('skips the KV copy and the edge cache, then refills the KV copy for the routes', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ SiteKit: { Scorebar: [sb('10:41')] } }) }))
    const env = makeEnv({ CACHE: makeFakeCache({ 'ahl:scorebar': stale }) })
    expect((await fetchScorebar(env, ht))[1029093].game_clock).toBe('12:00') // a route: the KV copy
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect((await fetchScorebar(env, ht, { fresh: true }))[1029093].game_clock).toBe('10:41')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch.mock.calls[0][1]).toEqual({ headers: ht.headers, cf: { cacheTtl: 0 } })
    expect(JSON.parse(await env.CACHE.get('ahl:scorebar'))[1029093].game_clock).toBe('10:41')
    expect((await fetchScorebar(env, ht))[1029093].game_clock).toBe('10:41') // the route now reads it
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the KV copy when HockeyTech fails', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'ahl:scorebar': stale }) })
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }))
    expect(await fetchScorebar(env, ht, { fresh: true })).toEqual(stale)
    globalThis.fetch = vi.fn(async () => { throw new Error('network') })
    expect(await fetchScorebar(env, ht, { fresh: true })).toEqual(stale)
    expect(await fetchScorebar(makeEnv({ CACHE: makeFakeCache({}) }), ht, { fresh: true })).toEqual({})
  })
})

describe('hockeyTechLiveActivityState()', () => {
  const opts = { teamCodes: AHL_TEAM_CODES }

  it('counts shots on goal from the PBP\'s shot events: 31-33, the box score of AHL 1029093', async () => {
    const game = await overlaid(realScorebar.ahl1029093, row1029093)
    const st = hockeyTechLiveActivityState({ ...game, ended_in: 'OT' }, pbp1029093, { ...opts, final: true })
    expect(st).toEqual({
      homeScore: 5, awayScore: 4, periodLabel: 'OT', clock: '00:13', inIntermission: false, status: 'final',
      lastEvent: 'GOAL · CLE · Singleton (1) · OT 4:47',
      strength: null, homeSog: 31, awaySog: 33,
    })
  })

  it('reads a live game part-way: period, clock, intermission, the last penalty', async () => {
    const live = { ...realScorebar.ahl1029093, GameStatus: '2', HomeGoals: '4', VisitorGoals: '4', PeriodNameShort: '3', GameClock: '00:28', Intermission: '0' }
    const game = await overlaid(live, row1029093)
    const upTo = pbp1029093.findIndex(e => e.event === 'penalty' && e.details.time === '19:32') + 1
    const st = hockeyTechLiveActivityState(game, pbp1029093.slice(0, upTo), opts)
    expect(st).toMatchObject({
      homeScore: 4, awayScore: 4, periodLabel: '3rd', clock: '00:28', inIntermission: false, status: 'live',
      lastEvent: 'PEN · CLE · Pinelli · Double minor - High-sticking · 4 min', strength: null,
    })
    const shots = pbp1029093.slice(0, upTo).filter(e => e.event === 'shot')
    expect(st.homeSog).toBe(shots.filter(e => e.details.shooterTeamId === '373').length)
    expect(st.awaySog).toBe(shots.filter(e => e.details.shooterTeamId === '328').length)

    const inter = await overlaid({ ...live, Intermission: '1' }, row1029093)
    expect(hockeyTechLiveActivityState(inter, pbp1029093.slice(0, upTo), opts).inIntermission).toBe(true)
    // ...but never on a final
    expect(hockeyTechLiveActivityState(inter, pbp1029093, { ...opts, final: true }).inIntermission).toBe(false)
  })

  it('a bench minor names no offender, and says who serves it (AHL 1029092, P1 5:41)', () => {
    // Real penalty: BEL "Too many men - Bench minor", takenBy null, served by Blais.
    const bench = { event: 'penalty', details: { period: { id: '1', shortName: '1' }, time: '5:41', againstTeam: { id: 413, abbreviation: 'BEL' }, minutes: '2.00', description: 'Too many men - Bench minor', takenBy: null, servedBy: { id: 8901, firstName: 'Xavier', lastName: 'Blais' }, isBench: true, isPowerPlay: true } }
    const game = { home_team_id: 413, away_team_id: 323, home_score: 1, away_score: 0, period_name_short: '1' }
    expect(hockeyTechLiveActivityState(game, [bench], opts).lastEvent)
      .toBe('PEN · BEL · Too many men - Bench minor · 2 min · served by Blais')
  })

  it('labels finals by how they ended: a shootout left on period OT, multi-OT in each league\'s naming', async () => {
    const final = async (sb, endedIn) => hockeyTechLiveActivityState(
      { ...(await overlaid(sb, { game_id: Number(sb.ID), home_team_id: Number(sb.HomeID), away_team_id: Number(sb.VisitorID), game_status_code: 2 })), ended_in: endedIn },
      null, { final: true }).periodLabel
    expect(await final(realScorebar.ahl1029088, 'SO')).toBe('SO') // PeriodNameShort 'OT', "Final SO"
    expect(await final(realScorebar.ahl1029092, 'SO')).toBe('SO')
    expect(await final(realScorebar.ahl2OT, 'OT')).toBe('2OT')
    expect(await final(realScorebar.echl26586, 'OT')).toBe('2OT')
    expect(await final(realScorebar.pwhl341, 'OT')).toBe('3OT')
  })

  it('has null shots and no last event without a play-by-play, and no made-up period or clock', () => {
    const st = hockeyTechLiveActivityState({ home_team_id: 373, away_team_id: 328, home_score: 0, away_score: 0 }, null, opts)
    expect(st).toEqual({
      homeScore: 0, awayScore: 0, periodLabel: '', clock: '', inIntermission: false, status: 'live',
      lastEvent: null, strength: null, homeSog: null, awaySog: null,
    })
  })
})

// ── Intermission (2026-10-17) ─────────────────────────────────────────
// ECHL 25487 (Greensboro vs Reading, 2026-10-16) sat on the previous
// period at 0:00 through an intermission without INT: the scorebar's
// Intermission flag was never '1'. scorebarIntermission() layers the flag,
// GameStatusString and a run-out clock in a live period.
describe('scorebarIntermission(): the Live Activity\'s INT and the narratives\' period end', () => {
  const opts = { teamCodes: AHL_TEAM_CODES }
  const liveSb = (over) => ({ ...realScorebar.ahl1029093, GameStatus: '2', GameStatusString: 'In Progress', GameStatusStringLong: 'In Progress', Intermission: '0', ...over })
  const la = async (over, laOpts = {}) => hockeyTechLiveActivityState(await overlaid(liveSb(over), row1029093), null, { ...opts, ...laOpts })

  it('the Intermission flag still works on its own', async () => {
    const st = await la({ PeriodNameShort: '2', GameClock: '07:58', Intermission: '1' })
    expect(st).toMatchObject({ inIntermission: true, periodLabel: '2nd', status: 'live' })
  })

  it('a live game whose period clock has run out is in the intermission, flag or not', async () => {
    const st = await la({ PeriodNameShort: '1', GameClock: '00:00' })
    expect(st).toMatchObject({ inIntermission: true, periodLabel: '1st', clock: '00:00', status: 'live' })
    expect((await la({ PeriodNameShort: '3', GameClock: '0:00' })).inIntermission).toBe(true)
    expect((await la({ PeriodNameShort: 'OT1', GameClock: '00:00:00' })).inIntermission).toBe(true) // before a shootout
  })

  it('a running clock is not', async () => {
    expect((await la({ PeriodNameShort: '1', GameClock: '07:58' })).inIntermission).toBe(false)
    expect((await la({ PeriodNameShort: '1', GameClock: '00:01' })).inIntermission).toBe(false)
    expect((await la({ PeriodNameShort: '1', GameClock: '20:00' })).inIntermission).toBe(false)
  })

  it('a shootout has no clock to run out', async () => {
    expect((await la({ PeriodNameShort: 'SO', GameClock: '00:00' })).inIntermission).toBe(false)
  })

  it('GameStatusString saying intermission is enough, whatever the clock', async () => {
    expect((await la({ GameStatusString: '1st Intermission', PeriodNameShort: '1', GameClock: '12:41' })).inIntermission).toBe(true)
  })

  it('never on a final, by GameStatus or by the poller\'s final flag', async () => {
    // The real AHL 1029093 final reads Intermission '0', GameClock '00:13';
    // a regulation final reads 00:00.
    expect((await la({ GameStatus: '4', GameStatusString: 'Final', PeriodNameShort: '3', GameClock: '00:00' })).inIntermission).toBe(false)
    expect((await la({ PeriodNameShort: '3', GameClock: '00:00' }, { final: true })).inIntermission).toBe(false)
    expect(scorebarIntermission({ game_status_code: 4, intermission: true, period_name_short: '3', game_clock: '00:00' })).toBe(false)
  })

  it('not before puck drop, nor without a period or clock', () => {
    expect(scorebarIntermission(null)).toBe(false)
    expect(scorebarIntermission({ game_status_code: 1, period_name_short: '1', game_clock: '00:00' })).toBe(false)
    expect(scorebarIntermission({ game_status_code: 2, game_clock: '00:00' })).toBe(false)
    expect(scorebarIntermission({ game_status_code: 2, period_name_short: '1' })).toBe(false)
    // a row written before game_status_code existed: game_state alone
    expect(scorebarIntermission({ game_state: 'In Progress', period_name_short: '2', game_clock: '00:00' })).toBe(true)
  })

  it('a narrative for period 1 unlocks on the run-out clock, not on a running one', async () => {
    expect(hockeyTechNarrativeReady(await overlaid(liveSb({ PeriodNameShort: '1', GameClock: '00:00' }), row1029093), 1)).toBe(true)
    expect(hockeyTechNarrativeReady(await overlaid(liveSb({ PeriodNameShort: '1', GameClock: '07:58' }), row1029093), 1)).toBe(false)
    expect(hockeyTechNarrativeReady(await overlaid(liveSb({ PeriodNameShort: '1', GameClock: '00:00' }), row1029093), 2)).toBe(false)
  })

  it('an intermission starting is a priority-10 update, not a clock-only one', async () => {
    const update = 'bb'.repeat(32)
    const playing = await la({ PeriodNameShort: '1', GameClock: '00:01' })
    const env = makeEnv({ CACHE: makeFakeCache({ [laKeys.tokens('echl', 25487)]: [update], [laKeys.last('echl', 25487)]: playing }) })
    const inter = await la({ PeriodNameShort: '1', GameClock: '00:00' })
    await pushLiveActivities(env, 'echl', 25487, inter)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
    expect(sendLiveActivityPushMock.mock.calls[0][1]).toMatchObject({ event: 'update', priority: 10, state: { inIntermission: true, clock: '00:00' } })
  })
})

// ── Intermission, as the feeds really show it (2026-10-19) ─────────────
// Rows captured from the live AHL and ECHL scorebars through 2026-10-18's
// afternoon games. The ECHL never sets Intermission; the AHL sets it
// (status 10) minutes after the horn; both put the next period up at 20:00
// several minutes before the puck drops; and both go 3 'Unofficial Final'
// before 4 'Final'.
describe('intermissions and finals from the real scorebar sequences', () => {
  const opts = { teamCodes: AHL_TEAM_CODES }
  // ECHL 25512 (2026-10-18), at 15:47, 16:06 and 16:50 ET.
  const echl = (GameStatusString, PeriodNameShort, GameClock, over = {}) =>
    ({ ...realScorebar.ahl1029093, GameStatus: '2', GameStatusString, GameStatusStringLong: GameStatusString, PeriodNameShort, GameClock, Intermission: '0', ...over })
  const la = async (sb, laOpts = {}) => hockeyTechLiveActivityState(await overlaid(sb, row1029093), null, { ...opts, ...laOpts })

  it('ECHL "20:00 3rd" before the puck drops is the 2nd intermission: "2nd INT", not "3rd · 20:00"', async () => {
    expect(await la(echl('20:00 3rd', '3', '20:00'))).toMatchObject({ periodLabel: '2nd', clock: '00:00', inIntermission: true, status: 'live' })
    expect(await la(echl('20:00 2nd', '2', '20:00'))).toMatchObject({ periodLabel: '1st', clock: '00:00', inIntermission: true })
    expect(await la(echl('20:00 2nd', '2', '20:00:00'))).toMatchObject({ periodLabel: '1st', inIntermission: true })
    // A playoff overtime is put up at 20:00 too: after the 3rd, after OT.
    expect(await la(echl('20:00 1st OT', 'OT1', '20:00'))).toMatchObject({ periodLabel: '3rd', inIntermission: true })
    expect(await la(echl('20:00 2OT', '2OT', '20:00'))).toMatchObject({ periodLabel: 'OT', inIntermission: true })
    expect(scorebarIntermissionState({ game_status_code: 2, period_name_short: '3', game_clock: '20:00' })).toEqual({ after: 2, preset: true })
  })

  it('once the clock runs it is the period again', async () => {
    expect(await la(echl('19:59 3rd', '3', '19:59'))).toMatchObject({ periodLabel: '3rd', clock: '19:59', inIntermission: false })
    expect(await la(echl('18:35 3rd', '3', '18:35'))).toMatchObject({ periodLabel: '3rd', clock: '18:35', inIntermission: false })
  })

  it('"00:00 2nd" then "20:00 3rd" is one intermission: the same state, so no push', async () => {
    const update = 'bb'.repeat(32)
    const atHorn = await la(echl('00:00 2nd', '2', '00:00'))
    const preset = await la(echl('20:00 3rd', '3', '20:00'))
    expect(preset).toEqual(atHorn)
    const env = makeEnv({ CACHE: makeFakeCache({ [laKeys.tokens('echl', 25512)]: [update], [laKeys.last('echl', 25512)]: atHorn }) })
    await pushLiveActivities(env, 'echl', 25512, preset)
    expect(sendLiveActivityPushMock).not.toHaveBeenCalled()
  })

  it('period 1 at 20:00 while live is the opening faceoff, not an intermission', async () => {
    expect(await la(echl('20:00 1st', '1', '20:00'))).toMatchObject({ periodLabel: '1st', clock: '20:00', inIntermission: false })
    expect(scorebarIntermission({ game_status_code: 2, period_name_short: '1', game_clock: '20:00:00' })).toBe(false)
  })

  it('ECHL "00:00 1st" while live is the 1st intermission (every such row came after the 1st was played)', async () => {
    expect(await la(echl('00:00 1st', '1', '00:00'))).toMatchObject({ periodLabel: '1st', clock: '00:00', inIntermission: true })
  })

  it('AHL status 10 "Intermission" is the intermission after the period it shows, countdown clock and all', async () => {
    // AHL 1029166 at 16:40 ET: End of 2nd, the intermission's clock at 04:36.
    const ahl10 = { ...realScorebar.ahl1029093, GameStatus: '10', GameStatusString: 'Intermission', GameStatusStringLong: 'End of 2nd', PeriodNameShort: '2', GameClock: '04:36', Intermission: '1' }
    expect(await la(ahl10)).toMatchObject({ periodLabel: '2nd', clock: '04:36', inIntermission: true, status: 'live' })
    const row = await overlaid(ahl10, row1029093)
    expect(deriveGameStatus(row)).toBe('live')
    expect(scorebarIntermissionState(row)).toEqual({ after: 2, preset: false })
  })

  it('status 3 "Unofficial Final" is final: no "3rd INT" after the horn', async () => {
    const unofficial = { ...realScorebar.ahl1029093, GameStatus: '3', GameStatusString: 'Unofficial Final', GameStatusStringLong: 'Unofficial Final', PeriodNameShort: '3', GameClock: '00:00', Intermission: '0' }
    const row = await overlaid(unofficial, row1029093)
    expect(deriveGameStatus(row)).toBe('final')
    expect(scorebarIntermission(row)).toBe(false)
    expect(scorebarLiveFields(row, deriveGameStatus(row))).toMatchObject({ period: null, inIntermission: false })
    expect(hockeyTechNarrativeReady(row, 'game')).toBe(true)
    // a row from before game_status_code: the string alone
    expect(deriveGameStatus({ game_state: 'Unofficial Final' })).toBe('final')
  })

  it('the shootout and a final are never an intermission, flag or not', async () => {
    expect(await la(echl('SO', 'SO', '00:00', { Intermission: '1' }))).toMatchObject({ periodLabel: 'SO', inIntermission: false })
    expect(scorebarIntermission({ game_status_code: 10, game_state: 'Intermission', period_name_short: 'SO', intermission: true })).toBe(false)
    expect(scorebarIntermission({ game_status_code: 4, period_name_short: '3', game_clock: '20:00' })).toBe(false)
    expect(scorebarIntermission({ game_status_code: 3, period_name_short: '3', game_clock: '00:00', intermission: true })).toBe(false)
  })

  it('/today shows the pre-set intermission as the ended period at 00:00', () => {
    const row = { game_status_code: 2, game_state: '20:00 3rd', period_name_short: '3', game_clock: '20:00', intermission: false }
    expect(scorebarLiveFields(row, 'live')).toEqual({ period: 2, periodType: 'REG', periodLabel: '2nd', clock: '00:00', inIntermission: true })
    const ot = { game_status_code: 2, game_state: '20:00 1st OT', period_name_short: 'OT1', game_clock: '20:00', intermission: false }
    expect(scorebarLiveFields(ot, 'live')).toEqual({ period: 3, periodType: 'REG', periodLabel: '3rd', clock: '00:00', inIntermission: true })
  })

  it('the narrative gate counts the period the intermission follows, not the one put up at 20:00', () => {
    const preset = { game_status_code: 2, period_name_short: '3', game_clock: '20:00', intermission: false }
    expect(hockeyTechNarrativeReady(preset, 1)).toBe(true)
    expect(hockeyTechNarrativeReady(preset, 2)).toBe(true)
    expect(hockeyTechNarrativeReady(preset, 3)).toBe(false)
    const ahl10 = { game_status_code: 10, game_state: 'Intermission', period_name_short: '2', game_clock: '04:36', intermission: true }
    expect(hockeyTechNarrativeReady(ahl10, 2)).toBe(true)
    expect(hockeyTechNarrativeReady(ahl10, 3)).toBe(false)
    const opening = { game_status_code: 2, period_name_short: '1', game_clock: '20:00', intermission: false }
    expect(hockeyTechNarrativeReady(opening, 1)).toBe(false)
    const playing = { game_status_code: 2, period_name_short: '3', game_clock: '12:00', intermission: false }
    expect(hockeyTechNarrativeReady(playing, 2)).toBe(true)
    expect(hockeyTechNarrativeReady(playing, 3)).toBe(false)
  })
})

describe('endedInFromPlays(): OT/SO for an Unofficial Final', () => {
  it('reads the play-by-play: shootout attempts, an overtime period, else regulation', () => {
    expect(endedInFromPlays(pbp1029093)).toBe('OT') // AHL 1029093 ended 4:47 into OT
    const reg = [{ event: 'goal', details: { period: { id: '3', shortName: '3' } } }]
    expect(endedInFromPlays(reg)).toBe(null)
    expect(endedInFromPlays([...reg, { event: 'shot', details: { period: { id: 'OT1', shortName: 'OT1' } } }])).toBe('OT')
    expect(endedInFromPlays([...reg, { event: 'shootout', details: { period: { id: 'OT1' } } }])).toBe('SO')
    expect(endedInFromPlays(null)).toBe(null)
    expect(endedInFromPlays([])).toBe(null)
  })
})

// ── Routes ────────────────────────────────────────────────────────────
const post = (env, path, body) => handleLiveActivity(
  makeRequest(path, { method: 'POST', body: JSON.stringify(body) }), env, new URL(`https://x${path}`))

describe('POST /live-activity/register with a league', () => {
  const token = 'ab'.repeat(32)

  it('keys non-NHL tokens by league, and defaults to the NHL', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    expect(await (await post(env, '/live-activity/register', { gameId: 1029093, token, league: 'AHL' })).json()).toEqual({ ok: true, count: 1 })
    await post(env, '/live-activity/register', { gameId: 341, token, league: 'pwhl' })
    await post(env, '/live-activity/register', { gameId: 2025020700, token })
    expect(JSON.parse(await env.CACHE.get('la:tokens:ahl:1029093'))).toEqual([token])
    expect(JSON.parse(await env.CACHE.get('la:tokens:pwhl:341'))).toEqual([token])
    expect(JSON.parse(await env.CACHE.get('la:tokens:2025020700'))).toEqual([token])
    expect(await env.CACHE.get('la:tokens:1029093')).toBe(null)
  })

  it('rejects an unknown league', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    expect((await post(env, '/live-activity/register', { gameId: 1, token, league: 'khl' })).status).toBe(400)
  })

  it('is routed from handleNHL', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    const res = await handleNHL(makeRequest('/live-activity/register', { method: 'POST', body: JSON.stringify({ gameId: 26586, token, league: 'echl' }) }),
      env, makeCtx(), new URL('https://x/live-activity/register'))
    expect(res.status).toBe(200)
    expect(JSON.parse(await env.CACHE.get('la:tokens:echl:26586'))).toEqual([token])
  })
})

describe('POST /live-activity/start-token with teams', () => {
  const token = 'cd'.repeat(32)
  const list = async (env, key) => JSON.parse(await env.CACHE.get(key) || '[]')

  it('puts one token on every followed team, NHL keys unchanged, others by league', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    const res = await post(env, '/live-activity/start-token', { token, teams: ['nhl:CAR', 'ahl:chi', 'echl:FLA', 'pwhl:MIN'], locale: 'fr' })
    expect(await res.json()).toEqual({ ok: true, teams: ['nhl:CAR', 'ahl:CHI', 'echl:FLA', 'pwhl:MIN'], team: 'CAR' })
    for (const key of ['la:start:CAR', 'la:start:ahl:CHI', 'la:start:echl:FLA', 'la:start:pwhl:MIN']) {
      expect(await list(env, key)).toEqual([{ token, locale: 'fr' }])
    }
    expect(await list(env, 'la:startteams:' + token)).toEqual(['nhl:CAR', 'ahl:CHI', 'echl:FLA', 'pwhl:MIN'])
  })

  it('drops unknown teams, answers team: null without an NHL team, and 400s when none are known', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    const res = await post(env, '/live-activity/start-token', { token, teams: ['ahl:XYZ', 'ahl:CHI', 'echl:IA', 'khl:SKA', 'CAR', 42] })
    // ECHL IA is the historical Iowa Heartlanders, not a current team.
    expect(await res.json()).toEqual({ ok: true, teams: ['ahl:CHI'], team: null })
    expect((await post(env, '/live-activity/start-token', { token, teams: ['ahl:XYZ'] })).status).toBe(400)
    expect((await post(env, '/live-activity/start-token', { token, teams: [] })).status).toBe(400)
  })

  it('takes the token off teams no longer listed, and off all of them when disabled', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    await post(env, '/live-activity/start-token', { token, teams: ['nhl:CAR', 'ahl:CHI', 'pwhl:MIN'] })
    await post(env, '/live-activity/start-token', { token, teams: ['ahl:CHI', 'echl:FLA'] })
    expect(await list(env, 'la:start:CAR')).toEqual([])
    expect(await list(env, 'la:start:pwhl:MIN')).toEqual([])
    expect(await list(env, 'la:start:ahl:CHI')).toEqual([{ token, locale: 'en' }])
    expect(await list(env, 'la:start:echl:FLA')).toEqual([{ token, locale: 'en' }])

    const off = await post(env, '/live-activity/start-token', { token, teams: ['ahl:CHI'], enabled: false })
    expect(await off.json()).toEqual({ ok: true, teams: [], team: null })
    expect(await list(env, 'la:start:ahl:CHI')).toEqual([])
    expect(await list(env, 'la:start:echl:FLA')).toEqual([])
  })

  it('reads an old build\'s team as nhl:TEAM, and moves a token off its legacy single team', async () => {
    const other = 'ef'.repeat(32)
    const env = makeEnv({ CACHE: makeFakeCache({
      [`la:startteam:${token}`]: 'BOS',
      'la:start:BOS': [{ token, locale: 'en' }, { token: other, locale: 'en' }],
    }) })
    const res = await post(env, '/live-activity/start-token', { token, team: 'car' })
    expect(await res.json()).toEqual({ ok: true, teams: ['nhl:CAR'], team: 'CAR' })
    expect(await list(env, 'la:start:BOS')).toEqual([{ token: other, locale: 'en' }])
    expect(await list(env, 'la:start:CAR')).toEqual([{ token, locale: 'en' }])
    expect(await env.CACHE.get(`la:startteam:${token}`)).toBe('null')

    // The new build then sends its whole list: the NHL team stays put.
    await post(env, '/live-activity/start-token', { token, teams: ['nhl:CAR', 'ahl:CHI'] })
    expect(await list(env, 'la:start:CAR')).toEqual([{ token, locale: 'en' }])
    expect(await list(env, 'la:start:ahl:CHI')).toEqual([{ token, locale: 'en' }])
  })
})

describe('startLiveActivities() for a HockeyTech league', () => {
  it('sends the league\'s attributes and colours, once per token per game, a token on both teams once', async () => {
    const a = 'aa'.repeat(32), b = 'bb'.repeat(32)
    const env = makeEnv({ CACHE: makeFakeCache({
      'la:start:ahl:CLE': [{ token: a, locale: 'en' }],
      'la:start:ahl:GR': [{ token: a, locale: 'en' }, { token: b, locale: 'fr' }],
      'la:start:GR': [{ token: 'cc'.repeat(32), locale: 'en' }], // not an NHL team; never read
      [`la:startteams:${a}`]: ['ahl:CLE', 'ahl:GR'],
      [`la:startteams:${b}`]: ['ahl:GR'],
    }) })
    const state = { homeScore: 0, awayScore: 0 }
    await startLiveActivities(env, 'ahl', { gameId: 1029093, homeAbbr: 'CLE', awayAbbr: 'GR' }, state)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(2)
    expect(sendLiveActivityPushMock.mock.calls[0]).toEqual([a, expect.objectContaining({
      event: 'start', state, attributesType: 'GameActivityAttributes',
      attributes: { gameId: 1029093, homeAbbr: 'CLE', awayAbbr: 'GR', homeColor: '#1B87D4', awayColor: '#EC3D58', followAbbr: 'CLE', league: 'ahl' },
      alert: expect.objectContaining({ title: 'GR @ CLE' }),
    }), env])
    expect(sendLiveActivityPushMock.mock.calls[1][0]).toBe(b)
    expect(sendLiveActivityPushMock.mock.calls[1][1].attributes.followAbbr).toBe('GR')
    expect(JSON.parse(await env.CACHE.get(laKeys.started('ahl', 1029093))).sort()).toEqual([a, b])

    await startLiveActivities(env, 'ahl', { gameId: 1029093, homeAbbr: 'CLE', awayAbbr: 'GR' }, state)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(2)
  })

  // 2026-10-13: the owner's token sat on `la:start:PIT` while its record
  // said ["nhl:CAR", "pwhl:MTL"], and a PIT @ CHI activity was started on
  // their phone. The list is an index; the record decides.
  describe('a token whose record no longer follows the team', () => {
    const a = 'aa'.repeat(32), b = 'bb'.repeat(32), c = 'cc'.repeat(32)
    const game = { gameId: 2026020123, homeAbbr: 'PIT', awayAbbr: 'CHI' }
    const state = { homeScore: 0, awayScore: 0 }
    const list = async (env, key) => JSON.parse(await env.CACHE.get(key) || '[]')

    it('is skipped and taken off the list when its record names other teams', async () => {
      const env = makeEnv({ CACHE: makeFakeCache({
        'la:start:PIT': [{ token: a, locale: 'en' }, { token: b, locale: 'en' }],
        [`la:startteams:${a}`]: ['nhl:CAR', 'pwhl:MTL'],
        [`la:startteams:${b}`]: ['nhl:PIT'],
      }) })
      await startLiveActivities(env, 'nhl', game, state)
      expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
      expect(sendLiveActivityPushMock.mock.calls[0][0]).toBe(b)
      expect(await list(env, 'la:start:PIT')).toEqual([{ token: b, locale: 'en' }])
      expect(await list(env, laKeys.started('nhl', game.gameId))).toEqual([b])
    })

    it('is pruned when it has no record at all, and a league-scoped record must name the league', async () => {
      const env = makeEnv({ CACHE: makeFakeCache({
        'la:start:pwhl:MIN': [{ token: a, locale: 'fr' }, { token: b, locale: 'en' }, { token: c, locale: 'en' }],
        [`la:startteams:${b}`]: ['nhl:MIN'], // the NHL's Wild, not the PWHL's Frost
        [`la:startteams:${c}`]: ['pwhl:MIN'],
      }) })
      await startLiveActivities(env, 'pwhl', { gameId: 300, homeAbbr: 'MIN', awayAbbr: 'TOR' }, state)
      expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
      expect(sendLiveActivityPushMock.mock.calls[0][0]).toBe(c)
      expect(await list(env, 'la:start:pwhl:MIN')).toEqual([{ token: c, locale: 'en' }])
    })

    it('leaves a list alone, and starts nobody, when every token on it is stale', async () => {
      const env = makeEnv({ CACHE: makeFakeCache({
        'la:start:PIT': [{ token: a, locale: 'en' }],
        [`la:startteams:${a}`]: ['nhl:CAR'],
      }) })
      await startLiveActivities(env, 'nhl', game, state)
      expect(sendLiveActivityPushMock).not.toHaveBeenCalled()
      expect(await list(env, 'la:start:PIT')).toEqual([])
      expect(await env.CACHE.get(laKeys.started('nhl', game.gameId))).toBeNull()
    })

    it('still honours a pre-2026-10 single-team record, and prunes a stale token next to a dead one', async () => {
      const env = makeEnv({ CACHE: makeFakeCache({
        'la:start:PIT': [{ token: a, locale: 'en' }, { token: b, locale: 'en' }, { token: c, locale: 'en' }],
        [`la:startteam:${a}`]: 'PIT', // legacy record, never re-registered
        [`la:startteams:${b}`]: ['nhl:CHI'],
        [`la:startteams:${c}`]: ['nhl:PIT'],
      }) })
      sendLiveActivityPushMock.mockResolvedValueOnce('ok').mockResolvedValueOnce('expired')
      await startLiveActivities(env, 'nhl', game, state)
      expect(sendLiveActivityPushMock.mock.calls.map(c => c[0])).toEqual([a, c])
      // b (stale record) and c (Apple says expired) are both gone; a stays.
      expect(await list(env, 'la:start:PIT')).toEqual([{ token: a, locale: 'en' }])
    })
  })
})

// ── The pollers ───────────────────────────────────────────────────────
const jsonp = (data) => ({ ok: true, status: 200, text: async () => `(${JSON.stringify(data)})`, json: async () => data })
const rows = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })

function installFetch({ table, gameRow, scorebar, pbp }) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (u.pathname === `/rest/v1/${table}`) return rows([gameRow])
    if (u.pathname.startsWith('/rest/v1/')) return rows([])
    const view = u.searchParams.get('view')
    if (view === 'scorebar') return rows({ SiteKit: { Scorebar: scorebar } })
    if (view === 'gameCenterPlayByPlay') return jsonp(pbp)
    return rows({})
  })
}

describe('pollAHL: a game\'s Live Activities start, update and end', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T21:00:00Z'))
  })

  it('AHL 1029093 replayed: started for CLE\'s follower, updated, then ended once with the final', async () => {
    const start = 'aa'.repeat(32), update = 'bb'.repeat(32)
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'la:start:ahl:CLE': [{ token: start, locale: 'en' }], [`la:startteams:${start}`]: ['ahl:CLE'] }) })
    const tick = async (sb, gameRow, n) => {
      await env.CACHE.delete('ahl:scorebar') // the scorebar's 60 s cache, between minutes
      installFetch({ table: 'ahl_game_log', gameRow, scorebar: [sb], pbp: pbp1029093.slice(0, n) })
      await pollAHL(env)
    }
    const liveSb = (over) => ({ ...realScorebar.ahl1029093, GameStatus: '2', GameStatusString: 'In Progress', GameStatusStringLong: 'In Progress', ...over })

    // First period, after the opening goal.
    const firstGoal = pbp1029093.findIndex(e => e.event === 'goal') + 1
    await tick(liveSb({ HomeGoals: '1', VisitorGoals: '0', PeriodNameShort: '1', GameClock: '06:55' }), row1029093, firstGoal)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
    expect(sendLiveActivityPushMock.mock.calls[0][0]).toBe(start)
    expect(sendLiveActivityPushMock.mock.calls[0][1]).toMatchObject({
      event: 'start',
      attributes: { gameId: 1029093, homeAbbr: 'CLE', awayAbbr: 'GR', followAbbr: 'CLE', league: 'ahl' },
      state: { homeScore: 1, awayScore: 0, periodLabel: '1st', clock: '06:55', status: 'live', lastEvent: 'GOAL · CLE · Buckberger (1) · 1st 13:05', strength: null },
    })

    // The app reports the started activity's update token.
    await post(env, '/live-activity/register', { gameId: 1029093, token: update, league: 'ahl' })
    await tick(liveSb({ HomeGoals: '1', VisitorGoals: '0', PeriodNameShort: '1', GameClock: '00:00', Intermission: '1' }), row1029093, firstGoal + 2)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(2) // no second start
    expect(sendLiveActivityPushMock.mock.calls[1]).toEqual([update, expect.objectContaining({
      event: 'update', priority: 10, state: expect.objectContaining({ inIntermission: true, clock: '00:00' }),
    }), env])

    // Final: the pipeline hasn't marked game_log final yet; the scorebar has.
    await tick(realScorebar.ahl1029093, row1029093, pbp1029093.length)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(3)
    expect(sendLiveActivityPushMock.mock.calls[2]).toEqual([update, expect.objectContaining({
      event: 'end', priority: 10,
      state: {
        homeScore: 5, awayScore: 4, periodLabel: 'OT', clock: '00:13', inIntermission: false, status: 'final',
        lastEvent: 'GOAL · CLE · Singleton (1) · OT 4:47', strength: null, homeSog: 31, awaySog: 33,
      },
    }), env])

    // Next minutes: nothing more.
    await tick(realScorebar.ahl1029093, { ...row1029093, home_score: 5, away_score: 4, game_state: 'Final', game_status_code: 4 }, pbp1029093.length)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(3)
  })

  it('ends an activity with the scorebar\'s period when game_log already says final', async () => {
    const update = 'bb'.repeat(32)
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({
      'ahl:push:state:1029093': { homeScore: 4, awayScore: 4, eventCount: 90, started: true, period: 4, scorerGoalCounts: {} },
      'la:tokens:ahl:1029093': [update],
    }) })
    const finalRow = { ...row1029093, home_score: 5, away_score: 4, game_state: 'Final', game_status_code: 4 }
    installFetch({ table: 'ahl_game_log', gameRow: finalRow, scorebar: [realScorebar.ahl1029093], pbp: pbp1029093 })
    await pollAHL(env)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
    expect(sendLiveActivityPushMock.mock.calls[0][1]).toMatchObject({
      event: 'end', state: { status: 'final', periodLabel: 'OT', clock: '00:13', homeScore: 5, awayScore: 4, homeSog: 31, awaySog: 33 },
    })
  })

  it('sends nothing for a game with no activity and no followers', async () => {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({}) })
    installFetch({ table: 'ahl_game_log', gameRow: row1029093, scorebar: [{ ...realScorebar.ahl1029093, GameStatus: '2' }], pbp: pbp1029093.slice(0, 10) })
    await pollAHL(env)
    expect(sendLiveActivityPushMock).not.toHaveBeenCalled()
  })
})

describe('pollAHL: the scorebar each tick, and an Unofficial Final', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T21:00:00Z'))
  })
  const liveSb = (over) => ({ ...realScorebar.ahl1029093, GameStatus: '2', GameStatusString: 'In Progress', GameStatusStringLong: 'In Progress', Intermission: '0', ...over })
  const scorebarReads = () => globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('view=scorebar') && String(u).includes('numberofdaysback=1'))

  it('reads the scorebar fresh every tick, not the 60 s KV copy, and leaves it in KV for the routes', async () => {
    const update = 'bb'.repeat(32)
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({
      'ahl:push:state:1029093': { homeScore: 4, awayScore: 4, eventCount: 0, started: true, period: 3, scorerGoalCounts: {} },
      'la:tokens:ahl:1029093': [update],
      // what a route cached a few seconds ago
      'ahl:scorebar': { 1029093: { game_status_code: 2, game_state: 'In Progress', home_score: 4, away_score: 4, ended_in: null, period_name_short: '3', game_clock: '02:10', intermission: false } },
    }) })
    installFetch({ table: 'ahl_game_log', gameRow: row1029093, scorebar: [liveSb({ HomeGoals: '4', VisitorGoals: '4', PeriodNameShort: '3', GameClock: '01:05' })], pbp: pbp1029093.slice(0, 20) })
    await pollAHL(env)
    expect(scorebarReads()).toHaveLength(1)
    expect(scorebarReads()[0][1]).toMatchObject({ cf: { cacheTtl: 0 } })
    expect(sendLiveActivityPushMock.mock.calls[0][1].state).toMatchObject({ periodLabel: '3rd', clock: '01:05' })
    expect(JSON.parse(await env.CACHE.get('ahl:scorebar'))[1029093].game_clock).toBe('01:05')

    // Next minute: fresh again, though the KV copy is still within its 60 s.
    installFetch({ table: 'ahl_game_log', gameRow: row1029093, scorebar: [liveSb({ HomeGoals: '4', VisitorGoals: '4', PeriodNameShort: '3', GameClock: '00:12' })], pbp: pbp1029093.slice(0, 20) })
    await pollAHL(env)
    expect(scorebarReads()).toHaveLength(1)
    expect(sendLiveActivityPushMock.mock.calls[1][1].state).toMatchObject({ clock: '00:12' })
  })

  it('status 3 ends the activity once with OT from the play-by-play; status 4 after it sends nothing', async () => {
    const update = 'bb'.repeat(32)
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', SUPABASE_SERVICE_KEY: 'svc', CACHE: makeFakeCache({
      'ahl:push:state:1029093': { homeScore: 4, awayScore: 4, eventCount: 0, started: true, period: 4, scorerGoalCounts: {} },
      'ahl:push:start:1029093': true,
      'la:tokens:ahl:1029093': [update],
    }) })
    const patches = () => globalThis.fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').map(([, o]) => JSON.parse(o.body))
    // 'Unofficial Final' says nothing of OT; the period and clock are frozen at the winning goal.
    const unofficial = { ...realScorebar.ahl1029093, GameStatus: '3', GameStatusString: 'Unofficial Final', GameStatusStringLong: 'Unofficial Final' }
    installFetch({ table: 'ahl_game_log', gameRow: row1029093, scorebar: [unofficial], pbp: pbp1029093 })
    await pollAHL(env)
    const ends = () => sendLiveActivityPushMock.mock.calls.filter(([, o]) => o.event === 'end')
    expect(ends()).toHaveLength(1)
    expect(ends()[0][1].state).toMatchObject({ status: 'final', periodLabel: 'OT', inIntermission: false, homeScore: 5, awayScore: 4 })
    expect(patches()).toEqual([{ home_score: 5, away_score: 4, game_state: 'Final', game_status_code: 4, ended_in: 'OT' }])
    expect(await env.CACHE.get('ahl:push:final:1029093')).toBe('true')

    // Minutes later HockeyTech makes it official.
    installFetch({ table: 'ahl_game_log', gameRow: row1029093, scorebar: [realScorebar.ahl1029093], pbp: pbp1029093 })
    await pollAHL(env)
    expect(ends()).toHaveLength(1)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
    expect(patches()).toEqual([])
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('gameCenterPlayByPlay'))).toBe(false)
  })
})

describe('pollPWHL: Live Activities', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-15T23:30:00Z'))
  })

  it('starts for a follower of either team, pushes updates, and ends once at the final', async () => {
    const start = 'aa'.repeat(32), update = 'bb'.repeat(32)
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'la:start:pwhl:TOR': [{ token: start, locale: 'fr' }], [`la:startteams:${start}`]: ['pwhl:TOR'] }) })
    const gameRow = { game_id: 300, home_team_id: 1, away_team_id: 6, home_score: 0, away_score: 0, game_state: 'In Progress', game_status_code: 2 }
    const sb = (over) => ({ ID: '300', HomeGoals: '0', VisitorGoals: '1', GameStatus: '2', GameStatusString: 'In Progress', PeriodNameShort: '2', GameClock: '11:20', Intermission: '0', ...over })
    const pbp = [
      { event: 'shot', details: { shooterTeamId: '6', period: { id: '1', shortName: '1' }, time: '3:00', isGoal: false } },
      { event: 'shot', details: { shooterTeamId: '6', period: { id: '2', shortName: '2' }, time: '5:00', isGoal: true } },
      { event: 'goal', details: { team: { id: 6 }, period: { id: '2', shortName: '2' }, time: '5:00', scorerGoalNumber: '4', scoredBy: { id: 9, firstName: 'Sarah', lastName: 'Nurse' } } },
      { event: 'shot', details: { shooterTeamId: '1', period: { id: '2', shortName: '2' }, time: '8:40', isGoal: false } },
    ]
    const tick = async (sbRow, row) => {
      await env.CACHE.delete('pwhl:scorebar')
      installFetch({ table: 'pwhl_game_log', gameRow: row, scorebar: [sbRow], pbp })
      await pollPWHL(env)
    }
    await tick(sb(), gameRow)
    expect(sendLiveActivityPushMock.mock.calls[0]).toEqual([start, expect.objectContaining({
      event: 'start',
      attributes: { gameId: 300, homeAbbr: 'BOS', awayAbbr: 'TOR', homeColor: '#3DA58A', awayColor: '#3579FF', followAbbr: 'TOR', league: 'pwhl' },
      state: { homeScore: 0, awayScore: 1, periodLabel: '2nd', clock: '11:20', inIntermission: false, status: 'live', lastEvent: 'GOAL · TOR · Nurse (4) · 2nd 5:00', strength: null, homeSog: 1, awaySog: 2 },
    }), env])

    await post(env, '/live-activity/register', { gameId: 300, token: update, league: 'pwhl' })
    await tick(sb({ GameClock: '10:50' }), gameRow)
    expect(sendLiveActivityPushMock.mock.calls[1]).toEqual([update, expect.objectContaining({ event: 'update', priority: 10 }), env])
    await tick(sb({ GameClock: '10:20' }), gameRow)
    expect(sendLiveActivityPushMock.mock.calls[2]).toEqual([update, expect.objectContaining({ event: 'update', priority: 5, state: expect.objectContaining({ clock: '10:20' }) }), env])

    const fin = sb({ GameStatus: '4', GameStatusString: 'Final', GameStatusStringLong: 'Final SO', PeriodNameShort: 'OT1', GameClock: '00:00', VisitorGoals: '2' })
    await tick(fin, gameRow)
    await tick(fin, gameRow)
    const ends = sendLiveActivityPushMock.mock.calls.filter(([, o]) => o.event === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0][1].state).toMatchObject({ status: 'final', periodLabel: 'SO', homeScore: 0, awayScore: 2 })
    expect(await env.CACHE.get(laKeys.tokens('pwhl', 300))).toBe(JSON.stringify([update]))
  })

  it('reads the scorebar fresh every tick, past the KV copy', async () => {
    const update = 'bb'.repeat(32)
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({
      'pwhl:push:state:300': { homeScore: 0, awayScore: 1, eventCount: 0, started: true, period: 2, scorerGoalCounts: {} },
      'la:tokens:pwhl:300': [update],
      'pwhl:scorebar': { 300: { game_status_code: 2, game_state: 'In Progress', home_score: 0, away_score: 1, ended_in: null, period_name_short: '2', game_clock: '11:20', intermission: false } },
    }) })
    const gameRow = { game_id: 300, home_team_id: 1, away_team_id: 6, home_score: 0, away_score: 0, game_state: 'In Progress', game_status_code: 2 }
    const pbp = [{ event: 'shot', details: { shooterTeamId: '6', period: { id: '2', shortName: '2' }, time: '5:00', isGoal: false } }]
    installFetch({ table: 'pwhl_game_log', gameRow, scorebar: [{ ID: '300', HomeGoals: '0', VisitorGoals: '1', GameStatus: '2', GameStatusString: 'In Progress', PeriodNameShort: '2', GameClock: '09:58', Intermission: '0' }], pbp })
    await pollPWHL(env)
    const reads = globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('view=scorebar'))
    expect(reads).toHaveLength(1)
    expect(reads[0][1]).toMatchObject({ cf: { cacheTtl: 0 } })
    expect(sendLiveActivityPushMock.mock.calls[0][1].state).toMatchObject({ periodLabel: '2nd', clock: '09:58' })
    expect(JSON.parse(await env.CACHE.get('pwhl:scorebar'))[300].game_clock).toBe('09:58')
  })
})
