import { parseMedia, chooseBestVideo } from '../src/downloader.js';

const cases = [
  ['Reels', 'https://www.instagram.com/reel/DdVLsscjj2o/?stkn=MXV3a2hncmE3cWZheQ=='],
  ['YouTube', 'https://youtu.be/RKdxQwnRRqw?si=GJX9HDe4OBsxwBYQ'],
  ['TikTok', 'https://vt.tiktok.com/ZSqqYxc13/'],
  ['Threads', 'https://www.threads.com/share/BALVYg5Lmq/'],
];

let failed = false;

for (const [name, url] of cases) {
  try {
    const media = await parseMedia(url);
    const video = chooseBestVideo(media.videos || []);
    const image = media.images?.[0];
    if (!video && !image) throw new Error('no media returned');

    const target = video?.url || image?.url;
    const shouldProbeDirectUrl = name !== 'YouTube';
    let reachable = null;
    let status = 0;

    if (shouldProbeDirectUrl) {
      try {
        const r = await fetch(target, {
          method: 'GET',
          headers: video?.headers || image?.headers || {},
          signal: AbortSignal.timeout(15000),
        });
        status = r.status;
        reachable = r.ok || r.status === 206;
        await r.body?.cancel();
      } catch {
        reachable = false;
      }
    }

    console.log(JSON.stringify({
      name,
      ok: true,
      kind: video ? 'video' : 'image',
      quality: video?.quality || null,
      reachable,
      status,
      customHeaders: Boolean(video?.headers && Object.keys(video.headers).length),
      note: name === 'YouTube' ? 'metadata only; production uses dedicated yt-dlp/FFmpeg pipeline' : undefined,
    }));

    if (shouldProbeDirectUrl && !reachable) failed = true;
  } catch (error) {
    failed = true;
    console.error(JSON.stringify({
      name,
      ok: false,
      code: error?.code || null,
      error: String(error?.message || error).slice(0, 1200),
    }));
  }
}

if (failed) process.exit(1);
