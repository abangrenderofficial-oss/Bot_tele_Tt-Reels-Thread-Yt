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
const MB = 1024 * 1024;

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

function ytdlpBinary() {
  return path.join(process.cwd(), 'bin', 'yt-dlp');
}

function ytdlpCommonArgs() {
  return [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
  ];
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

async function downloadRemoteVideo(item, filePath) {
  if (!item?.url) {
    const err = new Error('Status HQ source video URL is missing.');
    err.code = 'STATUS_SOURCE_MISSING';
    throw err;
  }

  const response = await fetch(item.url, {
    method: 'GET',
    headers: sourceHeaders(item.headers),
    redirect: 'follow',
    signal: AbortSignal.timeout(Number(process.env.STATUS_SOURCE_TIMEOUT_MS || 90000)),
  });

  if (!response.ok || !response.body) {
    const err = new Error(`Status HQ source returned HTTP ${response.status}.`);
    err.code = 'STATUS_SOURCE_FETCH_ERROR';
    throw err;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Status HQ source download is empty.');
    err.code = 'STATUS_SOURCE_EMPTY';
    throw err;
  }
  return filePath;
}

async function downloadYouTubeSource(url, outputBase) {
  const binary = ytdlpBinary();
  await chmod(binary, 0o755).catch(() => {});

  const outputTemplate = `${outputBase}.%(ext)s`;
  const args = [
    ...ytdlpCommonArgs(),
    '--format', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegPath,
    '--no-progress',
    '--output', outputTemplate,
    '--print', 'after_move:filepath',
    '--',
    url,
  ];

  const { stdout } = await execFileAsync(
    binary,
    args,
    commandOptions(Number(process.env.STATUS_YOUTUBE_TIMEOUT_MS || 90000)),
  );

  const reported = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const candidates = [reported, `${outputBase}.mp4`, `${outputBase}.mkv`, `${outputBase}.webm`].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile() && fileStat.size) return candidate;
    } catch {}
  }

  const err = new Error('YouTube Status HQ source could not be downloaded/merged.');
  err.code = 'STATUS_YOUTUBE_OUTPUT_MISSING';
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
      commandOptions(Number(process.env.STATUS_PROBE_TIMEOUT_MS || 12000)),
    );
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  if (!duration) {
    const err = new Error('Status HQ could not determine source duration.');
    err.code = 'STATUS_PROBE_FAILED';
    throw err;
  }

  return {
    duration,
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
  };
}

function configuredUploadLimitBytes() {
  const configured = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : 50;
  return Math.floor(mb * MB);
}

function targetOutputBytes() {
  const uploadLimit = configuredUploadLimitBytes();
  const customMb = Number(process.env.STATUS_HQ_TARGET_MB || 0);
  const requested = Number.isFinite(customMb) && customMb > 0 ? customMb * MB : 45 * MB;
  return Math.floor(Math.min(requested, uploadLimit * 0.9));
}

function chooseEncodePlan(probe) {
  const duration = Math.max(1, Number(probe.duration || 0));
  const audioKbps = 128;
  const muxSafety = 0.92;
  const targetBytes = targetOutputBytes();
  const totalKbps = Math.max(300, Math.floor((targetBytes * 8 / duration / 1000) * muxSafety));
  const videoKbps = Math.max(180, Math.min(4300, totalKbps - audioKbps - 60));

  let tier;
  if (videoKbps >= 2400) tier = 1080;
  else if (videoKbps >= 1050) tier = 720;
  else if (videoKbps >= 650) tier = 540;
  else tier = 360;

  const width = Number(probe.width || 0);
  const height = Number(probe.height || 0);
  const landscape = width > height;
  const squareish = width && height && Math.abs(width - height) / Math.max(width, height) < 0.08;

  let maxWidth;
  let maxHeight;
  if (squareish) {
    const side = tier === 1080 ? 1080 : tier === 720 ? 720 : tier === 540 ? 540 : 360;
    maxWidth = side;
    maxHeight = side;
  } else if (landscape) {
    if (tier === 1080) [maxWidth, maxHeight] = [1920, 1080];
    else if (tier === 720) [maxWidth, maxHeight] = [1280, 720];
    else if (tier === 540) [maxWidth, maxHeight] = [960, 540];
    else [maxWidth, maxHeight] = [640, 360];
  } else {
    if (tier === 1080) [maxWidth, maxHeight] = [1080, 1920];
    else if (tier === 720) [maxWidth, maxHeight] = [720, 1280];
    else if (tier === 540) [maxWidth, maxHeight] = [540, 960];
    else [maxWidth, maxHeight] = [360, 640];
  }

  return {
    targetBytes,
    audioKbps,
    videoKbps,
    tier,
    maxWidth,
    maxHeight,
    fps: '30000/1001',
    preset: videoKbps >= 1800 ? 'fast' : 'veryfast',
  };
}

function statusVideoFilter(plan) {
  return [
    `scale=w=${plan.maxWidth}:h=${plan.maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
    `fps=${plan.fps}`,
  ].join(',');
}

async function encodeSingleStatusFile(inputPath, outputPath, plan, bitrateScale = 1) {
  await rm(outputPath, { force: true }).catch(() => {});

  const videoKbps = Math.max(160, Math.floor(plan.videoKbps * bitrateScale));
  const maxRate = Math.max(videoKbps, Math.floor(videoKbps * 1.18));
  const buffer = Math.max(maxRate * 2, 1000);

  const args = [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', statusVideoFilter(plan),
    '-c:v', 'libx264',
    '-preset', plan.preset,
    '-pix_fmt', 'yuv420p',
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${maxRate}k`,
    '-bufsize', `${buffer}k`,
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-c:a', 'aac',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', `${plan.audioKbps}k`,
    '-brand', 'isom',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-f', 'mp4',
    '-threads', '2',
    outputPath,
  ];

  await execFileAsync(
    ffmpegPath,
    args,
    commandOptions(Number(process.env.STATUS_ENCODE_TIMEOUT_MS || 240000)),
  );

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Status HQ encoding completed without an output file.');
    err.code = 'STATUS_OUTPUT_MISSING';
    throw err;
  }

  return {
    size: fileStat.size,
    videoKbps,
  };
}

async function cleanup(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function prepareWhatsAppStatusHQ({ sourceUrl, platform, video }) {
  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-status-${attemptId}`);
  const allPaths = [];
  let inputPath = '';

  try {
    if (platform === 'youtube') {
      inputPath = await downloadYouTubeSource(sourceUrl, `${base}-source`);
      allPaths.push(inputPath);
    } else {
      inputPath = `${base}-source.${safeExtension(video)}`;
      allPaths.push(inputPath);
      await downloadRemoteVideo(video, inputPath);
    }

    const probe = await probeLocalVideo(inputPath);
    const plan = chooseEncodePlan(probe);
    const safeLimit = Math.floor(configuredUploadLimitBytes() * 0.94);
    const attempts = [1, 0.84, 0.7];
    let encoded = null;
    let outputPath = '';
    let usedAttempt = 0;

    for (let index = 0; index < attempts.length; index += 1) {
      outputPath = `${base}-status-a${index + 1}.mp4`;
      allPaths.push(outputPath);
      encoded = await encodeSingleStatusFile(inputPath, outputPath, plan, attempts[index]);
      usedAttempt = index + 1;
      if (encoded.size <= safeLimit) break;
      await rm(outputPath, { force: true }).catch(() => {});
    }

    if (!encoded || encoded.size > safeLimit) {
      const err = new Error(`Status HQ single-file output masih melebihi had Telegram (${encoded?.size || 0} bytes).`);
      err.code = 'STATUS_FILE_TOO_LARGE';
      throw err;
    }

    await rm(inputPath, { force: true }).catch(() => {});

    return {
      filePath: outputPath,
      size: encoded.size,
      source: probe,
      profile: {
        mode: 'single',
        tier: plan.tier,
        maxWidth: plan.maxWidth,
        maxHeight: plan.maxHeight,
        videoKbps: encoded.videoKbps,
        audioKbps: plan.audioKbps,
      },
      quality: `Status HQ • single file • ${plan.tier}p class • H.264/AAC • ratio asal`,
      attempt: usedAttempt,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}
