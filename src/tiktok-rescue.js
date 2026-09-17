import { execFile } from 'node:child_process';
import { chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

function ytdlpBinary() {
  return path.join(process.cwd(), 'bin', 'yt-dlp');
}

function commandOptions(timeoutMs) {
  return {
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
    },
  };
}

async function downloadOriginal(url, outputBase) {
  const binary = ytdlpBinary();
  await chmod(binary, 0o755).catch(() => {});

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
    '--force-ipv4',
    '--format', 'best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegPath,
    '--no-progress',
    '--output', `${outputBase}.%(ext)s`,
    '--print', 'after_move:filepath',
    '--',
    url,
  ];

  const { stdout } = await execFileAsync(
    binary,
    args,
    commandOptions(Number(process.env.TIKTOK_RESCUE_DOWNLOAD_TIMEOUT_MS || 45_000)),
  );

  const reported = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const candidates = [reported, `${outputBase}.mp4`, `${outputBase}.mkv`, `${outputBase}.webm`].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) return { filePath: candidate, size: fileStat.size };
    } catch {}
  }

  const err = new Error('TikTok rescue completed but output file was not found.');
  err.code = 'TIKTOK_RESCUE_OUTPUT_MISSING';
  throw err;
}

async function probeVideo(filePath) {
  let stderr = '';
  try {
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-i', filePath],
      commandOptions(Number(process.env.TIKTOK_RESCUE_PROBE_TIMEOUT_MS || 12_000)),
    );
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  const duration = durationMatch
    ? (Number(durationMatch[1]) * 3600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3])
    : 0;

  return {
    duration,
    width: dimensions ? Number(dimensions[1]) : 0,
    height: dimensions ? Number(dimensions[2]) : 0,
  };
}

function compressionPlan(metadata, maxBytes) {
  const duration = Number(metadata?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const targetBytes = Math.floor(maxBytes * 0.78);
  const audioKbps = duration > 10 * 60 ? 96 : 128;
  const totalKbps = Math.floor((targetBytes * 8) / duration / 1000);
  const videoKbps = totalKbps - audioKbps - 24;
  if (!Number.isFinite(videoKbps) || videoKbps < 350) return null;

  const sourceMax = Math.max(Number(metadata?.width || 0), Number(metadata?.height || 0), 854);
  let desired = 854;
  if (videoKbps >= 2200) desired = 1920;
  else if (videoKbps >= 1000) desired = 1280;

  return {
    targetBytes,
    audioKbps,
    videoKbps,
    maxDimension: Math.min(sourceMax, desired),
  };
}

async function compressForTelegram(inputPath, outputPath, metadata, maxBytes) {
  const plan = compressionPlan(metadata, maxBytes);
  if (!plan) {
    const err = new Error('TikTok rescue video cannot be compressed within the Telegram limit at usable quality.');
    err.code = 'TIKTOK_RESCUE_COMPRESSION_NOT_VIABLE';
    throw err;
  }

  const scale = `scale=${plan.maxDimension}:${plan.maxDimension}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;
  const maxRate = Math.max(plan.videoKbps, Math.floor(plan.videoKbps * 1.08));
  const bufferSize = Math.max(plan.videoKbps * 2, 700);

  await rm(outputPath, { force: true }).catch(() => {});
  await execFileAsync(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-nostats',
      '-nostdin',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', scale,
      '-c:v', 'libx264',
      '-threads', String(Math.max(1, Math.min(4, Number(process.env.TIKTOK_RESCUE_COMPRESS_THREADS || 4)))),
      '-preset', String(process.env.TIKTOK_RESCUE_COMPRESS_PRESET || 'veryfast'),
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
    ],
    commandOptions(Number(process.env.TIKTOK_RESCUE_COMPRESS_TIMEOUT_MS || 120_000)),
  );

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || fileStat.size > maxBytes) {
    const err = new Error(`TikTok rescue compression is still too large (${fileStat.size} bytes).`);
    err.code = 'TIKTOK_RESCUE_TOO_LARGE';
    throw err;
  }

  return { filePath: outputPath, size: fileStat.size, compressed: true };
}

async function cleanupOutputBase(outputBase) {
  const suffixes = ['.mp4', '.mkv', '.webm', '.m4a', '.part', '-compressed.mp4'];
  await Promise.all(suffixes.map((suffix) => rm(`${outputBase}${suffix}`, { force: true }).catch(() => {})));
}

export async function prepareTikTokTelegramRescue(url, maxBytes) {
  const limit = Number(maxBytes || 0);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('A valid Telegram upload limit is required.');

  const outputBase = path.join(tmpdir(), `ar-tiktok-rescue-${randomUUID()}`);
  const compressedPath = `${outputBase}-compressed.mp4`;

  try {
    const downloaded = await downloadOriginal(url, outputBase);
    if (downloaded.size <= limit) {
      return {
        ...downloaded,
        compressed: false,
        cleanup: async () => cleanupOutputBase(outputBase),
      };
    }

    const metadata = await probeVideo(downloaded.filePath);
    const compressed = await compressForTelegram(downloaded.filePath, compressedPath, metadata, limit);
    await rm(downloaded.filePath, { force: true }).catch(() => {});

    return {
      ...compressed,
      cleanup: async () => cleanupOutputBase(outputBase),
    };
  } catch (error) {
    await cleanupOutputBase(outputBase);
    const err = new Error(error?.message || 'TikTok rescue failed.');
    err.code = error?.code || 'TIKTOK_RESCUE_FAILED';
    throw err;
  }
}
