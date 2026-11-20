// /player-analytics reads the stint RAPM's offence and defence
// (rapm_off/rapm_def) when player_seasons has them, and still answers
// without them before the owner-run migration adds the columns.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../worker.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const row = { player_id: 8478402, team: 'EDM', war: 2.1, rapm: 0.32, rapm_toi_min: 3100 }

function mock({ columnsExist }) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = decodeURIComponent(String(url))
    if (u.includes('/rest/v1/player_seasons')) {
      if (u.includes('rapm_off') && !columnsExist) {
        return { ok: false, status: 400, json: async () => ({ message: 'column player_seasons.rapm_off does not exist' }), text: async () => '' }
      }
      const r = u.includes('game_type=eq.2') ? [columnsExist ? { ...row, rapm_off: 0.25, rapm_def: -0.07 } : row] : []
      return { ok: true, status: 200, json: async () => r, headers: new Headers() }
    }
    return { ok: true, status: 200, json: async () => [], headers: new Headers() }
  })
}
const get = () => handleRequest(makeRequest('/player-analytics?season=20252026'), makeEnv(), makeCtx())
const urls = () => globalThis.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u))).filter(u => u.includes('player_seasons'))

describe('/player-analytics rapm_off / rapm_def', () => {
  it('reads them when the columns exist', async () => {
    mock({ columnsExist: true })
    const body = await (await get()).json()
    expect(body.rows[0]).toMatchObject({ rapm_off: 0.25, rapm_def: -0.07 })
    expect(urls().every(u => u.includes('rapm_off,rapm_def'))).toBe(true)
  })

  it('falls back to the read without them before the migration', async () => {
    mock({ columnsExist: false })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows[0].rapm).toBe(0.32)
    expect(body.rows[0].rapm_off).toBeUndefined()
    expect(urls().some(u => !u.includes('rapm_off'))).toBe(true)
  })
})
