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

function absoluteTikwm(value, base = 'https://www.tikwm.com') {
  if (!value) return '';
  try { return new URL(value, base).toString(); } catch { return ''; }
}

async function tryTikwmPost(inputUrl) {
  const failures = [];
  for (const endpoint of ['https://www.tikwm.com/api/', 'https://tikwm.com/api/']) {
    try {
      const body = new URLSearchParams({ url: inputUrl, hd: '1', web: '1' });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': browserUA,
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: 'https://www.tikwm.com',
          Referer: 'https://www.tikwm.com/',
        },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      console.log('tikwm-post', endpoint, 'status', response.status, 'bytes', text.length, 'head', text.slice(0, 160));
      if (!response.ok) { failures.push(`${endpoint}:${response.status}`); continue; }
      const payload = JSON.parse(text);
      if (payload?.code !== 0 || !payload?.data) { failures.push(`${endpoint}:code=${payload?.code}`); continue; }
      const data = payload.data;
      const direct = absoluteTikwm(data.hdplay || data.play);
      if (!direct) { failures.push(`${endpoint}:no-video`); continue; }
      return {
        platform: 'TikTok',
        title: data.title || '',
        duration: Number(data.duration || 0) || null,
        videos: [{
          url: direct,
          quality: data.hdplay ? 'HD' : 'No watermark',
          width: data.width ?? null,
          height: data.height ?? null,
          ext: 'mp4',
          hasAudio: true,
          source: 'direct',
          headers: {
            'User-Agent': browserUA,
            Referer: 'https://www.tikwm.com/',
          },
          filesize: null,
        }],
        images: [],
        audios: [],
      };
    } catch (error) {
      failures.push(`${endpoint}:${error?.message || error}`);
    }
  }
  throw new Error(`TikWM POST failed: ${failures.join(', ')}`);
}

async function tryYtDlp(inputUrl) {
  const binary = path.join(process.cwd(), 'bin', 'yt-dlp');
  await chmod(binary, 0o755).catch(() => {});
  try {
    const { stdout } = await execFileAsync(binary, [
      '--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist',
      '--no-check-certificates', '--user-agent', browserUA, '--', inputUrl,
    ], {
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` },
    });
    const info = JSON.parse(stdout);
    console.log('yt-dlp TikTok ok', { id: info.id, duration: info.duration, formats: info.formats?.length || 0 });
  } catch (error) {
    console.log('yt-dlp TikTok failed', String(error?.stderr || error?.message || error).slice(0, 1500));
  }
}

try {
  const redirect = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': browserUA }, signal: AbortSignal.timeout(20000) });
  console.log('shortlink redirect', redirect.status, redirect.url);
  await redirect.body?.cancel().catch(() => {});
} catch (error) {
  console.log('shortlink redirect failed', error?.message || error);
}

await tryYtDlp(url);

let media;
try {
  media = await parseMedia(url);
  console.log('parseMedia provider ok');
} catch (error) {
  console.log('parseMedia failed', error?.code, error?.message);
  media = await tryTikwmPost(url);
  console.log('TikWM POST fallback ok');
}

console.log('platform', media?.platform, 'duration', media?.duration, 'videos', media?.videos?.length || 0);
const best = chooseBestVideo(media?.videos || []);
if (!best) throw new Error('No video candidate resolved');
console.log('best', { quality: best.quality, ext: best.ext, filesize: best.filesize, duration: best.duration, urlHost: new URL(best.url).host });

let prepared;
try {
  prepared = await prepareWhatsAppStatusHQ({ sourceUrl: url, platform: 'tiktok', video: best });
  console.log('prepared', prepared.quality, 'clips', prepared.clips.length, 'profile', prepared.profile?.mode);
  for (const clip of prepared.clips) {
    console.log('clip', clip.index, clip.count, clip.duration, clip.size, clip.filePath);
  }
} finally {
  if (prepared?.cleanup) await prepared.cleanup();
}
