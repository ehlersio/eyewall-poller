// GET /{pwhl,ahl,echl}/playoff-odds and /{pwhl,ahl,echl}/power-rankings
// (contracts C10 and C12, leagueOddsRankings.js), through worker.js's
// handleRequest. The tables come from owner-run migrations
// (eyewall-pipeline P13/P14), so every route is also checked with the
// table missing (PostgREST 404), with no rows, and with a failed read:
// empty shapes, never a 5xx, never cached.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../worker.js'
import { isOddsRunStale } from '../leagueOddsRankings.js'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-20T15:00:00Z'))
})

// fetch mock: the first handler whose `match` substring is in the URL
// answers; `status` other than 200 answers that status.
function mockSupabase(handlers) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = decodeURIComponent(String(url))
    const h = handlers.find(x => u.includes(x.match))
    if (!h) return { ok: true, status: 200, json: async () => [] }
    const status = h.status ?? 200
    return { ok: status < 300, status, json: async () => (typeof h.rows === 'function' ? h.rows(u) : h.rows) }
  })
}
const urls = () => globalThis.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)))
const get = (path, env) => handleRequest(makeRequest(path), env, makeCtx())

const LEAGUES = [
  { key: 'ahl', teamId: 335, season: 94 },
  { key: 'echl', teamId: 8, season: 78 },
  { key: 'pwhl', teamId: 3, season: 11 },
]

const oddsRow = (lg, run_date, pct, p50) => ({
  season_id: lg.season, team_id: lg.teamId, run_date,
  make_playoffs_pct: pct, win_division_pct: pct == null ? null : pct / 3,
  proj_points_p10: p50 - 9, proj_points_p50: p50, proj_points_p90: p50 + 8,
  current_points: 14, games_remaining: 60, sims: 5000, format: 'test-format',
})

describe('isOddsRunStale', () => {
  it('flags a run more than 48 h old (run_date at noon UTC)', () => {
    const now = Date.parse('2026-11-20T15:00:00Z')
    expect(isOddsRunStale('2026-11-20', now)).toBe(false)
    expect(isOddsRunStale('2026-11-18', now)).toBe(true)   // 51 h
    expect(isOddsRunStale('2026-11-19', now)).toBe(false)  // 27 h
    expect(isOddsRunStale('not a date', now)).toBe(false)
  })
})

for (const lg of LEAGUES) {
  const T = `${lg.key}_playoff_odds`
  describe(`GET /${lg.key}/playoff-odds`, () => {
    it('latest row, that season\'s history oldest first, stale false; cached an hour', async () => {
      const env = makeEnv()
      const latest = oddsRow(lg, '2026-11-20', 0.62, 88)
      mockSupabase([
        { match: `${T}?select=season_id,team_id,run_date`, rows: [latest] },
        { match: `${T}?select=run_date,make_playoffs_pct,proj_points_p50`, rows: [
          { run_date: '2026-11-18', make_playoffs_pct: 0.55, proj_points_p50: 85 },
          { run_date: '2026-11-19', make_playoffs_pct: 0.58, proj_points_p50: 86 },
          { run_date: '2026-11-20', make_playoffs_pct: 0.62, proj_points_p50: 88 },
        ] },
      ])
      const res = await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        latest,
        history: [
          { run_date: '2026-11-18', make_playoffs_pct: 0.55, proj_points_p50: 85 },
          { run_date: '2026-11-19', make_playoffs_pct: 0.58, proj_points_p50: 86 },
          { run_date: '2026-11-20', make_playoffs_pct: 0.62, proj_points_p50: 88 },
        ],
        stale: false,
      })
      const [first, second] = urls()
      expect(first).toContain(`team_id=eq.${lg.teamId}`)
      expect(first).toContain('order=run_date.desc&limit=1')
      expect(first).not.toContain('season_id=eq.')
      expect(second).toContain(`team_id=eq.${lg.teamId}&season_id=eq.${lg.season}&order=run_date.asc`)
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
      expect(JSON.parse(await env.CACHE.get(`${lg.key}:playoff-odds:${lg.teamId}:latest`))).toEqual(body)

      globalThis.fetch.mockClear()
      const again = await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)
      expect(await again.json()).toEqual(body)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('stale when the latest run is more than 48 h old; null percentages pass through', async () => {
      const env = makeEnv()
      const latest = oddsRow(lg, '2026-11-17', null, 70)
      mockSupabase([
        { match: `${T}?select=season_id`, rows: [latest] },
        { match: `${T}?select=run_date`, rows: [{ run_date: '2026-11-17', make_playoffs_pct: null, proj_points_p50: 70 }] },
      ])
      const body = await (await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)).json()
      expect(body.stale).toBe(true)
      expect(body.latest.make_playoffs_pct).toBeNull()
      expect(body.latest.win_division_pct).toBeNull()
    })

    it('?season= pins the season and its own cache key', async () => {
      const env = makeEnv()
      mockSupabase([{ match: `${T}?select=season_id`, rows: [oddsRow(lg, '2026-11-20', 0.5, 80)] }])
      await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}&season=${lg.season}`, env)
      expect(urls()[0]).toContain(`team_id=eq.${lg.teamId}&season_id=eq.${lg.season}&order=run_date.desc`)
      expect(await env.CACHE.get(`${lg.key}:playoff-odds:${lg.teamId}:${lg.season}`)).not.toBeNull()
    })

    it('table missing (404) or no rows -> { latest: null, history: [] }, uncached', async () => {
      for (const handler of [{ match: T, status: 404, rows: { code: 'PGRST205' } }, { match: T, rows: [] }]) {
        const env = makeEnv()
        mockSupabase([handler])
        const res = await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ latest: null, history: [] })
        expect(env.CACHE._store.size).toBe(0)
      }
    })

    it('a failed read is the empty shape with unavailable: true, never a 5xx, uncached', async () => {
      const env = makeEnv()
      mockSupabase([{ match: T, status: 503, rows: {} }])
      const res = await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ latest: null, history: [], unavailable: true })
      expect(env.CACHE._store.size).toBe(0)
    })

    it('games_played (eyewall-pipeline#217) is selected and passed through', async () => {
      const env = makeEnv()
      const latest = { ...oddsRow(lg, '2026-11-20', 0.62, 88), games_played: 12 }
      mockSupabase([{ match: `${T}?select=season_id`, rows: [latest] }])
      const body = await (await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)).json()
      expect(urls()[0]).toContain(',games_played&')
      expect(body.latest.games_played).toBe(12)
      expect(urls()).toHaveLength(2) // no retry
    })

    it('before the games_played migration (PostgREST 400): one retry with the old columns, games_played null, not KV-cached', async () => {
      const env = makeEnv()
      const latest = oddsRow(lg, '2026-11-20', 0.62, 88)
      const history = [{ run_date: '2026-11-20', make_playoffs_pct: 0.62, proj_points_p50: 88 }]
      mockSupabase([
        { match: 'games_played', status: 400, rows: { code: '42703', message: 'column playoff_odds.games_played does not exist' } },
        { match: `${T}?select=season_id`, rows: [latest] },
        { match: `${T}?select=run_date`, rows: history },
      ])
      const res = await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ latest: { ...latest, games_played: null }, history, stale: false })
      const [first, retry] = urls()
      expect(first).toContain('games_played')
      expect(retry).toContain(`${T}?select=season_id`)
      expect(retry).not.toContain('games_played')
      expect(urls()).toHaveLength(3)
      expect(env.CACHE._store.size).toBe(0)

      // Once the column exists the next request reads it (nothing cached).
      mockSupabase([{ match: `${T}?select=season_id`, rows: [{ ...latest, games_played: 30 }] }])
      expect((await (await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)).json()).latest.games_played).toBe(30)
    })

    it('table missing: the retry is missing too -> the empty shape', async () => {
      const env = makeEnv()
      mockSupabase([{ match: T, status: 404, rows: { code: 'PGRST205' } }])
      expect(await (await get(`/${lg.key}/playoff-odds?teamId=${lg.teamId}`, env)).json()).toEqual({ latest: null, history: [] })
      expect(urls()).toHaveLength(2)
    })

    it('400 without or with a malformed teamId/season, before any read', async () => {
      const env = makeEnv()
      mockSupabase([])
      for (const q of ['', '?teamId=abc', `?teamId=${lg.teamId}&season=9;x`]) {
        expect((await get(`/${lg.key}/playoff-odds${q}`, env)).status).toBe(400)
      }
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })

  const R = `${lg.key}_power_rankings`
  const N = `${lg.key}_power_rankings_narratives`
  const run = { season_id: lg.season, run_date: '2026-11-20' }
  const rankRows = [
    { team_id: 101, rank: 1, prior_rank: 2, score: 0.81, components: { pts_pct: 0.75, l10: 0.7, gd_per_gp: 1.1, special_teams: 1.02 } },
    { team_id: lg.teamId, rank: 2, prior_rank: 1, score: 0.77, components: { pts_pct: 0.7, l10: 0.6, gd_per_gp: 0.9, special_teams: 0.98 } },
    { team_id: 102, rank: 3, prior_rank: 3, score: 0.6, components: { pts_pct: 0.55, l10: 0.5, gd_per_gp: 0.2, special_teams: 1 } },
  ]

  describe(`GET /${lg.key}/power-rankings`, () => {
    it('latest run by rank, the team\'s narrative from that run and its rank history oldest first', async () => {
      const env = makeEnv()
      mockSupabase([
        { match: `${R}?select=season_id,run_date`, rows: [run] },
        { match: `${R}?select=team_id,rank`, rows: rankRows },
        { match: `${N}?select=narrative`, rows: [{ narrative: 'Second, a step behind the leaders.', run_date: '2026-11-20' }] },
        { match: `${R}?select=run_date,rank`, rows: [{ run_date: '2026-11-20', rank: 2 }, { run_date: '2026-11-19', rank: 1 }] },
      ])
      const res = await get(`/${lg.key}/power-rankings?teamId=${lg.teamId}`, env)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        latest: rankRows,
        narrative: { text: 'Second, a step behind the leaders.', run_date: '2026-11-20' },
        history: [{ run_date: '2026-11-19', rank: 1 }, { run_date: '2026-11-20', rank: 2 }],
      })
      const u = urls()
      expect(u[0]).toContain('order=run_date.desc&limit=1')
      expect(u.find(x => x.includes(`${R}?select=team_id`))).toContain(`season_id=eq.${lg.season}&run_date=eq.2026-11-20&order=rank.asc&limit=100`)
      expect(u.find(x => x.includes(N))).toContain(`team_id=eq.${lg.teamId}&season_id=eq.${lg.season}&run_date=eq.2026-11-20&locale=eq.en`)
      expect(u.find(x => x.includes(`${R}?select=run_date,rank`))).toContain(`team_id=eq.${lg.teamId}&season_id=eq.${lg.season}&order=run_date.desc&limit=28`)
      expect(await env.CACHE.get(`${lg.key}:power-rankings:${lg.teamId}:latest:100`)).not.toBeNull()
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    })

    it('without teamId: rankings only, no narrative or history reads', async () => {
      const env = makeEnv()
      mockSupabase([
        { match: `${R}?select=season_id,run_date`, rows: [run] },
        { match: `${R}?select=team_id,rank`, rows: rankRows },
      ])
      const body = await (await get(`/${lg.key}/power-rankings?limit=2`, env)).json()
      expect(body).toEqual({ latest: rankRows, narrative: null, history: [] })
      expect(urls().some(u => u.includes(N))).toBe(false)
      expect(urls().find(u => u.includes(`${R}?select=team_id`))).toContain('limit=2')
      expect(await env.CACHE.get(`${lg.key}:power-rankings:all:latest:2`)).not.toBeNull()
    })

    it('locale=fr reads the French narrative under its own :fr key; limit is capped at 100', async () => {
      const env = makeEnv()
      mockSupabase([
        { match: `${R}?select=season_id,run_date`, rows: [run] },
        { match: `${R}?select=team_id,rank`, rows: rankRows },
        { match: `${N}?select=narrative`, rows: (u) => (u.includes('locale=eq.fr') ? [{ narrative: 'Deuxième.', run_date: '2026-11-20' }] : []) },
      ])
      const body = await (await get(`/${lg.key}/power-rankings?teamId=${lg.teamId}&locale=fr&limit=500`, env)).json()
      expect(body.narrative).toEqual({ text: 'Deuxième.', run_date: '2026-11-20' })
      expect(await env.CACHE.get(`${lg.key}:power-rankings:${lg.teamId}:latest:100:fr`)).not.toBeNull()
    })

    it('rankings without a narratives table (or narrative row): narrative null, rankings still served', async () => {
      for (const narr of [{ match: N, status: 404, rows: {} }, { match: N, rows: [] }]) {
        const env = makeEnv()
        mockSupabase([
          narr,
          { match: `${R}?select=season_id,run_date`, rows: [run] },
          { match: `${R}?select=team_id,rank`, rows: rankRows },
        ])
        const body = await (await get(`/${lg.key}/power-rankings?teamId=${lg.teamId}`, env)).json()
        expect(body.latest).toEqual(rankRows)
        expect(body.narrative).toBeNull()
      }
    })

    it('table missing (404) or no rows -> { latest: [], narrative: null, history: [] }, uncached', async () => {
      for (const handler of [{ match: R, status: 404, rows: {} }, { match: R, rows: [] }]) {
        const env = makeEnv()
        mockSupabase([handler])
        const res = await get(`/${lg.key}/power-rankings?teamId=${lg.teamId}`, env)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ latest: [], narrative: null, history: [] })
        expect(env.CACHE._store.size).toBe(0)
      }
    })

    it('a failed read is the empty shape with unavailable: true, never a 5xx', async () => {
      const env = makeEnv()
      mockSupabase([
        { match: `${R}?select=season_id,run_date`, rows: [run] },
        { match: `${R}?select=team_id,rank`, status: 500, rows: {} },
      ])
      const res = await get(`/${lg.key}/power-rankings?teamId=${lg.teamId}`, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ latest: [], narrative: null, history: [], unavailable: true })
      expect(env.CACHE._store.size).toBe(0)
    })

    it('400 on a malformed teamId or limit', async () => {
      const env = makeEnv()
      mockSupabase([])
      expect((await get(`/${lg.key}/power-rankings?teamId=x`, env)).status).toBe(400)
      expect((await get(`/${lg.key}/power-rankings?limit=-1`, env)).status).toBe(400)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
  })
}

describe('routing', () => {
  it('a cached answer is served from KV with no Supabase read', async () => {
    const cached = { latest: [], narrative: null, history: [] }
    const env = makeEnv({ CACHE: makeFakeCache({ 'ahl:power-rankings:all:latest:100': { ...cached, latest: [{ team_id: 1, rank: 1 }] } }) })
    mockSupabase([])
    const body = await (await get('/ahl/power-rankings', env)).json()
    expect(body.latest).toEqual([{ team_id: 1, rank: 1 }])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('leaves POSTs and other paths to the league handlers', async () => {
    const env = makeEnv()
    mockSupabase([])
    const post = await handleRequest(makeRequest('/ahl/power-rankings', { method: 'POST', body: {} }), env, makeCtx())
    expect(post.status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
