// Calder Cup / Kelly Cup brackets (contract C11): hockeytechBracket.js's
// builders and GET /{ahl,echl}/bracket, /{ahl,echl}/bracket/projected, on
// real HockeyTech payloads (fixtures/hockeytech-brackets.js, fetched
// 2026-10-07). The projection is checked by rebuilding the real 2026 first
// rounds from the final 2025-26 division standings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'
import {
  AHL_92_BRACKET, ECHL_76_BRACKET, AHL_90_STANDINGS, ECHL_73_STANDINGS, ECHL_78_STANDINGS, AHL_94_STANDINGS,
} from './fixtures/hockeytech-brackets.js'

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 94, seasonType: 'regular' }),
    resolveECHLSeason: vi.fn().mockResolvedValue({ seasonId: 76, seasonType: 'playoffs' }),
    // Real ids and dates (HockeyTech view=seasons, 2026-10-07).
    getAllAHLSeasons: vi.fn().mockResolvedValue([
      { seasonId: 94, seasonType: 'regular', startYear: 2026, startDate: '2026-10-01' },
      { seasonId: 92, seasonType: 'playoffs', startYear: 2026, startDate: '2026-04-20' },
      { seasonId: 90, seasonType: 'regular', startYear: 2025, startDate: '2025-10-07' },
      { seasonId: 88, seasonType: 'playoffs', startYear: 2025, startDate: '2025-04-21' },
      { seasonId: 86, seasonType: 'regular', startYear: 2024, startDate: '2024-10-09' },
    ]),
    getAllECHLSeasons: vi.fn().mockResolvedValue([
      { seasonId: 78, seasonType: 'regular', startYear: 2026, startDate: '2026-10-15' },
      { seasonId: 77, seasonType: 'preseason', startYear: 2026, startDate: '2026-06-23' },
      { seasonId: 76, seasonType: 'playoffs', startYear: 2026, startDate: '2026-04-21' },
      { seasonId: 73, seasonType: 'regular', startYear: 2025, startDate: '2025-10-15' },
    ]),
  }
})

import { handleAHL } from '../ahl.js'
import { handleECHL } from '../echl.js'
import {
  buildFeedBracket, buildProjectedBracket, divisionSeeds, parseDivisionStandings, playoffFormat, roundNameFromSeries, divisionKey,
} from '../hockeytechBracket.js'

const clone = o => JSON.parse(JSON.stringify(o))
const realFetch = globalThis.fetch
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T16:00:00Z'))
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

const AHL_92 = AHL_92_BRACKET.SiteKit.Brackets
const ECHL_76 = ECHL_76_BRACKET.SiteKit.Brackets
const pairs = series => series.map(s => [s.top.teamId, s.bottom.teamId].sort((a, b) => a - b))

describe('parseDivisionStandings / divisionSeeds', () => {
  it('reads AHL 2025-26 final standings: four divisions in league order, team ids from teamLink', () => {
    const divs = parseDivisionStandings(AHL_90_STANDINGS)
    expect(divs.map(d => [d.division, d.teams.length])).toEqual([['Atlantic', 8], ['North', 7], ['Central', 7], ['Pacific', 10]])
    expect(divs[0].teams[0]).toEqual({ teamId: 309, rank: 1, gp: 72, points: 110, pct: 0.764 })
    const seeds = divisionSeeds(divs)
    expect(seeds[384]).toEqual({ seed: 3, division: 'Atlantic' }) // Charlotte
    expect(seeds[403]).toEqual({ seed: 1, division: 'Pacific' })  // Ontario
  })

  it('reads ECHL division titles without "Division" and the 0-GP table before opening night', () => {
    expect(parseDivisionStandings(ECHL_73_STANDINGS).map(d => d.division)).toEqual(['North', 'South', 'Central', 'Mountain'])
    expect(parseDivisionStandings(ECHL_78_STANDINGS).every(d => d.teams.every(t => t.gp === 0))).toBe(true)
    expect(parseDivisionStandings({})).toEqual([])
    expect(divisionKey('Pacific Division')).toBe('Pacific')
  })
})

describe('roundNameFromSeries', () => {
  it('names AHL rounds from their series names (the AHL feed has no round_name)', () => {
    expect(roundNameFromSeries('Atlantic Division First Round')).toBe('First Round')
    expect(roundNameFromSeries('Pacific Division Semifinals')).toBe('Division Semifinals')
    expect(roundNameFromSeries('North Division Finals')).toBe('Division Finals')
    expect(roundNameFromSeries('Eastern Conference Finals')).toBe('Conference Finals')
    expect(roundNameFromSeries('2026 Calder Cup Finals')).toBe('Calder Cup Finals')
    expect(roundNameFromSeries(undefined)).toBe('')
  })
})

describe('buildFeedBracket -- 2026 Calder Cup Playoffs (AHL 92)', () => {
  const seeds = divisionSeeds(parseDivisionStandings(AHL_90_STANDINGS))
  const bracket = buildFeedBracket(AHL_92, { seeds, format: playoffFormat('ahl', 2026) })

  it('five rounds with the verified series lengths', () => {
    expect(bracket.format).toEqual({ label: '2026 Calder Cup Playoffs', bestOf: [3, 5, 5, 7, 7], source: 'https://theahl.com/qualification-rules' })
    expect(bracket.rounds.map(r => [r.name, r.bestOf, r.series.length])).toEqual([
      ['First Round', 3, 7], ['Division Semifinals', 5, 8], ['Division Finals', 5, 4], ['Conference Finals', 7, 2], ['Calder Cup Finals', 7, 1],
    ])
  })

  it('series sides carry seeds from the final 2025-26 division ranks and the feed\'s wins', () => {
    const a = bracket.rounds[0].series[0]
    expect(a).toMatchObject({
      id: 'A', name: 'Atlantic Division First Round',
      top: { teamId: 384, seed: 3, wins: 1 }, bottom: { teamId: 411, seed: 6, wins: 2 },
      status: 'final', winnerTeamId: 411,
    })
    expect(a.games[0]).toEqual({
      gameId: 1028986, date: '2026-04-22T19:00:00-04:00', home: 384, away: 411,
      homeScore: 8, awayScore: 1, status: 'Final', final: true, ifNecessary: false,
    })
  })

  it('every series is final with the right winner; Toronto won the Cup 4-1 over Chicago', () => {
    for (const r of bracket.rounds) {
      for (const s of r.series) {
        expect(s.status).toBe('final')
        const w = s.top.wins > s.bottom.wins ? s.top.teamId : s.bottom.teamId
        expect(s.winnerTeamId).toBe(w)
      }
    }
    expect(bracket.rounds[4].series[0]).toMatchObject({ top: { teamId: 330, wins: 1 }, bottom: { teamId: 335, wins: 4 }, winnerTeamId: 335 })
  })

  it('without a format, winners still come from later rounds and 4 wins', () => {
    const plain = buildFeedBracket(AHL_92)
    expect(plain.format).toBeNull()
    expect(plain.rounds.map(r => r.bestOf)).toEqual([null, null, null, null, null])
    expect(plain.rounds.flatMap(r => r.series.map(s => s.winnerTeamId)))
      .toEqual(bracket.rounds.flatMap(r => r.series.map(s => s.winnerTeamId)))
    expect(plain.rounds[0].series[0].top.seed).toBeNull()
  })

  it('a series under way is live with no winner; one not started is scheduled with no scores', () => {
    const b = clone(AHL_92)
    const final = b.rounds[4].matchups[0]
    final.games = final.games.slice(0, 3)
    final.team1_wins = 1; final.team2_wins = 2
    final.games.push({ ...final.games[2], game_id: '9999999', status: '1', game_status: '7:00 pm', home_goal_count: '0', visiting_goal_count: '0' })
    const conf = b.rounds[3].matchups[0]
    conf.games = conf.games.map(g => ({ ...g, status: '1', home_goal_count: '0', visiting_goal_count: '0' }))
    conf.team1_wins = 0; conf.team2_wins = 0
    const built = buildFeedBracket(b, { format: playoffFormat('ahl', 2026) })
    const live = built.rounds[4].series[0]
    expect(live).toMatchObject({ status: 'live', winnerTeamId: null, top: { wins: 1 }, bottom: { wins: 2 } })
    expect(live.games[3]).toMatchObject({ gameId: 9999999, homeScore: null, awayScore: null, final: false })
    // The conference final's teams still appear in the Cup final, so it reads as decided;
    // a conference final with no later round reads scheduled.
    b.rounds = b.rounds.slice(0, 4)
    const sched = buildFeedBracket(b).rounds[3].series[0]
    expect(sched).toMatchObject({ status: 'scheduled', winnerTeamId: null })
    expect(sched.games.every(g => g.homeScore === null)).toBe(true)
  })

  it('counts wins from games when the feed has no win totals', () => {
    const b = clone(AHL_92)
    delete b.rounds[0].matchups[0].team1_wins
    delete b.rounds[0].matchups[0].team2_wins
    const s = buildFeedBracket(b).rounds[0].series[0]
    expect([s.top.wins, s.bottom.wins]).toEqual([1, 2])
  })
})

describe('buildFeedBracket -- 2026 Kelly Cup Playoffs (ECHL 76)', () => {
  it('four best-of-7 rounds named by the feed; seeds 1v4/2v3 from the final 2025-26 table', () => {
    const b = buildFeedBracket(ECHL_76, { seeds: divisionSeeds(parseDivisionStandings(ECHL_73_STANDINGS)), format: playoffFormat('echl', 2026) })
    expect(b.rounds.map(r => [r.name, r.bestOf, r.series.length])).toEqual([
      ['Division Semifinals', 7, 8], ['Division Finals', 7, 4], ['Conference Finals', 7, 2], ['Kelly Cup Finals', 7, 1],
    ])
    for (const s of b.rounds[0].series) expect(s.top.seed + s.bottom.seed).toBe(5)
    expect(b.rounds[0].series[0]).toMatchObject({ top: { teamId: 25, seed: 1, wins: 4 }, bottom: { teamId: 17, seed: 4, wins: 1 }, status: 'final', winnerTeamId: 25 })
    expect(b.rounds[3].series[0]).toMatchObject({ top: { teamId: 8 }, bottom: { teamId: 68 }, winnerTeamId: 8 })
  })
})

describe('buildProjectedBracket', () => {
  it('rebuilds the real 2026 Calder Cup first round and byes from the final 2025-26 standings', () => {
    const p = buildProjectedBracket(parseDivisionStandings(AHL_90_STANDINGS), playoffFormat('ahl', 2026))
    expect(p.rounds).toHaveLength(1)
    expect(p.rounds[0].name).toBe('First Round')
    expect(p.rounds[0].bestOf).toBe(3)
    expect(pairs(p.rounds[0].series)).toEqual(pairs(buildFeedBracket(AHL_92).rounds[0].series))
    expect(p.byes.map(b => b.teamId).sort((a, b) => a - b))
      .toEqual([309, 316, 415, 324, 373, 328, 330, 380, 403].sort((a, b) => a - b))
    expect(p.rounds[0].series[0]).toEqual({
      id: 'Atlantic-3v6', name: 'Atlantic First Round', division: 'Atlantic',
      top: { teamId: 384, seed: 3, wins: 0 }, bottom: { teamId: 411, seed: 6, wins: 0 }, status: 'scheduled',
    })
  })

  it('rebuilds the real 2026 Kelly Cup division semifinals (1v4, 2v3) from the final 2025-26 standings', () => {
    const p = buildProjectedBracket(parseDivisionStandings(ECHL_73_STANDINGS), playoffFormat('echl', 2026))
    expect(p.byes).toEqual([])
    expect(pairs(p.rounds[0].series)).toEqual(pairs(buildFeedBracket(ECHL_76).rounds[0].series))
  })

  it('null without a verified format or for a division the format has no rule for', () => {
    expect(playoffFormat('ahl', 2027)).toBeNull()
    expect(buildProjectedBracket(parseDivisionStandings(AHL_94_STANDINGS), null)).toBeNull()
    expect(buildProjectedBracket([{ division: 'Metropolitan', teams: [] }], playoffFormat('ahl', 2026))).toBeNull()
  })
})

// ── Routes ──────────────────────────────────────────────────────────────

const jsonp = obj => `(${JSON.stringify(obj)})`
function mockHockeyTech({ brackets = {}, standings = {}, status = {} } = {}) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url)
    const bm = u.match(/view=brackets&season_id=(\d+)/)
    const sm = u.match(/view=teams&season=(\d+)/)
    const id = bm?.[1] || sm?.[1]
    const kind = bm ? 'brackets' : sm ? 'standings' : 'other'
    const st = status[`${kind}:${id}`] ?? 200
    if (st !== 200) return { ok: false, status: st, json: async () => ({}), text: async () => '' }
    const body = kind === 'brackets'
      ? (brackets[id] ?? { SiteKit: { Brackets: { teams: [], rounds: [], logo: '', show_ties: false } } })
      : kind === 'standings' ? (standings[id] ?? [{ sections: [] }]) : {}
    return { ok: true, status: 200, json: async () => body, text: async () => (kind === 'standings' ? jsonp(body) : JSON.stringify(body)) }
  })
}
const call = (handle, path, env) => handle(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
const fetched = () => globalThis.fetch.mock.calls.map(([u]) => String(u))

describe('GET /ahl/bracket', () => {
  it('the 2026 bracket from the feed, seeded from season 90, cached an hour', async () => {
    const env = makeEnv()
    mockHockeyTech({ brackets: { 92: AHL_92_BRACKET }, standings: { 90: AHL_90_STANDINGS } })
    const res = await call(handleAHL, '/ahl/bracket?season=92', env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.season).toBe(92)
    expect(body.source).toBe('feed')
    expect(body.format.label).toBe('2026 Calder Cup Playoffs')
    expect(body.rounds).toHaveLength(5)
    expect(body.rounds[0].series[0].top).toEqual({ teamId: 384, seed: 3, wins: 1 })
    const [b, s] = fetched()
    expect(b).toContain('feed=modulekit&view=brackets&season_id=92&key=ccb91f29d6744675&client_code=ahl&site_id=3&lang=en')
    expect(s).toContain('feed=statviewfeed&view=teams&season=90&context=overall&groupTeamsBy=division')
    expect(s).toContain('client_code=ahl&site_id=3&league_id=4')
    expect(JSON.parse(await env.CACHE.get('ahl:bracket:92')).rounds).toHaveLength(5)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })

  it('defaults to the latest playoff season that has started (92 on 2026-10-07)', async () => {
    const env = makeEnv()
    mockHockeyTech({ brackets: { 92: AHL_92_BRACKET }, standings: { 90: AHL_90_STANDINGS } })
    expect((await (await call(handleAHL, '/ahl/bracket', env)).json()).season).toBe(92)
  })

  it('a playoff season with no rounds yet: rounds [], uncached', async () => {
    const env = makeEnv()
    mockHockeyTech()
    const res = await call(handleAHL, '/ahl/bracket?season=96', env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ season: 96, format: null, rounds: [], source: 'feed' })
    expect(await env.CACHE.get('ahl:bracket:96')).toBeNull()
  })

  it('still serves the bracket (seeds null) when the standings feed fails', async () => {
    const env = makeEnv()
    mockHockeyTech({ brackets: { 92: AHL_92_BRACKET }, status: { 'standings:90': 500 } })
    const body = await (await call(handleAHL, '/ahl/bracket?season=92', env)).json()
    expect(body.rounds[0].series[0].top).toEqual({ teamId: 384, seed: null, wins: 1 })
  })

  it('502 (uncached) when the bracket feed fails; 400 for a regular season or a bad id', async () => {
    const env = makeEnv()
    mockHockeyTech({ status: { 'brackets:92': 503 } })
    expect((await call(handleAHL, '/ahl/bracket?season=92', env)).status).toBe(502)
    expect(await env.CACHE.get('ahl:bracket:92')).toBeNull()
    expect((await call(handleAHL, '/ahl/bracket?season=90', env)).status).toBe(400)
    expect((await call(handleAHL, '/ahl/bracket?season=9x', env)).status).toBe(400)
  })
})

describe('GET /echl/bracket', () => {
  it('the 2026 Kelly Cup bracket with site_id 0, seeded from season 73', async () => {
    const env = makeEnv()
    mockHockeyTech({ brackets: { 76: ECHL_76_BRACKET }, standings: { 73: ECHL_73_STANDINGS } })
    const body = await (await call(handleECHL, '/echl/bracket', env)).json()
    expect(body.season).toBe(76)
    expect(body.rounds.map(r => r.name)).toEqual(['Division Semifinals', 'Division Finals', 'Conference Finals', 'Kelly Cup Finals'])
    expect(body.rounds[0].series[0].top).toEqual({ teamId: 25, seed: 1, wins: 4 })
    expect(fetched()[0]).toContain('season_id=76&key=2c2b89ea7345cae8&client_code=echl&site_id=0')
  })
})

describe('GET /{league}/bracket/projected', () => {
  it('ECHL default is 2026-27 (season 78): before opening night every team has 0 GP -> no-games, uncached', async () => {
    const env = makeEnv()
    mockHockeyTech({ standings: { 78: ECHL_78_STANDINGS } })
    const res = await call(handleECHL, '/echl/bracket/projected', env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ season: 78, format: null, rounds: [], byes: [], source: 'standings', reason: 'no-games' })
    expect(await env.CACHE.get('echl:bracket:projected:78')).toBeNull()
  })

  it('ECHL 2025-26 (season 73) projects the real 2026 division semifinals, cached an hour', async () => {
    const env = makeEnv()
    mockHockeyTech({ standings: { 73: ECHL_73_STANDINGS } })
    const body = await (await call(handleECHL, '/echl/bracket/projected?season=73', env)).json()
    expect(body.season).toBe(73)
    expect(body.format.label).toBe('2026 Kelly Cup Playoffs')
    expect(pairs(body.rounds[0].series)).toEqual(pairs(buildFeedBracket(ECHL_76).rounds[0].series))
    expect(await env.CACHE.get('echl:bracket:projected:73')).not.toBeNull()
  })

  it('AHL 2026-27 (season 94): the 2027 format is unpublished -> format-unverified, no fetch', async () => {
    const env = makeEnv()
    mockHockeyTech({ standings: { 94: AHL_94_STANDINGS } })
    const body = await (await call(handleAHL, '/ahl/bracket/projected', env)).json()
    expect(body).toEqual({ season: 94, format: null, rounds: [], byes: [], source: 'standings', reason: 'format-unverified' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('AHL 2025-26 (season 90) projects the real 2026 first round with byes', async () => {
    const env = makeEnv()
    mockHockeyTech({ standings: { 90: AHL_90_STANDINGS } })
    const body = await (await call(handleAHL, '/ahl/bracket/projected?season=90', env)).json()
    expect(body.rounds[0].series).toHaveLength(7)
    expect(body.byes).toHaveLength(9)
  })

  it('502 when the standings feed fails; 400 for a playoff season id', async () => {
    const env = makeEnv()
    mockHockeyTech({ status: { 'standings:73': 500 } })
    expect((await call(handleECHL, '/echl/bracket/projected?season=73', env)).status).toBe(502)
    expect((await call(handleECHL, '/echl/bracket/projected?season=76', env)).status).toBe(400)
  })
})
