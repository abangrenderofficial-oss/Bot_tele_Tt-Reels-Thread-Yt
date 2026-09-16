import { createWriteStream } from 'node:fs';
import { chmod, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

function commandOptions(timeoutMs) {
  return {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
    },
  };
}

function sourceHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const allowed = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language']);
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.has(String(key).toLowerCase())) continue;
    if (typeof value !== 'string' || !value) continue;
    out[key] = value;
  }
  if (!Object.keys(out).some((key) => key.toLowerCase() === 'user-agent')) {
    out['User-Agent'] = 'Mozilla/5.0 (compatible; ARDownloader/1.0)';
  }
  return out;
}

function safeExtension(item) {
  const ext = String(item?.ext || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || 'mp4';
}

async function downloadToFile(item, filePath) {
  const response = await fetch(item.url, {
    method: 'GET',
    headers: sourceHeaders(item.headers),
    redirect: 'follow',
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
    const err = new Error('Downloaded social video is empty.');
    err.code = 'MEDIA_DOWNLOAD_EMPTY';
    throw err;
  }

  return { filePath, size: fileStat.size };
}

async function downloadSourceWithYtDlp(sourceUrl, outputBase) {
  if (!sourceUrl) {
    const err = new Error('Original social post URL is missing.');
    err.code = 'SOCIAL_SOURCE_URL_MISSING';
    throw err;
  }

  const binary = path.join(process.cwd(), 'bin', 'yt-dlp');
  await chmod(binary, 0o755).catch(() => {});

  const outputTemplate = `${outputBase}.%(ext)s`;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
    '--format', 'best[height<=1080]/best',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegPath,
    '--no-progress',
    '--output', outputTemplate,
    '--print', 'after_move:filepath',
    '--',
    sourceUrl,
  ];

  const { stdout } = await execFileAsync(binary, args, commandOptions(Number(process.env.SOCIAL_YTDLP_TIMEOUT_MS || 120000)));
  const reported = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const candidates = [reported, `${outputBase}.mp4`, `${outputBase}.mkv`, `${outputBase}.webm`, `${outputBase}.mov`].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile() && fileStat.size) return { filePath: candidate, size: fileStat.size };
    } catch {}
  }

  const err = new Error('yt-dlp did not produce a social video file.');
  err.code = 'SOCIAL_YTDLP_OUTPUT_MISSING';
  throw err;
}

function parseClockDuration(value) {
  const match = String(value || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

async function probeLocalVideo(filePath) {
  let stderr = '';
  try {
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-i', filePath],
      commandOptions(Number(process.env.MEDIA_PROBE_TIMEOUT_MS || 8000)),
    );
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  return {
    duration: duration || null,
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
  };
}

function compressionPlan(durationSeconds, maxBytes, source, safety = 0.82) {
  const duration = Number(durationSeconds || 0);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const targetBytes = Math.floor(maxBytes * safety);
  const audioKbps = duration > 10 * 60 ? 96 : 128;
  const totalKbps = Math.floor((targetBytes * 8) / duration / 1000);
  const videoKbps = totalKbps - audioKbps - 32;

  if (!Number.isFinite(videoKbps) || videoKbps < 550) return null;

  let desiredDimension;
  if (videoKbps >= 2200) desiredDimension = 1920;
  else if (videoKbps >= 1000) desiredDimension = 1280;
  else desiredDimension = 854;

  const sourceMax = Math.max(Number(source?.width || 0), Number(source?.height || 0));
  const maxDimension = sourceMax > 0 ? Math.min(sourceMax, desiredDimension) : desiredDimension;
  const label = maxDimension > 1280 ? '1080p' : maxDimension > 854 ? '720p' : '480p';

  return {
    targetBytes,
    audioKbps,
    videoKbps,
    maxDimension,
    label,
  };
}

async function compressVideo(inputPath, outputPath, plan) {
  await rm(outputPath, { force: true }).catch(() => {});

  const maxRate = Math.max(plan.videoKbps, Math.floor(plan.videoKbps * 1.08));
  const bufferSize = Math.max(plan.videoKbps * 2, 1000);
  const scale = `scale=${plan.maxDimension}:${plan.maxDimension}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;

  const args = [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', scale,
    '-c:v', 'libx264',
    '-preset', String(process.env.SOCIAL_COMPRESS_PRESET || 'fast'),
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-b:v', `${plan.videoKbps}k`,
    '-maxrate', `${maxRate}k`,
    '-bufsize', `${bufferSize}k`,
    '-c:a', 'aac',
    '-b:a', `${plan.audioKbps}k`,
    '-ac', '2',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    outputPath,
  ];

  await execFileAsync(
    ffmpegPath,
    args,
    commandOptions(Number(process.env.SOCIAL_COMPRESS_TIMEOUT_MS || 70000)),
  );

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile()) {
    const err = new Error('Social video compression completed without an output file.');
    err.code = 'SOCIAL_COMPRESS_OUTPUT_MISSING';
    throw err;
  }
  return { filePath: outputPath, size: fileStat.size };
}

async function cleanup(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function prepareSocialVideoTelegramUpload(item, maxBytes, options = {}) {
  if (!item?.url) throw new Error('Social video URL is missing.');
  const limit = Number(maxBytes || 0);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('A valid Telegram upload limit is required.');

  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-social-${attemptId}`);
  let inputPath = `${base}.${safeExtension(item)}`;
  const compressedPath = `${base}-compressed.mp4`;
  const retryPath = `${base}-compressed-retry.mp4`;
  const allPaths = [inputPath, compressedPath, retryPath];

  try {
    let downloaded;
    try {
      downloaded = await downloadToFile(item, inputPath);
    } catch (directError) {
      if (!options.sourceUrl) throw directError;
      console.warn('Direct social media fetch failed; falling back to yt-dlp:', directError?.code, directError?.message);
      await rm(inputPath, { force: true }).catch(() => {});
      downloaded = await downloadSourceWithYtDlp(options.sourceUrl, `${base}-ytdlp`);
      inputPath = downloaded.filePath;
      allPaths.push(inputPath);
    }

    if (downloaded.size <= limit) {
      return {
        ...downloaded,
        compressed: false,
        quality: item.quality || 'original quality',
        cleanup: async () => cleanup(allPaths),
      };
    }

    const probe = await probeLocalVideo(inputPath);
    const duration = Number(options.duration || item.duration || probe.duration || 0);
    let plan = compressionPlan(duration, limit, probe, 0.82);
    if (!plan) {
      const err = new Error('Video is too long to compress under the Telegram limit while keeping acceptable HQ quality.');
      err.code = 'SOCIAL_HQ_COMPRESSION_NOT_VIABLE';
      throw err;
    }

    console.info(
      `Compressing social video: ${downloaded.size} bytes -> target <= ${plan.targetBytes} bytes, ` +
      `${plan.videoKbps}k video + ${plan.audioKbps}k audio, maxDimension=${plan.maxDimension}.`,
    );

    let compressed = await compressVideo(inputPath, compressedPath, plan);

    if (compressed.size > limit) {
      plan = compressionPlan(duration, limit, probe, 0.70);
      if (!plan) {
        const err = new Error('Compressed video still exceeds the Telegram limit at acceptable HQ quality.');
        err.code = 'SOCIAL_COMPRESSED_TOO_LARGE';
        throw err;
      }
      await rm(compressedPath, { force: true }).catch(() => {});
      compressed = await compressVideo(inputPath, retryPath, plan);
    }

    if (compressed.size > limit) {
      const err = new Error(`Compressed video still exceeds Telegram limit (${compressed.size} > ${limit}).`);
      err.code = 'SOCIAL_COMPRESSED_TOO_LARGE';
      throw err;
    }

    await rm(inputPath, { force: true }).catch(() => {});
    return {
      ...compressed,
      compressed: true,
      quality: `${plan.label} • compressed HQ • ratio asal`,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}