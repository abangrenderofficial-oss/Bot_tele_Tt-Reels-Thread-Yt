import { parseMedia, chooseBestVideo } from '../src/downloader.js';

const CASES = {
  reels: 'https://www.instagram.com/reel/DdVLsscjj2o/?stkn=MXV3a2hncmE3cWZheQ==',
  youtube: 'https://youtu.be/RKdxQwnRRqw?si=GJX9HDe4OBsxwBYQ',
  tiktok: 'https://vt.tiktok.com/ZSqqYxc13/',
  threads: 'https://www.threads.com/share/BALVYg5Lmq/',
};

export default async function handler(req, res) {
  const key = String(req.query?.case || '').toLowerCase();
  const url = CASES[key];
  if (!url) {
    return res.status(400).json({ ok: false, cases: Object.keys(CASES) });
  }

  const started = Date.now();
  try {
    const media = await parseMedia(url);
    const best = chooseBestVideo(media.videos);
    return res.status(200).json({
      ok: true,
      case: key,
      ms: Date.now() - started,
      title: media.title || '',
      videos: media.videos?.length || 0,
      images: media.images?.length || 0,
      audios: media.audios?.length || 0,
      best: best ? {
        quality: best.quality || '',
        ext: best.ext || '',
        hasAudio: best.hasAudio !== false,
        needsHeaders: !!best.headers && Object.keys(best.headers).length > 0,
        urlHost: (() => { try { return new URL(best.url).host; } catch { return ''; } })(),
      } : null,
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      case: key,
      ms: Date.now() - started,
      code: error?.code || 'ERROR',
      error: String(error?.message || error).slice(0, 1200),
    });
  }
}
