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

export function tooManyRequests() {
  return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: corsHeaders() });
}

// Guards the billed AI-calling routes (/prediction/analyze, /summary/narrative,
// /pwhl/summary/narrative, /pwhl/scout) from unbounded public-cost abuse.
// Uses the Workers-native rate limiting binding rather than a shared secret:
// these routes are called directly from the public frontend, so a secret
// would ship in browser JS and protect nothing (see Session 48 findings).
// One binding, keyed by route+IP, gives each route its own budget.
export async function checkAiRateLimit(env, request, routeName) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.AI_ROUTE_LIMITER.limit({ key: `${routeName}:${ip}` });
  return success ? null : tooManyRequests();
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

// ── RSS/news parser helpers ─────────────────────────────────

export function extractTag(str, tag) {
  const re1 = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>');
  const re2 = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>');
  const m = str.match(re1) || str.match(re2);
  return m ? m[1].trim() : '';
}

export function stripHtml(s) {
  return s
    .replace(/<[^>]+>/g, ' ')          // remove tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/\s+/g, ' ')
    .trim();
}

export function safeId(sourceId, link) {
  // Use full base64 of URL to avoid collisions (12 chars was too short)
  try {
    const hash = btoa(unescape(encodeURIComponent(link))).replace(/[^a-z0-9]/gi, '');
    return sourceId + '-' + hash.slice(0, 32);
  } catch {
    // Fallback: use a simple hash of the link string
    let h = 0;
    for (let i = 0; i < link.length; i++) h = (Math.imul(31, h) + link.charCodeAt(i)) | 0;
    return sourceId + '-' + Math.abs(h).toString(36);
  }
}

// ── RSS/ESPN news parsers (used by NHL and PWHL news fetchers) ──

export function parseRSS(xml, source) {
  const items = [];
  const chunks = xml.split('<item');
  for (const chunk of chunks.slice(1, 12)) {
    const title   = stripHtml(extractTag(chunk, 'title'));
    // Try <link> plain, then <guid>, then link href attr
    const linkM   = chunk.match(/<link>([^<]+)<\/link>/) ||
                    chunk.match(/<guid[^>]*>([^<]+)<\/guid>/) ||
                    chunk.match(/<link[^>]+href="([^"]+)"/);
    const link    = linkM ? linkM[1].trim() : '';
    const rawDesc = extractTag(chunk, 'description') || extractTag(chunk, 'summary');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'pubDate') || extractTag(chunk, 'published');
    if (!title || !link) continue;
    if (source.filter) {
      const re = new RegExp(source.filter, 'i');
      if (!re.test(title) && !re.test(desc)) continue;
    }
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

// Parse ESPN RSS — uses <guid> as the canonical URL
// Parse Reddit JSON API response
export function parseReddit(data, source) {
  const posts = data?.data?.children || [];
  return posts
    .filter(p => {
      const d = p.data;
      // Skip stickied mod posts, removed posts, and pure image/video posts with no discussion
      return d && !d.stickied && !d.removed && d.title && d.permalink;
    })
    .slice(0, 10)
    .map(p => {
      const d = p.data;
      // Use external URL if it's a link post, otherwise use Reddit thread
      const isLinkPost = d.url && !d.url.includes('reddit.com') && !d.is_self;
      const url        = isLinkPost ? d.url : `https://www.reddit.com${d.permalink}`;
      const excerpt    = d.selftext
        ? d.selftext.replace(/\n+/g, ' ').trim().slice(0, 180)
        : `${d.score} upvotes · ${d.num_comments} comments`;
      return {
        id:          `reddit-${d.id}`,
        source:      source.id,
        sourceName:  source.name,
        sourceColor: source.color,
        title:       d.title,
        excerpt,
        url,
        publishedAt: new Date(d.created_utc * 1000).toISOString(),
        imageUrl:    (() => {
          // preview.images has higher quality images than thumbnail
          const previews = d.preview?.images?.[0]?.resolutions;
          if (previews?.length) {
            const img = previews.find(r => r.width >= 320) || previews[previews.length - 1];
            return img?.url?.replace(/&amp;/g, '&') || null;
          }
          // Fall back to thumbnail only if it's a real URL
          return (d.thumbnail && d.thumbnail.startsWith('http')) ? d.thumbnail : null;
        })(),
        score:       d.score,
        comments:    d.num_comments,
      };
    });
}

// Parse Sportsnet RSS — uses <headline> for title and CDATA <link>
export function parseSportsnet(xml, source) {
  const items = [];
  const chunks = xml.split('<item');
  for (const chunk of chunks.slice(1, 50)) {
    // Sportsnet uses <headline> not <title> for article headlines
    const headline = stripHtml(extractTag(chunk, 'headline') || extractTag(chunk, 'title'));
    if (!headline || headline.trim().length < 5) continue;
    // Link is in CDATA
    const rawLink = extractTag(chunk, 'link');
    const link    = rawLink.trim();
    const rawDesc = extractTag(chunk, 'description') || extractTag(chunk, 'summary');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'pubDate') || extractTag(chunk, 'dc:date');
    if (!link || !link.startsWith('http')) continue;
    // Apply filter
    if (source.filter) {
      const re = new RegExp(source.filter, 'i');
      if (!re.test(headline) && !re.test(desc)) continue;
    }
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title:       headline,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

// Parse Google News RSS
export function parseGoogleNews(xml, source) {
  const items = [];
  const chunks = xml.split('<item');
  for (const chunk of chunks.slice(1, 15)) {
    const rawTitle = extractTag(chunk, 'title');
    // Google News appends " - Outlet Name" to titles — strip it
    let title = stripHtml(rawTitle);
    const dashIdx = title.lastIndexOf(' - ');
    let outlet = '';
    if (dashIdx > 20) {
      outlet = title.slice(dashIdx + 3).trim();
      title  = title.slice(0, dashIdx).trim();
    }
    // Also try <source> tag
    const sourceM = chunk.match(/<source[^>]*>([^<]+)<\/source>/);
    if (sourceM) outlet = sourceM[1].trim();

    // Link is a Google redirect — extract from <link> after </title>
    const linkM = chunk.match(/<link>([^<]+)<\/link>/) ||
                  chunk.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const link  = linkM ? linkM[1].trim() : '';
    const pubDate = extractTag(chunk, 'pubDate');
    if (!title || !link) continue;
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  outlet || source.name,
      sourceColor: outlet ? '#555555' : source.color,
      title,
      excerpt:     outlet,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

export function parseESPN(xml, source) {
  const items = [];
  // ESPN: <link> appears right after <item> opening before <title>
  // Split on '<item>' (with closing >) to capture the link at start of chunk
  const chunks = xml.split('<item>');
  for (const chunk of chunks.slice(1, 12)) {
    const title   = stripHtml(extractTag(chunk, 'title'));
    // ESPN link is the first URL in the chunk — appears before <title>
    // Clean a URL by removing RSS CDATA artifacts
    const cleanUrl = u => u ? u.replace(/\]\]>.*$/, '').replace(/[\]>]+$/, '').trim() : '';
    const guidM   = chunk.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const linkM   = chunk.match(/<link>([^<]+)<\/link>/);
    const rawLink = extractTag(chunk, 'link') || extractTag(chunk, 'guid') || guidM?.[1] || linkM?.[1] || '';
    const link    = cleanUrl(rawLink);
    const rawDesc = extractTag(chunk, 'description');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'pubDate');
    if (!title || !link) continue;
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}

// Parse Atom <entry> feeds (Canes Country uses Atom)

export function parseAtom(xml, source) {
  const items = [];
  const chunks = xml.split(/<entry[\s>]/);
  for (const chunk of chunks.slice(1, 12)) {
    const title   = stripHtml(extractTag(chunk, 'title'));
    const linkM   = chunk.match(/<link[^>]+href="([^"]+)"[^>]*\/>/i) ||
                    chunk.match(/<link[^>]+href="([^"]+)"/i);
    const link    = linkM ? linkM[1].trim() : '';
    const rawDesc = extractTag(chunk, 'summary') || extractTag(chunk, 'content');
    const desc    = stripHtml(rawDesc).slice(0, 200);
    const pubDate = extractTag(chunk, 'published') || extractTag(chunk, 'updated');
    if (!title || !link) continue;
    let publishedAt;
    try { publishedAt = new Date(pubDate).toISOString(); } catch { publishedAt = new Date().toISOString(); }
    items.push({
      id:          safeId(source.id, link),
      source:      source.id,
      sourceName:  source.name,
      sourceColor: source.color,
      title,
      excerpt:     desc,
      url:         link,
      publishedAt,
      imageUrl:    null,
    });
  }
  return items;
}


export function parseNHLNews(data) {
  // NHL club-news returns { items: [...] } or { items: [] } off-season
  const items = data?.items || data?.content || [];
  if (!items.length) {
    console.log('News: nhl returned empty items array, keys:', Object.keys(data || {}));
    return [];
  }
  return items.slice(0, 8).map(item => ({
    id:          `nhl-${item.slug || item.id || Math.random().toString(36).slice(2)}`,
    source:      'nhl',
    sourceName:  'NHL.com',
    sourceColor: '#000000',
    title:       item.headline || item.title || '',
    excerpt:     (item.preview || item.summary || item.description || '').slice(0, 180),
    url:         item.webUrl || item.shareUrl || `https://www.nhl.com/hurricanes/news/${item.slug}`,
    publishedAt: item.publishedTime || item.date || new Date().toISOString(),
    imageUrl:    item.thumbnail?.thumbnailUrl || item.images?.[0]?.url || null,
  })).filter(a => a.title);
}

// ── VAPID / Web Push ─────────────────────────────────────────

// ── VAPID / Web Push ──────────────────────────────────────────

export function base64urlToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const b   = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...b].map(c => c.charCodeAt(0)));
}

export function uint8ArrayToBase64url(arr) {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function buildVAPIDAuthHeader(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const now      = Math.floor(Date.now() / 1000);

  // Build JWT header + payload
  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@eyewallanalytics.com',
  };

  const enc    = s => uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(s)));
  const toSign = `${enc(header)}.${enc(payload)}`;

  // Import private key via JWK.
  // VAPID_PRIVATE_KEY = base64url raw scalar (d).
  // VAPID_PUBLIC_KEY  = base64url uncompressed EC point (0x04 || x || y, 65 bytes).
  const pubBytes = base64urlToUint8Array(env.VAPID_PUBLIC_KEY);
  // pubBytes[0] = 0x04 (uncompressed), then 32 bytes x, 32 bytes y
  const x = uint8ArrayToBase64url(pubBytes.slice(1, 33));
  const y = uint8ArrayToBase64url(pubBytes.slice(33, 65));

  const privKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x, y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privKey,
    new TextEncoder().encode(toSign)
  );

  const jwt = `${toSign}.${uint8ArrayToBase64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ── RFC 8291 Web Push encryption ─────────────────────────────
// Encrypts notification payload per RFC 8291 (aes128gcm) so the
// service worker can read e.data.json() directly — no KV fetch needed.

export async function encryptPushPayload(sub, payloadObj) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));

  // Decode subscription keys
  const p256dh = base64urlToUint8Array(sub.keys.p256dh);
  const auth   = base64urlToUint8Array(sub.keys.auth);

  // Generate ephemeral ECDH key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );

  // Import receiver's public key (p256dh)
  const receiverKey = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // Derive shared ECDH secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, ephemeral.privateKey, 256
  );

  // Export ephemeral public key (uncompressed, 65 bytes)
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  // Salt: 16 random bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF-SHA-256 for PRK using auth secret
  // PRK = HKDF-Extract(auth, IKM=sharedSecret)
  const ikmKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey', 'deriveBits']);

  // auth_info = "WebPush: info " || receiverKey || senderKey
  const authInfo = new Uint8Array([
    ...new TextEncoder().encode('WebPush: info '),
    ...p256dh, ...ephPub
  ]);

  // PRK_key = HKDF(salt=auth, IKM=sharedBits, info=authInfo, length=32)
  const prkBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: auth, info: authInfo }, ikmKey, 256
  );

  const prkKey = await crypto.subtle.importKey('raw', prkBits, 'HKDF', false, ['deriveBits']);

  // CEK = HKDF(salt=salt, IKM=PRK, info="Content-Encoding: aes128gcm ", length=16)
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm ');
  const cekBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prkKey, 128
  );

  // Nonce = HKDF(salt=salt, IKM=PRK, info="Content-Encoding: nonce ", length=12)
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce ');
  const nonceBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96
  );

  // Encrypt with AES-128-GCM
  const cekAes = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);

  // Padding: plaintext || 0x02 (delimiter)
  const padded = new Uint8Array([...plaintext, 0x02]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBits }, cekAes, padded
  ));

  // aes128gcm content header: salt(16) || rs(4) || idlen(1) || keyid(ephPub, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // record size big-endian
  const header = new Uint8Array([...salt, ...rs, ephPub.length, ...ephPub]);

  // Final body = header || ciphertext
  const body = new Uint8Array([...header, ...ciphertext]);
  return body;
}

// Send a Web Push notification with encrypted payload (RFC 8291).
// Service worker reads e.data.json() — no KV fetch needed.
export async function sendPush(sub, payload, env) {
  try {
    const auth = await buildVAPIDAuthHeader(sub.endpoint, env);

    let body, headers;
    if (sub.keys?.p256dh && sub.keys?.auth) {
      // Send encrypted payload
      const encrypted = await encryptPushPayload(sub, payload);
      body    = encrypted;
      headers = {
        'Authorization':   auth,
        'Content-Type':    'application/octet-stream',
        'Content-Encoding':'aes128gcm',
        'TTL':             '60',
      };
    } else {
      // No keys — send payloadless push (SW will show generic notification)
      body    = null;
      headers = { 'Authorization': auth, 'TTL': '60', 'Content-Length': '0' };
    }

    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });

    const status = res.status;
    const resBody = await res.text().catch(() => '');
    console.log(`sendPush: status=${status} to ${sub.endpoint.slice(0,50)}...`);
    if (status === 200 || status === 201) console.log(`sendPush: body=${resBody.slice(0,100)}`);

    if (status === 410 || status === 404) return 'expired';
    if (!res.ok) { console.warn(`sendPush failed ${status}: ${resBody.slice(0,100)}`); return 'error'; }
    return 'ok';
  } catch (err) {
    console.error('sendPush error:', err.message);
    return 'error';
  }
}
