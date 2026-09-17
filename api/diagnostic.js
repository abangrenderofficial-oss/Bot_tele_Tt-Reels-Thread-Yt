import { detectPlatform } from '../src/platform.js';
import { chooseBestVideo, resolveMedia } from '../src/bot/media-resolver.js';

const CASES = {
  reels: 'https://www.instagram.com/reel/DdVLsscjj2o/?stkn=MXV3a2hncmE3cWZheQ==',
  youtube: 'https://youtu.be/RKdxQwnRRqw?si=GJX9HDe4OBsxwBYQ',
  tiktok: 'https://vt.tiktok.com/ZSqqYxc13/',
  threads: 'https://www.threads.com/share/BALVYg5Lmq/',
};

async function probeMedia(item) {
  if (!item?.url) return { ok: false, error: 'no_media_url' };
  try {
    const response = await fetch(item.url, {
      redirect: 'follow',
      headers: {
        ...(item.headers || {}),
        Range: 'bytes=0-1023',
      },
      signal: AbortSignal.timeout(15000),
    });
    const result = {
      ok: response.ok || response.status === 206,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      contentLength: response.headers.get('content-length') || '',
      finalHost: (() => { try { return new URL(response.url).host; } catch { return ''; } })(),
    };
    await response.body?.cancel().catch(() => {});
    return result;
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
}

export default async function handler(req, res) {
  const key = String(req.query?.case || '').toLowerCase();
  const url = CASES[key];
  if (!url) return res.status(400).json({ ok: false, cases: Object.keys(CASES) });

  const platform = detectPlatform(url);
  const started = Date.now();
  try {
    const media = await resolveMedia(platform, url);
    const best = chooseBestVideo(media.videos || []);
    const firstMedia = best || media.images?.[0] || media.audios?.[0] || null;
    const probe = await probeMedia(firstMedia);
    return res.status(200).json({
      ok: Boolean(firstMedia) && probe.ok,
      extracted: true,
      case: key,
      platform,
      architecture: 'isolated-resolver-v1',
      ms: Date.now() - started,
      title: media.title || '',
      videos: media.videos?.length || 0,
      images: media.images?.length || 0,
      audios: media.audios?.length || 0,
      probe,
      best: best ? {
        quality: best.quality || '',
        ext: best.ext || '',
        hasAudio: best.hasAudio !== false,
        source: best.source || '',
        needsHeaders: !!best.headers && Object.keys(best.headers).length > 0,
        urlHost: (() => { try { return new URL(best.url).host; } catch { return ''; } })(),
      } : null,
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      extracted: false,
      case: key,
      platform,
      ms: Date.now() - started,
      code: error?.code || 'ERROR',
      error: String(error?.message || error).slice(0, 1800),
    });
  }
}
