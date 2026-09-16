const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const pageUrl = 'https://ssstik.io/en-1';
const testUrl = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';

function snippet(text, index, radius = 700) {
  if (index < 0) return '';
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius)).replace(/\s+/g, ' ');
}

const res = await fetch(pageUrl, {
  headers: {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  redirect: 'follow',
  signal: AbortSignal.timeout(30000),
});
const html = await res.text();
console.log('HOME', res.status, res.url, 'bytes', html.length);
if (!res.ok) throw new Error(`SSSTik home HTTP ${res.status}`);

const token = html.match(/\bs_tt\s*=\s*['\"]([^'\"]+)['\"]/i)?.[1] || '';
const furl = html.match(/\bs_furl\s*=\s*['\"]([^'\"]+)['\"]/i)?.[1] || '';
console.log('RUNTIME', { tokenLength: token.length, furl });
if (!token || !furl) {
  const idx = Math.max(html.indexOf('s_tt'), html.indexOf('s_furl'));
  console.log('RUNTIME_SNIPPET', snippet(html, idx));
  throw new Error('SSSTik runtime values missing');
}

const cookies = typeof res.headers.getSetCookie === 'function'
  ? res.headers.getSetCookie().map((v) => String(v).split(';', 1)[0]).filter(Boolean).join('; ')
  : '';
const body = new URLSearchParams({ id: testUrl, locale: 'en', tt: token });
const endpoint = new URL(`/${furl}?url=dl`, res.url).toString();
console.log('POST_TO', endpoint, 'TEST_URL', testUrl);
const post = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'hx-current-url': pageUrl,
    'hx-request': 'true',
    'hx-target': 'target',
    'hx-trigger': '_gcaptcha_pt',
    Origin: 'https://ssstik.io',
    Referer: pageUrl,
    ...(cookies ? { Cookie: cookies } : {}),
  },
  body,
  redirect: 'follow',
  signal: AbortSignal.timeout(45000),
});
const out = await post.text();
console.log('POST_RESULT', post.status, post.url, 'bytes', out.length, 'head', out.slice(0, 800).replace(/\s+/g, ' '));
if (!post.ok) throw new Error(`SSSTik POST HTTP ${post.status}`);

const hrefs = [...out.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
console.log('HREF_COUNT', hrefs.length);
hrefs.slice(0, 20).forEach((v, i) => console.log('HREF', i, v));
const video = hrefs.find((v) => /^https?:\/\//i.test(v) && /\.mp4|video|ssscdn|tikcdn|tiktokcdn|tikcdn/i.test(v)) || '';
console.log('VIDEO_CANDIDATE', video);
if (!video) {
  for (const needle of ['download', 'without watermark', 'mp4', 'error', 'wrong link']) {
    const idx = out.toLowerCase().indexOf(needle);
    if (idx >= 0) console.log('OUT_PROBE', needle, snippet(out, idx));
  }
  throw new Error('SSSTik returned no direct video link');
}

const media = await fetch(video, {
  method: 'GET',
  headers: { 'User-Agent': UA, Referer: 'https://ssstik.io/' },
  redirect: 'follow',
  signal: AbortSignal.timeout(30000),
});
console.log('VIDEO_FETCH', media.status, media.url, media.headers.get('content-type'), media.headers.get('content-length'));
await media.body?.cancel().catch(() => {});
if (!media.ok) throw new Error(`Direct video HTTP ${media.status}`);
