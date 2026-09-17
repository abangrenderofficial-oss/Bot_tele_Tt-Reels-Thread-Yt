import { parseMedia, chooseBestVideo, needsCustomHeaders } from '../downloader.js';
import { parseThreadsPost } from '../threads.js';
import { parseTwitterVideo } from '../twitter.js';
import { parseYouTubeFree } from '../youtube-free.js';

const TIKWM_API = 'https://www.tikwm.com/api/';
const TIKWM_ORIGIN = 'https://www.tikwm.com';
const TIKTOK_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function absoluteUrl(value, origin = TIKWM_ORIGIN) {
  if (!value || typeof value !== 'string') return '';
  try { return new URL(value, origin).toString(); } catch { return ''; }
}

async function tikwmRequest(attempt) {
  const browserHeaders = {
    Accept: 'application/json',
    'User-Agent': TIKTOK_BROWSER_USER_AGENT,
    Referer: 'https://www.tikwm.com/',
    Origin: 'https://www.tikwm.com',
  };
  const timeout = Number(process.env.DOWNLOADER_TIKWM_TIMEOUT_MS || process.env.DOWNLOADER_TIMEOUT_MS || 25000);

  if (attempt.method === 'GET') {
    const endpoint = new URL(TIKWM_API);
    endpoint.searchParams.set('url', attempt.url);
    if (attempt.hd) endpoint.searchParams.set('hd', attempt.hd);
    const response = await fetch(endpoint, {
      headers: browserHeaders,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`TikWM HTTP ${response.status}`);
    return response.json();
  }

  const form = new URLSearchParams();
  form.set('url', attempt.url);
  if (attempt.hd) form.set('hd', attempt.hd);
  const response = await fetch(TIKWM_API, {
    method: 'POST',
    headers: { ...browserHeaders, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: form.toString(),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`TikWM HTTP ${response.status}`);
  return response.json();
}

function tikwmRetryUrls(url) {
  const retryUrls = [url];
  try {
    const input = new URL(url);
    const shortMatch = input.hostname.match(/^(?:vt|vm)\.tiktok\.com$/i) && input.pathname.match(/^\/([^/?#]+)/);
    const code = shortMatch?.[1] || '';
    if (code) {
      for (const candidate of [
        `https://${input.hostname}/${code}/`,
        `https://www.tiktok.com/t/${code}/`,
        `https://www.tiktok.com/t/${code}`,
      ]) {
        if (!retryUrls.includes(candidate)) retryUrls.push(candidate);
      }
    }
  } catch {}
  return retryUrls;
}

async function resolveTikTok(url) {
  const attempts = [{ method: 'GET', url, hd: '1' }];
  for (const retryUrl of tikwmRetryUrls(url)) {
    attempts.push({ method: 'GET', url: retryUrl, hd: '' });
    attempts.push({ method: 'POST', url: retryUrl, hd: '0' });
    attempts.push({ method: 'POST', url: retryUrl, hd: '1' });
  }

  let payload = null;
  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      const candidate = await tikwmRequest(attempts[index]);
      if (candidate?.code === 0 && candidate?.data) {
        payload = candidate;
        break;
      }
      lastError = new Error(candidate?.msg || 'TikWM could not resolve this TikTok link.');
    } catch (error) {
      lastError = error;
    }
    if (index < attempts.length - 1) await new Promise((resolve) => setTimeout(resolve, 350));
  }

  if (!payload?.data) {
    try {
      const fallback = await parseMedia(url);
      return { ...fallback, platform: 'TikTok', canonicalUrl: fallback?.canonicalUrl || url };
    } catch (fallbackError) {
      const error = new Error(`TikWM: ${lastError?.message || 'failed'}; fallback: ${fallbackError?.message || fallbackError}`);
      error.code = fallbackError?.code || 'DOWNLOADER_ERROR';
      throw error;
    }
  }

  const data = payload.data;
  const authorHandle = String(data?.author?.unique_id || data?.author?.uniqueId || '').trim().replace(/^@/, '');
  const videoId = String(data?.id || '').trim();
  const canonicalUrl = videoId
    ? `https://www.tiktok.com/@${encodeURIComponent(authorHandle || '_')}/video/${encodeURIComponent(videoId)}`
    : url;
  const headers = {
    'User-Agent': TIKTOK_BROWSER_USER_AGENT,
    Referer: canonicalUrl || 'https://www.tiktok.com/',
    Accept: 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8',
  };

  const videos = [];
  const seen = new Set();
  const addVideo = (value, quality) => {
    const direct = absoluteUrl(value);
    if (!direct || seen.has(direct)) return;
    seen.add(direct);
    videos.push({
      url: direct,
      sourceUrl: canonicalUrl,
      quality,
      width: data.width ?? null,
      height: data.height ?? null,
      ext: 'mp4',
      hasAudio: true,
      source: 'direct',
      headers,
      filesize: null,
    });
  };
  addVideo(data.hdplay, 'HD');
  addVideo(data.play, 'No watermark');

  const images = Array.isArray(data.images)
    ? data.images.map((item) => ({ url: absoluteUrl(typeof item === 'string' ? item : item?.url) })).filter((item) => item.url)
    : [];
  const musicUrl = absoluteUrl(data.music);
  const audios = musicUrl ? [{ url: musicUrl, quality: 'audio' }] : [];

  if (!videos.length && !images.length && !audios.length) {
    const error = new Error('No downloadable TikTok media was found.');
    error.code = 'NO_MEDIA';
    throw error;
  }

  return {
    platform: 'TikTok',
    title: data.title ?? '',
    thumbnail: absoluteUrl(data.cover || data.origin_cover),
    duration: data.duration ?? null,
    canonicalUrl,
    images,
    videos,
    audios,
  };
}

export async function resolveMedia(platform, url) {
  if (platform === 'threads') return parseThreadsPost(url);
  if (platform === 'twitter') return parseTwitterVideo(url);
  if (platform === 'tiktok') return resolveTikTok(url);
  if (platform === 'youtube') {
    try {
      return await parseMedia(url);
    } catch (primaryError) {
      try {
        return await parseYouTubeFree(url);
      } catch (fallbackError) {
        const error = new Error(`yt-dlp: ${primaryError?.message || primaryError}; free fallback: ${fallbackError?.message || fallbackError}`);
        error.code = primaryError?.code === 'NO_MEDIA' && fallbackError?.code === 'NO_MEDIA' ? 'NO_MEDIA' : 'DOWNLOADER_ERROR';
        throw error;
      }
    }
  }
  return parseMedia(url);
}

export { chooseBestVideo, needsCustomHeaders };
