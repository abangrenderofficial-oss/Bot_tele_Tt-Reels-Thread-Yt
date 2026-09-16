import { createWriteStream } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const TIKWM_API = 'https://www.tikwm.com/api/';
const TIKWM_ORIGIN = 'https://www.tikwm.com';

function absoluteUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    return new URL(value, TIKWM_ORIGIN).toString();
  } catch {
    return '';
  }
}

function cleanName(value, fallback = 'TikTok sound') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function audioExtension(contentType = '', url = '') {
  const type = String(contentType).toLowerCase();
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  try {
    const ext = path.extname(new URL(url).pathname).replace(/^\./, '').toLowerCase();
    if (['mp3', 'm4a', 'aac', 'ogg'].includes(ext)) return ext;
  } catch {}
  return 'mp3';
}

async function download(url, filePath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARDownloader/1.0)' },
    signal: AbortSignal.timeout(Number(process.env.MEDIA_FETCH_TIMEOUT_MS || 45000)),
  });

  if (!response.ok || !response.body) {
    const err = new Error(`Media source returned HTTP ${response.status}.`);
    err.code = 'MEDIA_FETCH_ERROR';
    throw err;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Downloaded TikTok slideshow asset is empty.');
    err.code = 'MEDIA_DOWNLOAD_EMPTY';
    throw err;
  }
  return { size: fileStat.size, contentType: response.headers.get('content-type') || '' };
}

function parseClockDuration(value) {
  const match = String(value || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

async function probeDuration(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      timeout: Number(process.env.MEDIA_PROBE_TIMEOUT_MS || 8000),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }
  return parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '') || null;
}

async function probeImageSize(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      timeout: Number(process.env.MEDIA_PROBE_TIMEOUT_MS || 8000),
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const matches = [...stderr.matchAll(/\b(\d{2,5})x(\d{2,5})\b/g)]
    .map((match) => ({ width: Number(match[1]), height: Number(match[2]) }))
    .filter((item) => item.width >= 64 && item.height >= 64);

  return matches[0] || null;
}

async function cleanup(paths) {
  await Promise.all(paths.map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function resolveTikTokSlideshow(url) {
  const endpoint = new URL(TIKWM_API);
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('hd', '1');

  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; ARDownloader/1.0)',
    },
    signal: AbortSignal.timeout(Number(process.env.DOWNLOADER_TIMEOUT_MS || 25000)),
  });

  if (!response.ok) throw new Error(`TikWM HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.code !== 0 || !payload?.data) throw new Error(payload?.msg || 'TikTok slideshow could not be resolved.');

  const data = payload.data;
  const images = (Array.isArray(data.images) ? data.images : [])
    .map((item) => ({ url: absoluteUrl(typeof item === 'string' ? item : item?.url) }))
    .filter((item) => item.url);

  const musicInfo = data.music_info && typeof data.music_info === 'object' ? data.music_info : {};
  const musicUrl = absoluteUrl(musicInfo.play || musicInfo.url || data.music);
  const musicTitle = cleanName(musicInfo.title || musicInfo.name || 'TikTok sound');
  const musicAuthor = cleanName(
    musicInfo.author || musicInfo.artist || data.author?.nickname || data.author?.unique_id || '',
    '',
  );

  if (!images.length) {
    const err = new Error('This TikTok post is not a photo slideshow.');
    err.code = 'NOT_SLIDESHOW';
    throw err;
  }
  if (!musicUrl) {
    const err = new Error('TikTok slideshow audio was not found.');
    err.code = 'NO_AUDIO';
    throw err;
  }

  return {
    title: String(data.title || '').trim(),
    duration: Number(musicInfo.duration || data.duration || 0) || null,
    images,
    audio: {
      url: musicUrl,
      title: musicTitle,
      performer: musicAuthor,
    },
  };
}

export async function prepareTikTokSound(audio) {
  if (!audio?.url) throw new Error('TikTok sound URL is missing.');
  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-ttsound-${attemptId}`);
  const tempPath = `${base}.bin`;
  const paths = [tempPath];

  try {
    const downloaded = await download(audio.url, tempPath);
    const ext = audioExtension(downloaded.contentType, audio.url);
    const finalPath = `${base}.${ext}`;
    await rm(finalPath, { force: true }).catch(() => {});
    await import('node:fs/promises').then(({ rename }) => rename(tempPath, finalPath));
    paths.push(finalPath);

    // Keep the downloadable filename identical to the TikTok sound title.
    // Performer/creator is sent separately as Telegram audio metadata.
    const soundTitle = cleanName(audio.title);
    return {
      filePath: finalPath,
      fileName: `${soundTitle}.${ext}`,
      title: soundTitle,
      performer: cleanName(audio.performer || '', ''),
      cleanup: async () => cleanup(paths),
    };
  } catch (error) {
    await cleanup(paths);
    throw error;
  }
}

function even(value) {
  const rounded = Math.max(2, Math.round(Number(value || 2)));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function canvasFromSource(source, maxDimension) {
  const sourceWidth = Number(source?.width || 0);
  const sourceHeight = Number(source?.height || 0);
  if (!sourceWidth || !sourceHeight) return { width: 1080, height: 1920 };

  const sourceMax = Math.max(sourceWidth, sourceHeight);
  const targetMax = Math.min(sourceMax, maxDimension);
  const scale = targetMax / sourceMax;
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
}

function videoPlan(durationSeconds, maxBytes, source, safety = 0.76) {
  const duration = Math.max(1, Number(durationSeconds || 1));
  const targetBytes = Math.floor(Number(maxBytes) * safety);
  const audioKbps = 128;
  const totalKbps = Math.floor((targetBytes * 8) / duration / 1000);
  const videoKbps = Math.max(350, Math.min(2200, totalKbps - audioKbps - 32));

  const maxDimension = videoKbps >= 1300 ? 1080 : videoKbps >= 700 ? 720 : 540;
  const canvas = canvasFromSource(source, maxDimension);
  return {
    ...canvas,
    videoKbps,
    audioKbps: videoKbps >= 700 ? 128 : 96,
    targetBytes,
  };
}

async function renderSlideshow(listPath, audioPath, outputPath, duration, plan) {
  // Never stretch. Every slide is fitted inside a canvas that has the same
  // aspect ratio as the source TikTok slideshow, then padded only if a slide
  // itself has a different ratio.
  const filter = [
    `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    'fps=30',
    'format=yuv420p',
  ].join(',');

  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-i', audioPath,
    '-vf', filter,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', String(process.env.SLIDESHOW_PRESET || 'veryfast'),
    '-tune', 'stillimage',
    '-b:v', `${plan.videoKbps}k`,
    '-maxrate', `${Math.floor(plan.videoKbps * 1.08)}k`,
    '-bufsize', `${Math.max(1000, plan.videoKbps * 2)}k`,
    '-c:a', 'aac',
    '-b:a', `${plan.audioKbps}k`,
    '-ac', '2',
    '-t', String(duration),
    '-shortest',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    outputPath,
  ], {
    timeout: Number(process.env.SLIDESHOW_RENDER_TIMEOUT_MS || 95000),
    maxBuffer: 8 * 1024 * 1024,
  });

  return stat(outputPath);
}

export async function prepareTikTokSlideshowVideo(slideshow, maxBytes) {
  if (!slideshow?.images?.length || !slideshow?.audio?.url) throw new Error('TikTok slideshow assets are incomplete.');
  const limit = Number(maxBytes || 0);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('A valid Telegram upload limit is required.');

  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-ttslide-${attemptId}`);
  const audioPath = `${base}-audio.bin`;
  const listPath = `${base}-concat.txt`;
  const outputPath = `${base}.mp4`;
  const retryPath = `${base}-retry.mp4`;
  const imagePaths = slideshow.images.map((_, index) => `${base}-img-${String(index + 1).padStart(2, '0')}.jpg`);
  const allPaths = [audioPath, listPath, outputPath, retryPath, ...imagePaths];

  try {
    await Promise.all(slideshow.images.map((image, index) => download(image.url, imagePaths[index])));
    await download(slideshow.audio.url, audioPath);

    const [probedDuration, sourceSize] = await Promise.all([
      probeDuration(audioPath),
      probeImageSize(imagePaths[0]),
    ]);
    const duration = Math.max(1, Number(probedDuration || slideshow.duration || slideshow.images.length * 3));
    const secondsPerImage = duration / slideshow.images.length;
    const lines = [];
    for (const imagePath of imagePaths) {
      lines.push(`file '${imagePath.replaceAll("'", "'\\''")}'`);
      lines.push(`duration ${secondsPerImage.toFixed(6)}`);
    }
    lines.push(`file '${imagePaths.at(-1).replaceAll("'", "'\\''")}'`);
    await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');

    let plan = videoPlan(duration, limit, sourceSize, 0.76);
    let result = await renderSlideshow(listPath, audioPath, outputPath, duration, plan);

    if (result.size > limit) {
      plan = videoPlan(duration, limit, sourceSize, 0.58);
      result = await renderSlideshow(listPath, audioPath, retryPath, duration, plan);
      await rm(outputPath, { force: true }).catch(() => {});
    }

    const retryStat = await stat(retryPath).catch(() => null);
    const finalPath = result.size > limit ? null : retryStat?.size ? retryPath : outputPath;
    if (!finalPath) {
      const err = new Error(`Rendered slideshow is still too large for Telegram (${result.size} bytes).`);
      err.code = 'SLIDESHOW_TOO_LARGE';
      throw err;
    }

    return {
      filePath: finalPath,
      quality: `${plan.width}x${plan.height} • ratio asal • ${slideshow.images.length} slides • original TikTok sound`,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}

export async function sendTikTokSoundUpload(chatId, prepared, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram bot token is not configured.');

  const buffer = await readFile(prepared.filePath);
  const ext = path.extname(prepared.fileName).replace(/^\./, '').toLowerCase();
  const mime = ext === 'm4a' ? 'audio/mp4' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
  const form = new FormData();
  form.set('chat_id', String(chatId));
  if (caption) form.set('caption', String(caption).slice(0, 1024));
  if (prepared.title) form.set('title', prepared.title);
  if (prepared.performer) form.set('performer', prepared.performer);
  form.set('audio', new Blob([buffer], { type: mime }), prepared.fileName);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 55000)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.description || `Telegram sendAudio failed (${response.status}).`);
  return payload.result;
}
