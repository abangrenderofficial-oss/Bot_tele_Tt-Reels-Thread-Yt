import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const TEST_URL = 'https://vt.tiktok.com/ZSqqYxc13/';

export default async function handler(req, res) {
  const started = Date.now();
  let prepared = null;

  try {
    const media = await parseMedia(TEST_URL);
    const best = chooseBestVideo(media?.videos || []);
    if (!best) {
      return res.status(200).json({
        ok: false,
        stage: 'resolve',
        ms: Date.now() - started,
        error: 'No video candidate resolved',
      });
    }

    prepared = await prepareWhatsAppStatusHQ({
      sourceUrl: TEST_URL,
      platform: 'tiktok',
      video: best,
    });

    const clips = prepared.clips.map((clip) => ({
      index: clip.index,
      count: clip.count,
      duration: clip.duration,
      size: clip.size,
      attempt: clip.attempt,
    }));

    return res.status(200).json({
      ok: clips.length > 0,
      stage: 'complete',
      ms: Date.now() - started,
      sourceDuration: prepared.source?.duration || null,
      sourceWidth: prepared.source?.width || null,
      sourceHeight: prepared.source?.height || null,
      quality: prepared.quality,
      profile: prepared.profile?.mode || null,
      switchedForLength: Boolean(prepared.switchedForLength),
      clips,
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      stage: 'error',
      ms: Date.now() - started,
      code: error?.code || 'ERROR',
      error: String(error?.message || error).slice(0, 1800),
    });
  } finally {
    await prepared?.cleanup?.().catch(() => {});
  }
}
