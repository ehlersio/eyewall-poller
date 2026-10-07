// POST /{league}/summary/narrative (contract C8): EyeWall AI period/final
// narratives for AHL/ECHL, one definition in createHockeyTechLeague().
// Prompt content is checked against a real game: AHL 1028986, Charlotte
// Checkers 8, Springfield Thunderbirds 1 (2026 Calder Cup first round,
// 2026-04-22; HockeyTech gameSummary: shots 15-2, 13-8, 10-9 by period).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache, makeFakeRateLimiter, mockFetchWithAI, mockFetchWithFailingAI, aiCalls, aiPrompt } from './route-harness.js'
import { handleRequest } from '../worker.js'
import { handleAHL } from '../ahl.js'
import { handleECHL } from '../echl.js'
import { narrativePeriodKey } from '../hockeytech.js'
import { FRENCH_INSTRUCTION } from '../shared.js'

const realFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = vi.fn() })
afterEach(() => { globalThis.fetch = realFetch })

const GAME_ID = 1028986
const CLT = 384

// What the app's useHockeyTechPeriodSummary builds for CLT's final.
const finalBody = {
  carAbbr: 'CLT', oppAbbr: 'SPR', carName: 'Charlotte Checkers', oppName: 'Springfield Thunderbirds',
  periodLabel: 'Final',
  carSOG: 38, oppSOG: 19, carGoals: 8, oppGoals: 1,
  penaltyCount: 9, carPenaltyCount: 6,
  bestPeriod: { period: 1, carSOG: 15, oppSOG: 2 },
  worstPeriod: { period: 3, carSOG: 10, oppSOG: 9 },
  goalieNames: ['Cooper Black'],
  goals: [
    { isCar: true, scorerName: 'Marek Alscher', time: '5:05', period: 1, strength: 'ev' },
    { isCar: true, scorerName: 'Noah Gregor', time: '13:07', period: 1, strength: 'ev' },
    { isCar: false, scorerName: 'Julien Gauthier', time: '4:39', period: 3, strength: 'ev' },
    { isCar: true, scorerName: 'Jack Studnicka', time: '19:20', period: 3, strength: 'en' },
  ],
}
const p1Body = {
  carAbbr: 'CLT', oppAbbr: 'SPR', carName: 'Charlotte Checkers', oppName: 'Springfield Thunderbirds',
  periodLabel: '1st Period', carSOG: 15, oppSOG: 2, carGoals: 4, oppGoals: 0,
  penaltyCount: 2, carPenaltyCount: 1, goalieNames: ['Cooper Black'],
  goals: [{ isCar: true, scorerName: 'Marek Alscher', time: '5:05', period: 1, strength: 'ev' }],
}

const LEAGUES = [
  { key: 'ahl', label: 'AHL', handle: handleAHL, teamId: CLT, abbr: 'CLT' },
  { key: 'echl', label: 'ECHL', handle: handleECHL, teamId: 8, abbr: 'FLA' },
]

function post(handle, env, query, body) {
  const path = `${query}`
  const req = typeof body === 'string'
    ? new Request(`https://example.com${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
    : makeRequest(path, { method: 'POST', body })
  return handle(req, env, makeCtx(), new URL(`https://example.com${path}`))
}

describe('narrativePeriodKey', () => {
  it('keeps 1-3 and game, files OT periods by label, refuses the shootout and junk', () => {
    expect(narrativePeriodKey('1')).toBe('1')
    expect(narrativePeriodKey('3')).toBe('3')
    expect(narrativePeriodKey('game')).toBe('game')
    expect(narrativePeriodKey('4')).toBe('OT')
    expect(narrativePeriodKey('OT')).toBe('OT')
    expect(narrativePeriodKey('ot')).toBe('OT')
    expect(narrativePeriodKey('5')).toBe('2OT')
    expect(narrativePeriodKey('2OT')).toBe('2OT')
    expect(narrativePeriodKey('7')).toBeNull() // shootout
    expect(narrativePeriodKey('0')).toBeNull()
    expect(narrativePeriodKey('Game')).toBeNull()
    expect(narrativePeriodKey('1;drop')).toBeNull()
    expect(narrativePeriodKey(null)).toBeNull()
  })
})

for (const lg of LEAGUES) {
  const base = `/${lg.key}/summary/narrative`
  const q = (period, extra = '') => `${base}?gameId=${GAME_ID}&period=${period}&teamId=${lg.teamId}${extra}`

  describe(`POST ${base}`, () => {
    it('generates, returns { narrative, cardNarrative } and caches it 30 days under the team key', async () => {
      const env = makeEnv()
      mockFetchWithAI('Charlotte poured in four first-period goals.')
      const res = await post(lg.handle, env, q(1), p1Body)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ narrative: 'Charlotte poured in four first-period goals.', cardNarrative: null })
      expect(aiCalls(globalThis.fetch)).toHaveLength(1)
      expect(JSON.parse(await env.CACHE.get(`${lg.key}:narrative:1:${GAME_ID}:${lg.teamId}`)).narrative)
        .toBe('Charlotte poured in four first-period goals.')
    })

    it('serves a cached narrative without calling the model or the rate limiter', async () => {
      const cached = { narrative: 'cached', cardNarrative: null }
      const limit = vi.fn().mockResolvedValue({ success: false })
      const env = makeEnv({
        CACHE: makeFakeCache({ [`${lg.key}:narrative:game:${GAME_ID}:${lg.teamId}`]: cached }),
        AI_ROUTE_LIMITER: makeFakeRateLimiter(limit),
      })
      mockFetchWithAI('should not be called')
      const res = await post(lg.handle, env, q('game'), {})
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(cached)
      expect(limit).not.toHaveBeenCalled()
      expect(aiCalls(globalThis.fetch)).toHaveLength(0)
    })

    it('rate-limits a cache miss (after the KV check), keyed per league route', async () => {
      const limit = vi.fn().mockResolvedValue({ success: false })
      const env = makeEnv({ AI_ROUTE_LIMITER: makeFakeRateLimiter(limit) })
      mockFetchWithAI('never')
      const res = await post(lg.handle, env, q(2), p1Body)
      expect(res.status).toBe(429)
      expect(limit).toHaveBeenCalledWith({ key: `${lg.key}-summary-narrative:unknown` })
      expect(aiCalls(globalThis.fetch)).toHaveLength(0)
      expect(await env.CACHE.get(`${lg.key}:narrative:2:${GAME_ID}:${lg.teamId}`)).toBeNull()
    })

    it('French gets its own :fr key and the French instruction; English is untouched', async () => {
      const env = makeEnv({ CACHE: makeFakeCache({ [`${lg.key}:narrative:1:${GAME_ID}:${lg.teamId}`]: { narrative: 'english', cardNarrative: null } }) })
      mockFetchWithAI('Charlotte a dominé la première période.')
      const res = await post(lg.handle, env, q(1, '&locale=fr'), p1Body)
      expect((await res.json()).narrative).toBe('Charlotte a dominé la première période.')
      expect(aiPrompt(globalThis.fetch)[0].content).toContain(FRENCH_INSTRUCTION)
      expect(JSON.parse(await env.CACHE.get(`${lg.key}:narrative:1:${GAME_ID}:${lg.teamId}:fr`)).narrative)
        .toBe('Charlotte a dominé la première période.')
      expect(JSON.parse(await env.CACHE.get(`${lg.key}:narrative:1:${GAME_ID}:${lg.teamId}`)).narrative).toBe('english')
    })

    it('period=4 and period=OT share the OT key', async () => {
      const env = makeEnv()
      mockFetchWithAI('Overtime winner.')
      await post(lg.handle, env, q(4), p1Body)
      expect(await env.CACHE.get(`${lg.key}:narrative:OT:${GAME_ID}:${lg.teamId}`)).not.toBeNull()
      mockFetchWithAI('not called')
      const again = await post(lg.handle, env, q('OT'), p1Body)
      expect((await again.json()).narrative).toBe('Overtime winner.')
      expect(aiCalls(globalThis.fetch)).toHaveLength(0)
    })

    it('400s without gameId, teamId or a valid period, before any KV or AI work', async () => {
      const env = makeEnv()
      mockFetchWithAI('never')
      for (const path of [
        `${base}?period=1&teamId=${lg.teamId}`,
        `${base}?gameId=${GAME_ID}&period=1`,
        `${base}?gameId=${GAME_ID}&teamId=${lg.teamId}`,
        `${base}?gameId=${GAME_ID}&period=7&teamId=${lg.teamId}`,
        `${base}?gameId=${GAME_ID}&period=x&teamId=${lg.teamId}`,
      ]) {
        const res = await post(lg.handle, env, path, p1Body)
        expect(res.status).toBe(400)
      }
      expect(aiCalls(globalThis.fetch)).toHaveLength(0)
    })

    it('400s on a non-JSON body', async () => {
      const env = makeEnv()
      mockFetchWithAI('never')
      const res = await post(lg.handle, env, q(1), 'not json')
      expect(res.status).toBe(400)
      expect(aiCalls(globalThis.fetch)).toHaveLength(0)
    })

    it('502s without caching when the model fails or returns nothing', async () => {
      const env = makeEnv()
      mockFetchWithFailingAI()
      expect((await post(lg.handle, env, q(1), p1Body)).status).toBe(502)
      mockFetchWithAI('')
      const empty = await post(lg.handle, env, q(1), p1Body)
      expect(empty.status).toBe(502)
      expect((await empty.json()).error).toMatch(/empty/i)
      expect(await env.CACHE.get(`${lg.key}:narrative:1:${GAME_ID}:${lg.teamId}`)).toBeNull()
    })

    it('names the league and falls back to the team code from teamId when the body has no abbreviation', async () => {
      const env = makeEnv()
      mockFetchWithAI('text')
      await post(lg.handle, env, q(1), { carGoals: 1, oppGoals: 0, goals: [] })
      const prompt = aiPrompt(globalThis.fetch)[0].content
      expect(prompt).toContain(`EyeWall Analytics' ${lg.label} analyst`)
      expect(prompt).toContain(`${lg.abbr} (${lg.abbr})`)
      expect(prompt).not.toMatch(/undefined|null|NaN/)
    })

    it('GET is not this route', async () => {
      const env = makeEnv()
      const res = await lg.handle(makeRequest(q(1)), env, makeCtx(), new URL(`https://example.com${q(1)}`))
      expect(res.status).toBe(404)
    })
  })
}

describe('POST /ahl/summary/narrative -- prompt content (AHL 1028986, CLT 8-1 SPR)', () => {
  const prompt = async (period, body) => {
    const env = makeEnv()
    mockFetchWithAI('Summary.')
    await post(handleAHL, env, `/ahl/summary/narrative?gameId=${GAME_ID}&period=${period}&teamId=${CLT}`, body)
    return aiPrompt(globalThis.fetch)[0].content
  }

  it('a final: score, shots, goals with their periods, goalie, best/worst period by shots; no Corsi', async () => {
    const p = await prompt('game', finalBody)
    expect(p).toContain("EyeWall Analytics' AHL game analyst")
    expect(p).toContain('Game: Charlotte Checkers (CLT) vs Springfield Thunderbirds (SPR)')
    expect(p).toContain('Score: Charlotte Checkers 8–1 Springfield Thunderbirds')
    expect(p).toContain('Shots on goal: 38–19')
    expect(p).toContain('Penalties: Charlotte Checkers 6–3 Springfield Thunderbirds')
    expect(p).toContain('Charlotte Checkers: Marek Alscher at 5:05 P1')
    expect(p).toContain('Springfield Thunderbirds: Julien Gauthier at 4:39 P3')
    expect(p).toContain('Charlotte Checkers: Jack Studnicka at 19:20 P3 (EN)')
    expect(p).toContain('Charlotte Checkers goalie in net: Cooper Black')
    expect(p).toContain('Best period: P1 (Charlotte Checkers outshot 15–2)')
    expect(p).toContain('Worst period: P3 (Charlotte Checkers outshot 10–9)')
    expect(p).toMatch(/No betting or wagering language/)
    expect(p).not.toMatch(/Corsi|Faceoff|Hits|High-danger|undefined|null/)
  })

  it('a period: its name, shots and goals without per-goal period labels', async () => {
    const p = await prompt(1, p1Body)
    expect(p).toContain("EyeWall Analytics' AHL analyst")
    expect(p).toContain('Period: 1st Period — Charlotte Checkers (CLT) vs Springfield Thunderbirds (SPR)')
    expect(p).toContain('Shots on goal: 15–2')
    expect(p).toContain('Goals: 4–0')
    expect(p).toContain('Penalties this period: 2 (Charlotte Checkers took 1)')
    expect(p).toContain('Charlotte Checkers: Marek Alscher at 5:05')
    expect(p).not.toContain('5:05 P1')
  })

  it('names an overtime period by its label when the client sent none', async () => {
    const p = await prompt('OT', { ...p1Body, periodLabel: undefined })
    expect(p).toContain('Period: OT — ')
  })

  it('a final with one ranked period prints it once', async () => {
    const one = { period: 2, carSOG: 13, oppSOG: 8 }
    const p = await prompt('game', { ...finalBody, bestPeriod: one, worstPeriod: one })
    expect(p).toContain('Best period: P2')
    expect(p).not.toContain('Worst period')
  })

  it('a long final gets a one-sentence cardNarrative', async () => {
    const env = makeEnv()
    const long = 'Charlotte scored four times in the first period and never looked back in an 8-1 win. ' +
      'Noah Gregor had two goals and Cooper Black stopped 18 of 19 shots.'
    mockFetchWithAI(long)
    const res = await post(handleAHL, env, `/ahl/summary/narrative?gameId=${GAME_ID}&period=game&teamId=${CLT}`, finalBody)
    const body = await res.json()
    expect(body.narrative).toBe(long)
    expect(body.cardNarrative).toBe('Charlotte scored four times in the first period and never looked back in an 8-1 win.')
  })
})

describe('GET /cache/ serves the AHL/ECHL narrative keys', () => {
  it('reads ahl:narrative:* and echl:narrative:* (incl. :fr) through the worker', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({
      [`ahl:narrative:game:${GAME_ID}:${CLT}`]: { narrative: 'en', cardNarrative: null },
      [`echl:narrative:1:1:8:fr`]: { narrative: 'fr', cardNarrative: null },
    }) })
    const ahl = await handleRequest(makeRequest(`/cache/${encodeURIComponent(`ahl:narrative:game:${GAME_ID}:${CLT}`)}`), env, makeCtx())
    expect(ahl.status).toBe(200)
    expect((await ahl.json()).narrative).toBe('en')
    const echl = await handleRequest(makeRequest(`/cache/${encodeURIComponent('echl:narrative:1:1:8:fr')}`), env, makeCtx())
    expect((await echl.json()).narrative).toBe('fr')
    const other = await handleRequest(makeRequest('/cache/ahl:standings:90'), env, makeCtx())
    expect(other.status).toBe(403)
  })
})
