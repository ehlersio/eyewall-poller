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
