// src/__tests__/apns-push.test.js
// Unit tests for shared.js's native iOS push additions (2026-09):
// subId(), sendPush()'s platform dispatch, and sendAPNsPush() itself
// (JWT signing + the actual APNs HTTP call). Real crypto.subtle throughout
// (same choice as encryptPushPayload/buildVAPIDAuthHeader, which also have
// no mocked-crypto shortcut) -- the private key here is a disposable P-256
// keypair generated fresh per test run via Node's crypto module, not a
// real APNs credential.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { makeEnv } from './route-harness.js'
import { subId, sendPush, sendAPNsPush, sendLiveActivityPush } from '../shared.js'

function makeTestAPNsKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return privateKey.export({ format: 'pem', type: 'pkcs8' })
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('subId', () => {
  it('returns token for a native iOS subscriber', () => {
    expect(subId({ platform: 'ios', token: 'device-token-1' })).toBe('device-token-1')
  })

  it('returns endpoint for a Web Push subscriber', () => {
    expect(subId({ endpoint: 'https://push.example/ep-1' })).toBe('https://push.example/ep-1')
  })

  it('prefers token over endpoint if a subscriber somehow has both', () => {
    expect(subId({ token: 't-1', endpoint: 'ep-1' })).toBe('t-1')
  })
})

describe('sendPush platform dispatch', () => {
  it('routes platform: "ios" subscribers to sendAPNsPush (errors without APNs secrets, never touches Web Push VAPID)', async () => {
    const env = makeEnv() // no APNS_* secrets set
    const result = await sendPush({ platform: 'ios', token: 'device-token-1' }, { title: 't', body: 'b' }, env)

    expect(result).toBe('error')
    expect(globalThis.fetch).not.toHaveBeenCalled() // never reached VAPID's endpoint-based fetch either
  })
})

describe('sendAPNsPush', () => {
  it('errors without touching fetch when APNS_KEY_ID/TEAM_ID/AUTH_KEY are unset', async () => {
    const env = makeEnv()
    const result = await sendAPNsPush({ platform: 'ios', token: 'device-token-1' }, { title: 't', body: 'b' }, env)

    expect(result).toBe('error')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('signs a real ES256 JWT and POSTs to the sandbox host by default', async () => {
    const env = makeEnv({
      APNS_KEY_ID:   'TESTKEYID1',
      APNS_TEAM_ID:  'TESTTEAMID',
      APNS_AUTH_KEY: makeTestAPNsKey(),
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' })

    const result = await sendAPNsPush(
      { platform: 'ios', token: 'device-token-abc' },
      { title: 'CAR goal!', body: 'Sebastian Aho scores', data: { gameId: '123' } },
      env
    )

    expect(result).toBe('ok')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('https://api.sandbox.push.apple.com/3/device/device-token-abc')
    expect(opts.headers['apns-topic']).toBe('com.eyewallanalytics.app')
    expect(opts.headers['apns-push-type']).toBe('alert')
    expect(opts.headers.authorization).toMatch(/^bearer /)

    const body = JSON.parse(opts.body)
    expect(body.aps.alert).toEqual({ title: 'CAR goal!', body: 'Sebastian Aho scores' })
    expect(body.aps.sound).toBe('default')
    expect(body.gameId).toBe('123') // custom data merged alongside aps

    // JWT itself: header.payload.signature, header carries our key id, payload our team id
    const jwt = opts.headers.authorization.replace(/^bearer /, '')
    const [headerB64, payloadB64] = jwt.split('.')
    const decode = b64 => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')))
    expect(decode(headerB64)).toEqual({ alg: 'ES256', kid: 'TESTKEYID1' })
    expect(decode(payloadB64).iss).toBe('TESTTEAMID')
  })

  it('uses the production host when APNS_ENV=production', async () => {
    const env = makeEnv({
      APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_AUTH_KEY: makeTestAPNsKey(), APNS_ENV: 'production',
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' })

    await sendAPNsPush({ platform: 'ios', token: 'device-token-xyz' }, { title: 't', body: 'b' }, env)

    expect(globalThis.fetch.mock.calls[0][0]).toBe('https://api.push.apple.com/3/device/device-token-xyz')
  })

  it('maps a 410 (Unregistered) response to "expired", same as Web Push\'s 410/404', async () => {
    const env = makeEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_AUTH_KEY: makeTestAPNsKey() })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 410, text: async () => '{"reason":"Unregistered"}' })

    const result = await sendAPNsPush({ platform: 'ios', token: 'device-token-gone' }, { title: 't', body: 'b' }, env)
    expect(result).toBe('expired')
  })

  it('reuses a cached APNs JWT within its KV TTL instead of re-signing', async () => {
    const env = makeEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_AUTH_KEY: makeTestAPNsKey() })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' })

    await sendAPNsPush({ platform: 'ios', token: 'device-token-1' }, { title: 't', body: 'b' }, env)
    const firstJwt = globalThis.fetch.mock.calls[0][1].headers.authorization

    await sendAPNsPush({ platform: 'ios', token: 'device-token-2' }, { title: 't', body: 'b' }, env)
    const secondJwt = globalThis.fetch.mock.calls[1][1].headers.authorization

    expect(secondJwt).toBe(firstJwt)
  })
})

describe('sendLiveActivityPush', () => {
  it('sends a push-to-start with the activity’s attributes, their type and an alert', async () => {
    const env = makeEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_AUTH_KEY: makeTestAPNsKey() })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' })
    const attributes = { gameId: 1, homeAbbr: 'CAR', awayAbbr: 'NSH', homeColor: '#ff0f0f', awayColor: '#FFB81C', followAbbr: 'CAR' }

    await sendLiveActivityPush('start-token', {
      event: 'start', state: { homeScore: 0 }, attributes, attributesType: 'GameActivityAttributes',
      alert: { title: 'NSH @ CAR', body: 'Puck drop' },
    }, env)

    const [url, opts] = globalThis.fetch.mock.calls[0]
    expect(url).toBe('https://api.sandbox.push.apple.com/3/device/start-token')
    expect(opts.headers['apns-push-type']).toBe('liveactivity')
    const { aps } = JSON.parse(opts.body)
    expect(aps).toMatchObject({
      event: 'start', 'content-state': { homeScore: 0 },
      'attributes-type': 'GameActivityAttributes', attributes, alert: { title: 'NSH @ CAR', body: 'Puck drop' },
    })
  })

  it('leaves attributes off an update', async () => {
    const env = makeEnv({ APNS_KEY_ID: 'k', APNS_TEAM_ID: 't', APNS_AUTH_KEY: makeTestAPNsKey() })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' })
    await sendLiveActivityPush('update-token', { event: 'update', state: {}, attributes: { gameId: 1 } }, env)
    const { aps } = JSON.parse(globalThis.fetch.mock.calls[0][1].body)
    expect(aps.attributes).toBeUndefined()
    expect(aps['attributes-type']).toBeUndefined()
  })
})
