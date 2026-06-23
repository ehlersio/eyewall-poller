/**
 * worker.js — EyeWall Analytics Worker
 *
 * Thin router. Delegates to nhl.js and pwhl.js.
 * Entry points: scheduled (cron poll) and fetch (HTTP).
 *
 * Environment variables (set in Cloudflare Worker dashboard or wrangler.toml secrets):
 *   POLL_SECRET       — protects /poll manual trigger
 *   VAPID_PUBLIC_KEY  — Web Push VAPID public key
 *   VAPID_PRIVATE_KEY — Web Push VAPID private key
 *   VAPID_SUBJECT     — mailto: or https: identifier
 *   NHL_SEASON        — e.g. "20252026" (flip each October)
 *
 * KV namespace binding: CACHE
 */

import { handleNHL, poll, refreshPPUnits } from './nhl.js';
import { handlePWHL, pollPWHL }             from './pwhl.js';
import { corsHeaders }                      from './shared.js';

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Route PWHL endpoints
  if (url.pathname.startsWith('/pwhl/')) {
    return handlePWHL(request, env, ctx, url);
  }

  // Route everything else to NHL handler
  return handleNHL(request, env, ctx, url);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      poll(env, ctx),
      pollPWHL(env).catch(e => console.error('PWHL poll error:', e.message)),
      refreshPPUnits(env)
        .then(map => console.log(`PP units scheduled: ${Object.keys(map).length} teams`))
        .catch(e => console.error('PP units scheduled error:', e.message)),
    ]));
  },
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
