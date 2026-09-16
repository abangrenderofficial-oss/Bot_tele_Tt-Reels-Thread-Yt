import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TIKWM_API = 'https://www.tikwm.com/api/';
const TIKWM_ORIGIN = 'https://www.tikwm.com';

function normalizeInfo(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function absoluteUrl(value, origin = TIKWM_ORIGIN) {
  if (!value || typeof value !== 'string') return '';
  try {
    return new URL(value, origin).toString();
  } catch {
    return '';
  }
}

function qualityLabel(format = {}) {
  if (format.height) return `${format.height}p`;
  if (format.format_note) return String(format.format_note);
  if (format.format) return String(format.format);
  return 'video';
}

function hasAudio(format = {}) {
  return format.acodec && format.acodec !== 'none';
}

function hasVideo(format = {}) {
  return format.vcodec && format.vcodec !== 'none';
}

function usableVideoFormats(info = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const direct = formats
    .filter((f) => f?.url && hasVideo(f) && hasAudio(f))
    .map((f) => ({
      url: f.url,
      quality: qualityLabel(f),
      width: f.width ?? null,
      height: f.height ?? null,
      ext: f.ext ?? null,
      hasAudio: true,
      source: 'direct',
      headers: f.http_headers ?? info.http_headers ?? null,
      filesize: f.filesize ?? f.filesize_approx ?? null,
    }));

  if (direct.length) return direct;

  if (info.url) {
    return [{
      url: info.url,
      quality: info.height ? `${info.height}p` : 'video',
      width: info.width ?? null,
      height: info.height ?? null,
      ext: info.ext ?? null,
      hasAudio: info.acodec !== 'none',
      source: 'direct',
      headers: info.http_headers ?? null,
      filesize: info.filesize ?? info.filesize_approx ?? null,
    }];
  }

  return [];
}

async function parseTikTok(url) {
  const endpoint = new URL(TIKWM_API);
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('hd', '1');

  let response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ARDownloader/1.0)',
      },
      signal: AbortSignal.timeout(Number(process.env.DOWNLOADER_TIMEOUT_MS || 25000)),
    });
  } catch (error) {
    const err = new Error(error?.message || 'TikWM request failed.');
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`TikWM HTTP ${response.status}`);
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const err = new Error('TikWM returned invalid JSON.');
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  if (payload?.code !== 0 || !payload?.data) {
    const err = new Error(payload?.msg || 'TikWM could not resolve this TikTok link.');
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  const data = payload.data;
  const videos = [];
  const seen = new Set();

  const addVideo = (value, quality) => {
    const direct = absoluteUrl(value);
    if (!direct || seen.has(direct)) return;
    seen.add(direct);
    videos.push({
      url: direct,
      quality,
      width: data.width ?? null,
      height: data.height ?? null,
      ext: 'mp4',
      hasAudio: true,
      source: 'direct',
      headers: null,
      filesize: null,
    });
  };

  addVideo(data.hdplay, 'HD');
  addVideo(data.play, 'No watermark');

  const images = Array.isArray(data.images)
    ? data.images
        .map((item) => ({ url: absoluteUrl(typeof item === 'string' ? item : item?.url) }))
        .filter((item) => item.url)
    : [];

  const musicUrl = absoluteUrl(data.music);
  const audios = musicUrl ? [{ url: musicUrl, quality: 'audio' }] : [];

  if (!videos.length && !images.length && !audios.length) {
    const err = new Error('No downloadable TikTok media was found.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  return {
    platform: 'TikTok',
    title: data.title ?? '',
    thumbnail: absoluteUrl(data.cover || data.origin_cover),
    duration: data.duration ?? null,
    images,
    videos,
    audios,
  };
}

async function parseWithYtDlp(url) {
  const binary = path.join(process.cwd(), 'bin', 'yt-dlp');
  try {
    await chmod(binary, 0o755).catch(() => {});
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--no-playlist',
      '--no-check-certificates',
      '--prefer-free-formats',
      '--js-runtimes', `node:${process.execPath}`,
      '--remote-components', 'ejs:github',
      '--',
      url,
    ];

    const { stdout } = await execFileAsync(binary, args, {
      timeout: Number(process.env.DOWNLOADER_TIMEOUT_MS || 45000),
      maxBuffer: 12 * 1024 * 1024,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` },
    });

    const info = normalizeInfo(stdout);
    if (!info) {
      const err = new Error('yt-dlp returned invalid metadata.');
      err.code = 'NO_MEDIA';
      throw err;
    }

    const videos = usableVideoFormats(info);
    if (!videos.length) {
      const err = new Error('No directly downloadable video format was found.');
      err.code = 'NO_MEDIA';
      throw err;
    }

    return {
      platform: info.extractor_key ?? info.extractor ?? null,
      title: info.title ?? '',
      thumbnail: info.thumbnail ?? '',
      duration: info.duration ?? null,
      images: [],
      videos,
      audios: [],
    };
  } catch (error) {
    if (error?.code === 'NO_MEDIA') throw error;
    const detail = error?.stderr || error?.stdout || error?.message || 'yt-dlp failed.';
    const err = new Error(String(detail));
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }
}

export async function parseMedia(url) {
  if (/threads\.(net|com)/i.test(url)) {
    const err = new Error('Threads needs a dedicated free extractor adapter.');
    err.code = 'THREADS_ADAPTER_PENDING';
    throw err;
  }

  if (/(^|\.)tiktok\.com/i.test(new URL(url).hostname)) {
    return parseTikTok(url);
  }

  return parseWithYtDlp(url);
}

function qualityScore(value = '') {
  const text = String(value).toLowerCase();
  if (text.includes('hd')) return 10000;
  const match = text.match(/(\d{3,4})p?/i);
  return match ? Number(match[1]) : 0;
}

export function chooseBestVideo(videos = []) {
  if (!videos.length) return null;

  return [...videos].sort((a, b) => {
    const aDirectAudio = Number(a?.hasAudio !== false && a?.source === 'direct');
    const bDirectAudio = Number(b?.hasAudio !== false && b?.source === 'direct');
    if (aDirectAudio !== bDirectAudio) return bDirectAudio - aDirectAudio;

    const aAudio = Number(a?.hasAudio !== false);
    const bAudio = Number(b?.hasAudio !== false);
    if (aAudio !== bAudio) return bAudio - aAudio;

    return qualityScore(b?.quality) - qualityScore(a?.quality);
  })[0];
}

export function needsCustomHeaders(item) {
  const headers = item?.headers && typeof item.headers === 'object' ? item.headers : null;
  if (!headers) return false;
  const keys = Object.keys(headers).filter((key) => {
    const lower = key.toLowerCase();
    return lower !== 'accept-language' && lower !== 'accept';
  });
  return keys.length > 0;
}
