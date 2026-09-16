import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const input = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';
const uas = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
];

function isUseful(url) {
  try {
    const u = new URL(url);
    return (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com')) && /\/video\/\d+/.test(u.pathname);
  } catch { return false; }
}

function shortCode(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; }
}

async function probeRedirect(url) {
  for (const ua of uas) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const r = await fetch(url, {
          method,
          redirect: 'manual',
          headers: {
            'User-Agent': ua,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://www.google.com/'
          },
          signal: AbortSignal.timeout(15000)
        });
        const loc = r.headers.get('location') || '';
        console.log('redirect', method, r.status, url, '=>', loc || '(none)', 'ua=', ua.slice(0,28));
        try { await r.body?.cancel(); } catch {}
        if (loc) {
          const absolute = new URL(loc, url).toString();
          if (isUseful(absolute)) return absolute;
        }
      } catch (e) { console.log('redirect-error', method, url, String(e?.message || e)); }
    }
  }
  return '';
}

async function probeOembed(url) {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  try {
    const r = await fetch(endpoint, {
      headers: { 'User-Agent': uas[2], Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await r.text();
    console.log('oembed', r.status, url, text.slice(0,800).replace(/\s+/g,' '));
    if (!r.ok) return '';
    const data = JSON.parse(text);
    const hay = [data?.html, data?.author_url, data?.thumbnail_url].filter(Boolean).join(' ');
    const m = hay.match(/https?:\/\/(?:www\.)?tiktok\.com\/@[^\s"'<>]+\/video\/\d+/i);
    return m?.[0]?.replaceAll('&amp;','&') || '';
  } catch (e) { console.log('oembed-error', url, String(e?.message || e)); return ''; }
}

const code = shortCode(input);
const variants = [...new Set([
  input,
  code ? `https://vt.tiktok.com/${code}/` : '',
  code ? `https://vm.tiktok.com/${code}/` : '',
  code ? `https://www.tiktok.com/t/${code}/` : ''
].filter(Boolean))];

console.log('STATUS_TEST_URL', input, 'code', code);
let resolved = '';
for (const v of variants) {
  resolved = await probeRedirect(v);
  if (resolved) break;
  resolved = await probeOembed(v);
  if (resolved) break;
}
console.log('RESOLVED', resolved || '(none)');

const target = resolved || input;
const media = await parseMedia(target);
console.log('MEDIA', media?.platform, media?.duration, media?.videos?.length || 0);
const best = chooseBestVideo(media?.videos || []);
if (!best) throw new Error('No video candidate resolved');
console.log('BEST', best.quality, best.width, best.height, best.url?.slice(0,120));

let prepared;
try {
  prepared = await prepareWhatsAppStatusHQ({ sourceUrl: target, platform: 'tiktok', video: best });
  console.log('STATUS_HQ_OK', prepared.quality, prepared.clips.length, prepared.profile?.mode);
  for (const c of prepared.clips) console.log('CLIP', c.index, c.count, c.duration, c.size);
} finally {
  if (prepared?.cleanup) await prepared.cleanup();
}
