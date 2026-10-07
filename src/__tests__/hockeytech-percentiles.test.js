// src/__tests__/hockeytech-percentiles.test.js
// /{league}/player/percentiles and /{league}/goalie/percentiles (contract
// C4, audit 2026-10-06 Phase 3): the /pwhl/*/percentiles shape plus
// rateBasis, read from {league}_player_percentiles /
// {league}_goalie_percentiles, and the empty shape (200, not a 5xx) while
// those tables don't exist yet.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

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

import { handleAHL } from '../ahl.js'
import { handleECHL } from '../echl.js'

const LEAGUES = [
  { key: 'ahl', label: 'AHL', handle: handleAHL, season: 90, playoffSeason: 92, team: 335, team2: 323 },
  { key: 'echl', label: 'ECHL', handle: handleECHL, season: 73, playoffSeason: 76, team: 8, team2: 99 },
]

// Supabase stand-in: `tables` maps a table name (without the league
// prefix) to its rows, or to an HTTP status for a failed read. Filters on
// player_id/season_id/season_type are applied; order/limit are not (the
// fixtures are already in the order the query asks for).
function mockSupabase(L, tables) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    const name = u.pathname.slice('/rest/v1/'.length).replace(new RegExp(`^${L.key}_`), '')
    const t = tables[name]
    if (t === undefined) return new Response(JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${L.key}_${name}'` }), { status: 404 })
    if (typeof t === 'number') return new Response('{}', { status: t })
    const eq = (col) => u.searchParams.get(col)?.replace(/^eq\./, '')
    const rows = t.filter(r =>
      (!eq('player_id') || String(r.player_id) === eq('player_id')) &&
      (!eq('season_id') || String(r.season_id) === eq('season_id')) &&
      (!eq('season_type') || r.season_type === eq('season_type')))
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

const call = (L, path, env = makeEnv()) =>
  L.handle(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))

const requested = () => globalThis.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)))

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe.each(LEAGUES)('GET /$key/player/percentiles', (L) => {
  const skaterRow = (over = {}) => ({
    player_id: 6681, team_id: L.team, season_id: L.season, season_type: 'regular', gp: 40,
    toi_per_game: null, xg_for: 11.42, finishing: 3.58, rate_basis_per_gp: true,
    pct_goals: 91, pct_a1: 77, pct_penalties: 40, pct_finishing: 85, ...over,
  })

  it('requires id', async () => {
    const res = await call(L, `/${L.key}/player/percentiles`)
    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric id before it reaches PostgREST', async () => {
    const res = await call(L, `/${L.key}/player/percentiles?id=1,2&season=${L.season}`)
    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('serves the PWHL shape plus rateBasis perGP, KV-cached and browser-cached for an hour', async () => {
    mockSupabase(L, { player_percentiles: [skaterRow()] })
    const cache = makeFakeCache()
    const res = await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`, makeEnv({ CACHE: cache }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    const body = await res.json()
    expect(body).toEqual({
      player_id: 6681, team_id: L.team, season_id: L.season, season_type: 'regular',
      toi_per_game: null, xg_for: 11.42, finishing: 3.58, rateBasis: 'perGP',
      percentiles: {
        goals:     { pct: 91, label: 'Goals',       note: 'Percentile rank vs league, goals, per game played' },
        a1:        { pct: 77, label: '1st Assists', note: 'Percentile rank vs league, primary assists, per game played' },
        penalties: { pct: 40, label: 'Penalties',   note: 'Percentile rank vs league, penalty discipline, per game played' },
        finishing: { pct: 85, label: 'Finishing',   note: 'Percentile rank vs league, goals above xGoals, per game played' },
      },
    })
    expect(requested()).toEqual([
      `https://mqgasjzywoibdgxjjkux.supabase.co/rest/v1/${L.key}_player_percentiles?player_id=eq.6681&season_id=eq.${L.season}&order=team_id.asc&select=*`,
    ])
    expect(JSON.parse(cache._store.get(`${L.key}:player:percentiles:6681:${L.season}:any`))).toEqual(body)
  })

  it('serves from KV without reading Supabase', async () => {
    const cache = makeFakeCache({ [`${L.key}:player:percentiles:6681:${L.season}:any`]: { player_id: 6681, rateBasis: 'perGP' } })
    const res = await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`, makeEnv({ CACHE: cache }))
    expect(await res.json()).toEqual({ player_id: 6681, rateBasis: 'perGP' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('accepts playerId= as an alias of id=', async () => {
    mockSupabase(L, { player_percentiles: [skaterRow()] })
    const res = await call(L, `/${L.key}/player/percentiles?playerId=6681&season=${L.season}`)
    expect((await res.json()).percentiles.goals.pct).toBe(91)
  })

  it('a playoff season id finds its row without a seasonType (a season id has one type)', async () => {
    mockSupabase(L, { player_percentiles: [skaterRow({ season_id: L.playoffSeason, season_type: 'playoffs', pct_goals: 60 })] })
    const body = await (await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.playoffSeason}`)).json()
    expect(body).toMatchObject({ season_id: L.playoffSeason, season_type: 'playoffs' })
    expect(body.percentiles.goals.pct).toBe(60)
  })

  it('with no season, reads the latest regular season', async () => {
    mockSupabase(L, { player_percentiles: [
      skaterRow({ pct_goals: 91 }),
      skaterRow({ season_id: L.season - 4, pct_goals: 12 }),
    ] })
    const body = await (await call(L, `/${L.key}/player/percentiles?id=6681`)).json()
    expect(body.season_id).toBe(L.season)
    expect(body.percentiles.goals.pct).toBe(91)
    expect(requested()[0]).toContain('player_id=eq.6681&season_type=eq.regular&order=season_id.desc,team_id.asc&limit=20&select=*')
  })

  it('a traded player gets the row for the team he played most games for', async () => {
    mockSupabase(L, { player_percentiles: [
      skaterRow({ team_id: L.team, gp: 12, pct_goals: 30 }),
      skaterRow({ team_id: L.team2, gp: 28, pct_goals: 70 }),
    ] })
    const body = await (await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`)).json()
    expect(body).toMatchObject({ team_id: L.team2, percentiles: { goals: { pct: 70 } } })
  })

  it('takes xg_for/finishing from {league}_player_xg when the percentile row lacks them', async () => {
    const row = skaterRow()
    delete row.xg_for
    delete row.finishing
    mockSupabase(L, {
      player_percentiles: [row],
      player_xg: [{ player_id: 6681, team_id: L.team, season_id: L.season, season_type: 'regular', xg_for: 9.1, finishing: -1.1 }],
    })
    const body = await (await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`)).json()
    expect(body).toMatchObject({ xg_for: 9.1, finishing: -1.1 })
    expect(requested()[1]).toContain(`${L.key}_player_xg?player_id=eq.6681&season_id=eq.${L.season}`)
  })

  it('rateBasis is per60 only for a row that says rate_basis_per_gp = false', async () => {
    mockSupabase(L, { player_percentiles: [skaterRow({ rate_basis_per_gp: false })] })
    const body = await (await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`)).json()
    expect(body.rateBasis).toBe('per60')
    expect(body.percentiles.goals.note).toBe('Percentile rank vs league, goals')
  })

  it('no row yet: 200 with null percentiles', async () => {
    mockSupabase(L, { player_percentiles: [] })
    const res = await call(L, `/${L.key}/player/percentiles?id=999&season=${L.season}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ player_id: 999, team_id: null, season_id: L.season, xg_for: null, finishing: null, rateBasis: 'perGP' })
    expect(Object.values(body.percentiles).every(p => p.pct === null)).toBe(true)
  })

  it.each([404, 400])('table not created yet (PostgREST %i): the empty shape, not KV-cached, short browser cache', async (status) => {
    mockSupabase(L, { player_percentiles: status })
    const cache = makeFakeCache()
    const res = await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`, makeEnv({ CACHE: cache }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    const body = await res.json()
    expect(body).toMatchObject({ player_id: 6681, season_id: L.season, rateBasis: 'perGP' })
    expect(Object.values(body.percentiles).every(p => p.pct === null)).toBe(true)
    expect(cache._store.size).toBe(0)
  })

  it('any other Supabase failure is a 502', async () => {
    mockSupabase(L, { player_percentiles: 500 })
    const res = await call(L, `/${L.key}/player/percentiles?id=6681&season=${L.season}`)
    expect(res.status).toBe(502)
  })
})

describe.each(LEAGUES)('GET /$key/goalie/percentiles', (L) => {
  const goalieRow = (over = {}) => ({
    player_id: 7001, team_id: L.team, season_id: L.season, season_type: 'regular', gp: 30, rate_basis_per_gp: true,
    gsax: 6.2, gsax_per60: 0.207, ev_sv_pct: 0.9214, hd_sv_pct: 0.8125, md_sv_pct: 0.901, pk_sv_pct: null,
    pct_gsax: 88, pct_gsax60: 84, pct_ev_sv: 79, pct_hd_sv: 66, pct_md_sv: 71, pct_pk_sv: null, ...over,
  })

  it('requires id', async () => {
    expect((await call(L, `/${L.key}/goalie/percentiles?season=${L.season}`)).status).toBe(400)
  })

  it('serves the PWHL shape with GSAX per game played', async () => {
    mockSupabase(L, { goalie_percentiles: [goalieRow()] })
    const res = await call(L, `/${L.key}/goalie/percentiles?id=7001&season=${L.season}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    const body = await res.json()
    expect(body).toEqual({
      player_id: 7001, team_id: L.team, season_id: L.season, season_type: 'regular',
      gsax: 6.2, gsax60: 0.207, evSvPct: 92.1, hdSvPct: 81.3, mdSvPct: 90.1, pkSvPct: null, rateBasis: 'perGP',
      percentiles: {
        gsax:   { pct: 88,   label: 'GSAX',            note: `Percentile rank vs ${L.label} goalies, goals saved above expected (danger-zone xG proxy)` },
        gsax60: { pct: 84,   label: 'GSAX/GP',         note: `Percentile rank vs ${L.label} goalies, GSAX per game played` },
        evSv:   { pct: 79,   label: '5-on-5 SV%',      note: `Percentile rank vs ${L.label} goalies, even-strength save percentage` },
        hdSv:   { pct: 66,   label: 'High Danger SV%', note: `Percentile rank vs ${L.label} goalies, high-danger save percentage` },
        mdSv:   { pct: 71,   label: 'Med Danger SV%',  note: `Percentile rank vs ${L.label} goalies, medium-danger save percentage` },
        pkSv:   { pct: null, label: 'PK SV%',          note: `Percentile rank vs ${L.label} goalies, penalty-kill save percentage` },
      },
    })
    expect(requested()).toEqual([
      `https://mqgasjzywoibdgxjjkux.supabase.co/rest/v1/${L.key}_goalie_percentiles?player_id=eq.7001&season_id=eq.${L.season}&order=team_id.asc&select=*`,
    ])
  })

  it('no row yet: 200 with null percentiles', async () => {
    mockSupabase(L, { goalie_percentiles: [] })
    const body = await (await call(L, `/${L.key}/goalie/percentiles?id=7001&season=${L.season}`)).json()
    expect(body).toMatchObject({ player_id: 7001, gsax: null, gsax60: null, evSvPct: null, rateBasis: 'perGP' })
    expect(Object.values(body.percentiles).every(p => p.pct === null)).toBe(true)
  })

  it('table not created yet: the empty shape, not a 5xx', async () => {
    mockSupabase(L, {})
    const res = await call(L, `/${L.key}/goalie/percentiles?id=7001`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ player_id: 7001, season_id: null, season_type: 'regular', gsax: null })
  })

  it('any other Supabase failure is a 502', async () => {
    mockSupabase(L, { goalie_percentiles: 503 })
    expect((await call(L, `/${L.key}/goalie/percentiles?id=7001&season=${L.season}`)).status).toBe(502)
  })
})
