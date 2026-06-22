/**
 * shared.js — EyeWall Analytics Worker
 *
 * Shared constants, KV helpers, and response utilities used by all modules.
 */

export const SB_URL  = 'https://mqgasjzywoibdgxjjkux.supabase.co';
export const SB_ANON = 'sb_publishable_e_zwr1UA7GnHq4OuQSas5Q_kO8bQ_Ct';

export const HT_BASE = 'https://lscluster.hockeytech.com/feed/index.php';
export const HT_KEY  = '446521baf8c38984';
export const HT_HDR  = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.thepwhl.com/' };

// ── KV helpers ────────────────────────────────────────────────

export async function kvPut(env, key, value, ttl) {
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

export async function kvGet(env, key) {
  const raw = await env.CACHE.get(key);
  return raw ? JSON.parse(raw) : null;
}

// ── Response helpers ──────────────────────────────────────────

export function json(val) {
  return Response.json(val, { headers: corsHeaders() });
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

export function badRequest(msg) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: corsHeaders() });
}

export function sbError(status) {
  return new Response(JSON.stringify({ error: `Supabase ${status}` }), { status: 502, headers: corsHeaders() });
}

// ── JSONP unwrap ──────────────────────────────────────────────
// HockeyTech responses are wrapped in parens: ([...])

export function unwrapJsonp(text) {
  text = text.trim();
  if (text.startsWith('(')) text = text.slice(1, text.lastIndexOf(')'));
  return JSON.parse(text);
}

// ── Supabase headers factory ──────────────────────────────────

export function sbHeaders() {
  return { 'apikey': SB_ANON, 'Authorization': `Bearer ${SB_ANON}` };
}
