// GET /nhl/callup-watch: parameter checks and the reads it makes. The
// ranking itself is covered in callupWatch.test.js.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCtx, makeEnv, makeRequest } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveNHLSeason: vi.fn().mockResolvedValue(20262027),
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
  resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 94, seasonType: 'regular' }),
  getAllAHLSeasons: vi.fn().mockResolvedValue([
    { seasonId: 94, seasonType: 'regular', startDate: '2026-10-02' },
    { seasonId: 93, seasonType: 'preseason', startDate: '2026-09-21' },
    { seasonId: 92, seasonType: 'playoffs', startDate: '2026-04-20' },
    { seasonId: 90, seasonType: 'regular', startDate: '2025-10-07' },
    { seasonId: 86, seasonType: 'regular', startDate: '2024-10-09' },
  ]),
}))

import { handleNHL } from '../nhl.js'

const call = (qs, env = makeEnv()) => {
  const url = new URL(`https://example.com/nhl/callup-watch?${qs}`)
  return handleNHL(makeRequest(`/nhl/callup-watch?${qs}`), env, makeCtx(), url)
}

const fixtures = {
  player_injuries: [{ player_id: 100, player_name: 'Seth Jarvis', status: 'injured-reserve', injury_type: 'Shoulder', return_date: null }],
  ahl_players: [{ player_id: 11, first_name: 'Bradly', last_name: 'Nadeau', position: 'C', birth_date: '2005-05-05', jersey_number: 20 }],
  ahl_player_seasons: [{ player_id: 11, season_id: 90, gp: 53, goals: 25, assists: 31, points: 56 }],
  ahl_goalie_seasons: [],
  ahl_skater_game_box: [],
  ahl_goalie_game_box: [],
  nhl_transactions: [{ tx_date: '2026-03-01', description: 'Recalled F Bradly Nadeau from Chicago (AHL).', categories: ['recall'] }],
  players: [],
}
const ROSTER = { forwards: [{ id: 100, firstName: { default: 'Seth' }, lastName: { default: 'Jarvis' }, positionCode: 'R', birthDate: '2002-02-01' }], defensemen: [], goalies: [] }
const PROSPECTS = { forwards: [{ id: 1, firstName: { default: 'Bradly' }, lastName: { default: 'Nadeau' }, positionCode: 'C', birthDate: '2005-05-05' }], defensemen: [], goalies: [] }

function mockUpstream() {
  globalThis.fetch = vi.fn(async (input) => {
    const u = String(input)
    if (u.includes('/roster/CAR/current')) return { ok: true, json: async () => ROSTER }
    if (u.includes('/prospects/CAR')) return { ok: true, json: async () => PROSPECTS }
    const table = u.match(/\/rest\/v1\/([a-z_]+)\?/)?.[1]
    return { ok: true, json: async () => fixtures[table] ?? [] }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('GET /nhl/callup-watch', () => {
  it('requires ahlTeamId and a valid team', async () => {
    mockUpstream()
    expect((await call('team=CAR')).status).toBe(400)
    expect((await call('team=CAR1&ahlTeamId=330')).status).toBe(400)
  })

  it("compares this AHL season with the last regular one, and returns who's out and who's next", async () => {
    mockUpstream()
    const body = await (await call('team=CAR&ahlTeamId=330')).json()
    expect(body.seasons).toEqual({ current: 94, previous: 90 })
    expect(body.ahlTeamId).toBe(330)
    expect(body.groups.F.out.map(o => o.name)).toEqual(['Seth Jarvis'])
    expect(body.groups.F.candidates[0]).toMatchObject({ name: 'Bradly Nadeau', holdsRights: true, ranked: true, recalls: [{ date: '2026-03-01' }] })

    const urls = globalThis.fetch.mock.calls.map(c => String(c[0]))
    expect(urls.find(u => u.includes('ahl_players?'))).toContain('team_id=eq.330')
    // Players marked off the affiliate's roster aren't candidates.
    expect(urls.find(u => u.includes('ahl_players?'))).toContain('&on_roster=not.is.false')
    expect(urls.find(u => u.includes('ahl_player_seasons?'))).toContain('season_id=in.(94,90)')
    expect(urls.find(u => u.includes('ahl_skater_game_box?'))).toContain('season_id=eq.94')
    expect(urls.find(u => u.includes('player_injuries?'))).toContain('team=eq.CAR')
    expect(urls.find(u => u.includes('nhl_transactions?'))).toMatch(/team=eq\.CAR&tx_date=gte\.\d{4}-\d{2}-\d{2}/)
  })

  it('reads the affiliate unfiltered while ahl_players.on_roster is missing', async () => {
    mockUpstream()
    const inner = globalThis.fetch
    globalThis.fetch = vi.fn(async (input) => String(input).includes('on_roster=')
      ? { ok: false, status: 400, json: async () => ({ code: '42703' }) }
      : inner(input))
    const body = await (await call('team=CAR&ahlTeamId=330')).json()
    expect(body.groups.F.candidates[0]).toMatchObject({ name: 'Bradly Nadeau' })
    const ahl = globalThis.fetch.mock.calls.map(c => String(c[0])).filter(u => u.includes('ahl_players?'))
    expect(ahl).toHaveLength(2)
    expect(ahl[1]).not.toContain('on_roster')
  })

  it('caches the answer for an hour under the team and affiliate', async () => {
    mockUpstream()
    const puts = []
    const env = makeEnv({ CACHE: { async get() { return null }, async put(k, v, o) { puts.push([k, o.expirationTtl]) } } })
    await call('team=CAR&ahlTeamId=330', env)
    expect(puts).toContainEqual(['nhl:callup-watch:CAR:330', 3600])
  })

  it('still answers when the NHL API is down: no positions, so injuries go unplaced', async () => {
    mockUpstream()
    const inner = globalThis.fetch
    globalThis.fetch = vi.fn(async (input) => (String(input).includes('api-web.nhle.com')
      ? { ok: false, status: 503, json: async () => ({}) }
      : inner(input)))
    const res = await call('team=CAR&ahlTeamId=330')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unplaced.map(u => u.name)).toEqual(['Seth Jarvis'])
    expect(body.groups.F.candidates[0]).toMatchObject({ name: 'Bradly Nadeau', holdsRights: false })
  })
})
