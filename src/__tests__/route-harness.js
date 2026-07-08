// src/__tests__/route-harness.js
// Shared harness for HTTP-route-level tests (Session 47, Item 2 — audit #9).
//
// No route handler (handleNHL/handlePWHL/handleRequest) had any test
// coverage before this — the only existing test file (seasons.test.js)
// covers pure resolution logic and never constructs a Request or invokes
// a handler. This harness fills that gap using the same "mock at the
// fetch/KV boundary" approach seasons.test.js already established, per
// CLAUDE.md's documented choice not to use a real Workers runtime
// (Miniflare/@cloudflare/vitest-pool-workers) — plain Node is sufficient
// since these handlers only touch Workers-specific APIs via env.CACHE /
// env.AI, both of which are easy to fake here.

import { vi } from 'vitest'

// In-memory KV namespace stand-in — real enough for kvGet/kvPut (shared.js)
// and any direct env.CACHE.get/put/delete calls in route handlers.
export function makeFakeCache(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null
    },
    async put(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    _store: store, // test-only escape hatch for asserting on raw cache state
  }
}

// Fake env.AI — routes call env.AI.run(model, opts). Default resolves to a
// generic shape; override per-test for routes that inspect the response.
export function makeFakeAI(runImpl) {
  return { run: runImpl || vi.fn().mockResolvedValue({ response: 'mock AI response' }) }
}

export function makeEnv(overrides = {}) {
  return {
    CACHE: makeFakeCache(),
    AI: makeFakeAI(),
    POLL_SECRET: 'test-poll-secret',
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_SUBJECT: undefined,
    ...overrides,
  }
}

// ctx.waitUntil in real Workers keeps the isolate alive until the promise
// settles, but doesn't block the response. Tests need explicit control:
// collect the promises so a test can `await flushWaitUntil(ctx)` after
// asserting on the immediate (cold-cache) response, to then assert on
// what the background fetch/write eventually did.
export function makeCtx() {
  const promises = []
  return {
    waitUntil(p) {
      promises.push(p)
    },
    _promises: promises,
  }
}

export async function flushWaitUntil(ctx) {
  await Promise.allSettled(ctx._promises)
}

export function makeRequest(path, { method = 'GET', body, headers } = {}) {
  const url = path.startsWith('http') ? path : `https://example.com${path}`
  const init = { method }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json', ...headers }
  } else if (headers) {
    init.headers = headers
  }
  return new Request(url, init)
}

export function urlFor(path) {
  return new URL(path.startsWith('http') ? path : `https://example.com${path}`)
}
