import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const execFileAsync = promisify(execFile);
const url = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';
const browserUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
console.log('STATUS_TEST_URL', url);

function absoluteUrl(value, base = 'https://www.tikwm.com') {
  if (!value) return '';
  try { return new URL(value, base).toString(); } catch { return ''; }
}

function videoMedia(direct, data = {}, headers = {}) {
  return {
    platform: 'TikTok',
    title: String(data?.title || ''),
    duration: Number(data?.duration || data?.author?.duration || 0) || null,
    videos: [{
      url: String(direct), quality: 'HD', width: Number(data?.width || 0) || null,
      height: Number(data?.height || 0) || null, ext: 'mp4', hasAudio: true,
      source: 'direct', headers: { 'User-Agent': browserUA, ...headers }, filesize: null,
    }],
    images: [], audios: [],
  };
}

async function tryClipX(inputUrl) {
  const endpoint = new URL('https://clipx.zamdev.workers.dev/');
  endpoint.searchParams.set('url', inputUrl);
  endpoint.searchParams.set('quality', 'best');
  endpoint.searchParams.set('timeout', '60000');
  endpoint.searchParams.set('meta', 'false');
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': browserUA, Accept: 'application/json, text/plain, */*' },
    redirect: 'follow', signal: AbortSignal.timeout(65000),
  });
  const text = await response.text();
  console.log('clipx status', response.status, 'bytes', text.length, 'head', text.slice(0, 300));
  if (!response.ok) throw new Error(`ClipX HTTP ${response.status}: ${text.slice(0, 180)}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('ClipX invalid JSON'); }
  if (!payload?.success || !payload?.data) throw new Error(`ClipX failed: ${payload?.error || 'no data'}`);
  const data = payload.data;
  const direct = data?.video?.hd_mp4 || data?.video?.standard_mp4 || data?.video?.wmplay || '';
  if (!/^https?:\/\//i.test(String(direct))) throw new Error('ClipX no direct video URL');
  return videoMedia(direct, { title: data.title, duration: data.duration });
}

async function trySlbjs(inputUrl) {
  const endpoint = new URL('https://tdownv4.sl-bjs.workers.dev/');
  endpoint.searchParams.set('down', inputUrl);
  const response = await fetch(endpoint, {
    headers: { 'User-Agent': browserUA, Accept: 'application/json, text/plain, */*' },
    redirect: 'follow', signal: AbortSignal.timeout(45000),
  });
  const text = await response.text();
  console.log('slbjs status', response.status, 'bytes', text.length, 'head', text.slice(0, 300));
  if (!response.ok) throw new Error(`Slbjs HTTP ${response.status}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Slbjs invalid JSON'); }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const direct = data?.download_url || data?.downloadUrl || data?.video_url || data?.videoUrl || '';
  if (!/^https?:\/\//i.test(String(direct))) throw new Error('Slbjs no direct video URL');
  return videoMedia(direct, data);
}

function shortSnippet(text, index, radius = 220) {
  if (index < 0) return '';
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius)).replace(/\s+/g, ' ');
}

async function trySsstik(inputUrl) {
  const homeUrl = 'https://ssstik.io/en-1';
  const home = await fetch(homeUrl, {
    headers: {
      'User-Agent': browserUA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow', signal: AbortSignal.timeout(30000),
  });
  const html = await home.text();
  const setCookies = typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie() : [];
  console.log('ssstik-home', home.status, home.url, 'bytes', html.length, 'cookies', setCookies.length);
  if (!home.ok) throw new Error(`SSSTik home HTTP ${home.status}`);

  const probes = ['abc?url=dl', 'hx-post', 'hx-trigger', 'tt:', 'tt=', 'name="tt"', "name='tt'", 'locale'];
  for (const probe of probes) {
    const idx = html.toLowerCase().indexOf(probe.toLowerCase());
    if (idx >= 0) console.log('ssstik-probe', probe, shortSnippet(html, idx));
  }
  const inputTags = [...html.matchAll(/<input\b[^>]{0,600}>/gi)].map((m) => m[0]);
  console.log('ssstik-inputs', inputTags.slice(0, 20).map((v) => v.replace(/\s+/g, ' ')).join(' || '));
  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((m) => absoluteUrl(m[1], homeUrl));
  console.log('ssstik-script-srcs', scriptSrcs.slice(0, 20).join(' | '));

  let token =
    html.match(/\btt\s*:\s*['\"]([^'\"]+)['\"]/i)?.[1] ||
    html.match(/\btt\s*=\s*['\"]([^'\"]+)['\"]/i)?.[1] ||
    html.match(/name=["']tt["'][^>]*value=["']([^"']+)["']/i)?.[1] ||
    html.match(/value=["']([^"']+)["'][^>]*name=["']tt["']/i)?.[1] || '';

  if (!token) {
    for (const src of scriptSrcs.slice(-8)) {
      try {
        const jsRes = await fetch(src, {
          headers: { 'User-Agent': browserUA, Accept: '*/*', Referer: homeUrl },
          signal: AbortSignal.timeout(20000),
        });
        const js = await jsRes.text();
        const hasNeedle = /\btt\b|abc\?url=dl|_gcaptcha_pt/i.test(js);
        console.log('ssstik-js', src, jsRes.status, 'bytes', js.length, 'interesting', hasNeedle);
        if (hasNeedle) {
          for (const probe of ['abc?url=dl', '_gcaptcha_pt', 'tt:', 'tt=']) {
            const idx = js.toLowerCase().indexOf(probe.toLowerCase());
            if (idx >= 0) console.log('ssstik-js-probe', probe, shortSnippet(js, idx, 300));
          }
        }
        token =
          js.match(/\btt\s*:\s*['\"]([^'\"]+)['\"]/i)?.[1] ||
          js.match(/\btt\s*=\s*['\"]([^'\"]+)['\"]/i)?.[1] || token;
        if (token) break;
      } catch (error) {
        console.log('ssstik-js-failed', src, error?.message || error);
      }
    }
  }
  if (!token) throw new Error('SSSTik token not found');
  console.log('ssstik-token-found', token.length);

  const cookieHeader = setCookies.map((v) => String(v).split(';', 1)[0]).filter(Boolean).join('; ');
  const body = new URLSearchParams({ id: inputUrl, locale: 'en', tt: token });
  const response = await fetch('https://ssstik.io/abc?url=dl', {
    method: 'POST',
    headers: {
      'User-Agent': browserUA, Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'hx-current-url': homeUrl, 'hx-request': 'true', 'hx-target': 'target',
      'hx-trigger': '_gcaptcha_pt', Origin: 'https://ssstik.io', Referer: homeUrl,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body, redirect: 'follow', signal: AbortSignal.timeout(45000),
  });
  const text = await response.text();
  console.log('ssstik-post', response.status, 'bytes', text.length, 'head', text.slice(0, 400).replace(/\s+/g, ' '));
  if (!response.ok) throw new Error(`SSSTik HTTP ${response.status}`);
  const hrefs = [...text.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const direct = hrefs.find((v) => /^https?:\/\//i.test(v) && /\.mp4|video|ssscdn|tikcdn|tiktokcdn/i.test(v)) || '';
  if (!direct) throw new Error(`SSSTik no video URL; hrefs=${hrefs.slice(0, 8).join(',')}`);
  return videoMedia(direct, { title: 'TikTok' }, { Referer: 'https://ssstik.io/' });
}

async function tryTikwmPost(inputUrl) {
  const failures = [];
  for (const endpoint of ['https://www.tikwm.com/api/', 'https://tikwm.com/api/']) {
    try {
      const body = new URLSearchParams({ url: inputUrl, hd: '1', web: '1' });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': browserUA, Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://www.tikwm.com', Referer: 'https://www.tikwm.com/',
        },
        body, redirect: 'follow', signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      console.log('tikwm-post', endpoint, 'status', response.status, 'bytes', text.length, 'head', text.slice(0, 160));
      if (!response.ok) { failures.push(`${endpoint}:${response.status}`); continue; }
      const payload = JSON.parse(text);
      if (payload?.code !== 0 || !payload?.data) { failures.push(`${endpoint}:code=${payload?.code}`); continue; }
      const data = payload.data;
      const direct = absoluteUrl(data.hdplay || data.play);
      if (!direct) { failures.push(`${endpoint}:no-video`); continue; }
      return videoMedia(direct, data, { Referer: 'https://www.tikwm.com/' });
    } catch (error) { failures.push(`${endpoint}:${error?.message || error}`); }
  }
  throw new Error(`TikWM POST failed: ${failures.join(', ')}`);
}

async function tryYtDlp(inputUrl) {
  const binary = path.join(process.cwd(), 'bin', 'yt-dlp');
  await chmod(binary, 0o755).catch(() => {});
  try {
    const { stdout } = await execFileAsync(binary, [
      '--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', '--no-check-certificates', '--user-agent', browserUA, '--', inputUrl,
    ], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` } });
    const info = JSON.parse(stdout);
    console.log('yt-dlp TikTok ok', { id: info.id, duration: info.duration, formats: info.formats?.length || 0 });
  } catch (error) { console.log('yt-dlp TikTok failed', String(error?.stderr || error?.message || error).slice(0, 1500)); }
}

try {
  const redirect = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': browserUA }, signal: AbortSignal.timeout(20000) });
  console.log('shortlink redirect', redirect.status, redirect.url);
  await redirect.body?.cancel().catch(() => {});
} catch (error) { console.log('shortlink redirect failed', error?.message || error); }

await tryYtDlp(url);

let media;
try {
  media = await parseMedia(url);
  console.log('parseMedia provider ok');
} catch (error) {
  console.log('parseMedia failed', error?.code, error?.message);
  const providers = [
    ['ClipX', tryClipX],
    ['Slbjs', trySlbjs],
    ['SSSTik', trySsstik],
    ['TikWM POST', tryTikwmPost],
  ];
  let lastError = error;
  for (const [name, fn] of providers) {
    try {
      media = await fn(url);
      console.log(`${name} fallback ok`);
      break;
    } catch (providerError) {
      console.log(`${name} failed`, providerError?.message || providerError);
      lastError = providerError;
    }
  }
  if (!media) throw lastError;
}

console.log('platform', media?.platform, 'duration', media?.duration, 'videos', media?.videos?.length || 0);
const best = chooseBestVideo(media?.videos || []);
if (!best) throw new Error('No video candidate resolved');
console.log('best', { quality: best.quality, ext: best.ext, filesize: best.filesize, duration: best.duration, urlHost: new URL(best.url).host });

let prepared;
try {
  prepared = await prepareWhatsAppStatusHQ({ sourceUrl: url, platform: 'tiktok', video: best });
  console.log('prepared', prepared.quality, 'clips', prepared.clips.length, 'profile', prepared.profile?.mode);
  for (const clip of prepared.clips) console.log('clip', clip.index, clip.count, clip.duration, clip.size, clip.filePath);
} finally {
  if (prepared?.cleanup) await prepared.cleanup();
}
