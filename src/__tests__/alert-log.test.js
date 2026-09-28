// Recent alerts for the app's notifications bell (shared.js): recorded as
// they're sent, written once per league per cron run, read back per team.
import { beforeEach, describe, expect, it } from 'vitest'
import { ALERT_LOG_HOURS, flushAlertLog, mergeAlertLog, readAlertLog, recordAlert } from '../shared.js'
import { handleNHL } from '../nhl.js'

function memEnv() {
  const store = {}
  const puts = []
  return {
    store, puts,
    CACHE: {
      async get(k) { return store[k] ?? null },
      async put(k, v, opts) { store[k] = v; puts.push({ k, ttl: opts?.expirationTtl }) },
    },
  }
}

const HOUR = 3600 * 1000

beforeEach(async () => { await flushAlertLog(memEnv()) }) // start each test with nothing pending

describe('mergeAlertLog', () => {
  it('appends, and drops alerts older than the window', () => {
    const now = Date.now()
    const old = { team: 'NHL:CAR', at: now - (ALERT_LOG_HOURS + 1) * HOUR }
    const kept = { team: 'NHL:CAR', at: now - HOUR }
    const fresh = { team: 'NHL:BOS', at: now }
    expect(mergeAlertLog([old, kept], [fresh], now)).toEqual([kept, fresh])
  })

  it('keeps at most the newest 400', () => {
    const now = Date.now()
    const many = Array.from({ length: 450 }, (_, i) => ({ team: 'NHL:CAR', at: now - 1000 + i }))
    const out = mergeAlertLog([], many, now)
    expect(out).toHaveLength(400)
    expect(out.at(-1)).toBe(many.at(-1))
  })
})

describe('recording and flushing', () => {
  it('writes each league once per flush, with both of a game’s teams noted', async () => {
    const env = memEnv()
    const pair = ['NHL:CAR', 'NHL:BOS']
    recordAlert('NHL:CAR', 'goal', { title: '🚨 GOAL! CAR 1–0 BOS', body: 'Aho', url: '/' }, pair)
    recordAlert('NHL:BOS', 'oppGoal', { title: 'CAR scores. BOS 0–1 CAR', url: '/' }, pair)
    recordAlert('PWHL:MIN', 'win', { title: '🏆 MIN Win!' }, ['PWHL:MIN', 'PWHL:BOS'])
    await flushAlertLog(env)

    expect(env.puts.map(p => p.k).sort()).toEqual(['alerts:recent:NHL', 'alerts:recent:PWHL'])
    const nhl = JSON.parse(env.store['alerts:recent:NHL'])
    expect(nhl).toHaveLength(2)
    expect(nhl[0]).toMatchObject({ team: 'NHL:CAR', vs: 'NHL:BOS', type: 'goal', title: '🚨 GOAL! CAR 1–0 BOS', body: 'Aho' })

    // Nothing pending afterwards: a second flush writes nothing.
    env.puts.length = 0
    await flushAlertLog(env)
    expect(env.puts).toEqual([])
  })

  it('reads back only the teams asked for, newest first', async () => {
    const env = memEnv()
    const now = Date.now()
    recordAlert('NHL:CAR', 'goal', { title: 'first' }, null, now - 2000)
    recordAlert('NHL:TOR', 'goal', { title: 'other team' }, null, now - 1500)
    recordAlert('NHL:CAR', 'win', { title: 'second' }, null, now - 1000)
    recordAlert('AHL:HER', 'goal', { title: 'ahl' }, null, now - 500)
    await flushAlertLog(env)

    const alerts = await readAlertLog(env, ['NHL:CAR', 'AHL:HER'])
    expect(alerts.map(a => a.title)).toEqual(['ahl', 'second', 'first'])
  })
})

describe('GET /alerts/recent', () => {
  const call = (env, qs) => handleNHL(
    new Request(`https://example.com/alerts/recent${qs}`), env, { waitUntil() {} }, new URL(`https://example.com/alerts/recent${qs}`)
  )

  it('needs at least one valid team', async () => {
    const res = await call(memEnv(), '?teams=XFL:BAD')
    expect(res.status).toBe(400)
  })

  it('returns the teams’ recent alerts', async () => {
    const env = memEnv()
    recordAlert('NHL:CAR', 'goal', { title: '🚨 GOAL!' }, null)
    await flushAlertLog(env)
    const res = await call(env, '?teams=nhl:car,PWHL:MIN')
    expect(res.status).toBe(200)
    expect((await res.json()).map(a => a.title)).toEqual(['🚨 GOAL!'])
  })
})
