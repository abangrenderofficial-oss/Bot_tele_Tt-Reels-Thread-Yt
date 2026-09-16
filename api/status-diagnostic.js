import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const execFileAsync = promisify(execFile);
const TEST_URL = 'https://www.tiktok.com/@j_k_123_7/video/7654589734496341262';

async function probeDimensions(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      timeout: 12000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }
  const match = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
}

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

    const output = await probeDimensions(prepared.filePath);
    const sourceRatio = prepared.source?.width && prepared.source?.height
      ? prepared.source.width / prepared.source.height
      : null;
    const outputRatio = output.width && output.height ? output.width / output.height : null;
    const ratioDiff = sourceRatio && outputRatio ? Math.abs(outputRatio - sourceRatio) / sourceRatio : null;
    const ratioOk = ratioDiff === null || ratioDiff <= 0.02;

    return res.status(200).json({
      ok: Boolean(prepared.filePath && prepared.size && ratioOk),
      stage: 'complete',
      ms: Date.now() - started,
      singleFile: true,
      sourceDuration: prepared.source?.duration || null,
      sourceWidth: prepared.source?.width || null,
      sourceHeight: prepared.source?.height || null,
      outputWidth: output.width,
      outputHeight: output.height,
      ratioDiff,
      size: prepared.size,
      quality: prepared.quality,
      profile: prepared.profile?.mode || null,
      tier: prepared.profile?.tier || null,
      videoKbps: prepared.profile?.videoKbps || null,
      attempt: prepared.attempt || null,
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
