import { rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const MB = 1024 * 1024;
const VIDEO_LIMIT_BYTES = 10 * MB;
const DURATION_LIMIT = 10;

function commandOptions(timeoutMs) {
  return {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  };
}

function parseClockDuration(value) {
  const match = String(value || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

async function probeVideo(inputUrl) {
  let stderr = '';
  try {
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-i', inputUrl],
      commandOptions(Number(process.env.LIVE_PROBE_TIMEOUT_MS || 20000)),
    );
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  const bitrateMatch = stderr.match(/bitrate:\s*(\d+)\s*kb\/s/i);
  const fpsMatch = stderr.match(/Video:[^\n]*?\b(\d+(?:\.\d+)?)\s*fps\b/i);

  if (!duration || !dimensions) {
    const err = new Error('Live Wallpaper could not determine source video metadata.');
    err.code = 'LIVE_PROBE_FAILED';
    throw err;
  }

  return {
    duration,
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    bitrateKbps: Number(bitrateMatch?.[1] || 0) || null,
    fps: Number(fpsMatch?.[1] || 0) || null,
  };
}

function shouldLightEnhance(probe) {
  const width = Number(probe.width || 0);
  const height = Number(probe.height || 0);
  const shortSide = Math.min(width, height);
  const megapixels = Math.max(0.25, (width * height) / 1_000_000);
  const kbpsPerMegapixel = Number(probe.bitrateKbps || 0) / megapixels;

  if (shortSide < 720) return true;
  if (probe.bitrateKbps && kbpsPerMegapixel < 850) return true;
  return false;
}

function outputBounds(probe) {
  return Number(probe.width || 0) > Number(probe.height || 0)
    ? { maxWidth: 1920, maxHeight: 1080 }
    : { maxWidth: 1080, maxHeight: 1920 };
}

function liveVideoFilter(probe, enhance) {
  const { maxWidth, maxHeight } = outputBounds(probe);
  const sar = 'if(gt(sar,0),sar,1)';
  const fit = `min(${maxWidth}/(iw*${sar}),${maxHeight}/ih)`;
  const filters = [
    `scale=w='max(2,trunc((iw*${sar})*${fit}/2)*2)':h='max(2,trunc(ih*${fit}/2)*2)':flags=lanczos`,
    'setsar=1',
  ];

  if (enhance) {
    filters.push('hqdn3d=0.7:0.7:3:3');
    filters.push('unsharp=5:5:0.32:5:5:0.0');
  }

  filters.push('fps=30');
  return filters.join(',');
}

function encodePlan(probe) {
  const duration = Math.max(1, Math.min(DURATION_LIMIT, Number(probe.duration || 1)));
  const targetBytes = Math.floor(9.15 * MB);
  const audioKbps = 96;
  const totalKbps = Math.floor((targetBytes * 8 / duration / 1000) * 0.9);
  const videoKbps = Math.max(900, Math.min(6800, totalKbps - audioKbps - 120));
  return { duration, audioKbps, videoKbps };
}

async function encodeLiveVideo(inputUrl, outputPath, probe, enhance, bitrateScale = 1) {
  await rm(outputPath, { force: true }).catch(() => {});
  const plan = encodePlan(probe);
  const videoKbps = Math.max(700, Math.floor(plan.videoKbps * bitrateScale));
  const maxRate = Math.max(videoKbps, Math.floor(videoKbps * 1.15));
  const buffer = Math.max(1200, maxRate * 2);

  await execFileAsync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', inputUrl,
      '-t', String(plan.duration),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', liveVideoFilter(probe, enhance),
      '-c:v', 'libx264',
      '-preset', enhance ? 'fast' : 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level:v', '4.0',
      '-b:v', `${videoKbps}k`,
      '-maxrate', `${maxRate}k`,
      '-bufsize', `${buffer}k`,
      '-c:a', 'aac',
      '-b:a', `${plan.audioKbps}k`,
      '-ar', '44100',
      '-ac', '2',
      '-movflags', '+faststart',
      '-map_metadata', '-1',
      '-metadata:s:v:0', 'rotate=0',
      '-f', 'mp4',
      outputPath,
    ],
    commandOptions(Number(process.env.LIVE_ENCODE_TIMEOUT_MS || 180000)),
  );

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Live Wallpaper encoding completed without an output file.');
    err.code = 'LIVE_OUTPUT_MISSING';
    throw err;
  }

  return { size: fileStat.size, duration: plan.duration, videoKbps };
}

async function extractCover(videoPath, photoPath) {
  await rm(photoPath, { force: true }).catch(() => {});
  await execFileAsync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', '0.12',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      photoPath,
    ],
    commandOptions(Number(process.env.LIVE_COVER_TIMEOUT_MS || 30000)),
  );

  const fileStat = await stat(photoPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Live Wallpaper cover image could not be created.');
    err.code = 'LIVE_COVER_MISSING';
    throw err;
  }
}

async function cleanup(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function prepareIPhoneLiveWallpaper({ video }) {
  if (!video?.url) {
    const err = new Error('Live Wallpaper source video is missing.');
    err.code = 'LIVE_SOURCE_MISSING';
    throw err;
  }

  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-live-${attemptId}`);
  const allPaths = [];

  try {
    const probe = await probeVideo(video.url);
    const enhanced = shouldLightEnhance(probe);
    const attempts = [1, 0.82, 0.68];
    let encoded = null;
    let videoPath = '';

    for (let index = 0; index < attempts.length; index += 1) {
      videoPath = `${base}-live-a${index + 1}.mp4`;
      allPaths.push(videoPath);
      encoded = await encodeLiveVideo(video.url, videoPath, probe, enhanced, attempts[index]);
      if (encoded.size <= Math.floor(VIDEO_LIMIT_BYTES * 0.96)) break;
      await rm(videoPath, { force: true }).catch(() => {});
    }

    if (!encoded || encoded.size > VIDEO_LIMIT_BYTES) {
      const err = new Error('Live Wallpaper output exceeds Telegram Live Photo 10 MB limit.');
      err.code = 'LIVE_FILE_TOO_LARGE';
      throw err;
    }

    const photoPath = `${base}-cover.jpg`;
    allPaths.push(photoPath);
    await extractCover(videoPath, photoPath);

    return {
      videoPath,
      photoPath,
      enhanced,
      source: probe,
      output: encoded,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}
