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

async function fetchWithHeaderTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 30000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function downloadRemoteVideo(item, filePath) {
  if (!item?.url) {
    const err = new Error('Status HQ source video URL is missing.');
    err.code = 'STATUS_SOURCE_MISSING';
    throw err;
  }

  const response = await fetchWithHeaderTimeout(
    item.url,
    { method: 'GET', headers: sourceHeaders(item.headers), redirect: 'follow' },
    Number(process.env.STATUS_SOURCE_HEADER_TIMEOUT_MS || 30000),
  );

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

async function downloadWithYtDlp(url, outputBase, platform = 'generic') {
  if (!url) {
    const err = new Error('Status HQ original source URL is missing.');
    err.code = 'STATUS_SOURCE_URL_MISSING';
    throw err;
  }

  const binary = ytdlpBinary();
  await chmod(binary, 0o755).catch(() => {});
  const outputTemplate = `${outputBase}.%(ext)s`;
  const format = platform === 'youtube'
    ? 'bestvideo[height<=1080]+bestaudio/best[height<=1080]'
    : 'best[height<=1080]/best';
  const args = [
    ...ytdlpCommonArgs(),
    '--format', format,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegPath,
    '--no-progress',
    '--output', outputTemplate,
    '--print', 'after_move:filepath',
    '--',
    url,
  ];

  const timeout = platform === 'youtube'
    ? Number(process.env.STATUS_YOUTUBE_TIMEOUT_MS || 90000)
    : Number(process.env.STATUS_YTDLP_TIMEOUT_MS || 120000);
  const { stdout } = await execFileAsync(binary, args, commandOptions(timeout));
  const reported = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const candidates = [reported, `${outputBase}.mp4`, `${outputBase}.mkv`, `${outputBase}.webm`, `${outputBase}.mov`].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile() && fileStat.size) return candidate;
    } catch {}
  }

  const err = new Error(`${platform} Status HQ source could not be downloaded by yt-dlp.`);
  err.code = 'STATUS_YTDLP_OUTPUT_MISSING';
  throw err;
}

async function downloadYouTubeSource(url, outputBase) {
  return downloadWithYtDlp(url, outputBase, 'youtube');
}

function parseClockDuration(value) {
  const match = String(value || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

async function probeLocalVideo(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], commandOptions(Number(process.env.STATUS_PROBE_TIMEOUT_MS || 12000)));
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const dimensions = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  const hasAudio = /Audio:/i.test(stderr);
  if (!duration) {
    const err = new Error('Status HQ could not determine source duration.');
    err.code = 'STATUS_PROBE_FAILED';
    throw err;
  }
  return {
    duration,
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
    hasAudio,
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

function dimensionsForTier(probe, tier) {
  const width = Number(probe.width || 0);
  const height = Number(probe.height || 0);
  const landscape = width > height;
  const squareish = width && height && Math.abs(width - height) / Math.max(width, height) < 0.08;

  if (squareish) {
    const side = tier === 1080 ? 1080 : tier === 720 ? 720 : tier === 540 ? 540 : 360;
    return { maxWidth: side, maxHeight: side };
  }
  if (landscape) {
    if (tier === 1080) return { maxWidth: 1920, maxHeight: 1080 };
    if (tier === 720) return { maxWidth: 1280, maxHeight: 720 };
    if (tier === 540) return { maxWidth: 960, maxHeight: 540 };
    return { maxWidth: 640, maxHeight: 360 };
  }
  if (tier === 1080) return { maxWidth: 1080, maxHeight: 1920 };
  if (tier === 720) return { maxWidth: 720, maxHeight: 1280 };
  if (tier === 540) return { maxWidth: 540, maxHeight: 960 };
  return { maxWidth: 360, maxHeight: 640 };
}

function chooseEncodePlan(probe) {
  const duration = Math.max(1, Number(probe.duration || 0));
  const audioKbps = 128;
  const targetBytes = targetOutputBytes();
  const totalKbps = Math.max(300, Math.floor((targetBytes * 8 / duration / 1000) * 0.92));
  const videoKbps = Math.max(180, Math.min(3200, totalKbps - audioKbps - 60));

  let tier;
  if (videoKbps >= 1050) tier = 720;
  else if (videoKbps >= 650) tier = 540;
  else tier = 360;

  const longForm = duration >= 180;
  const veryLong = duration >= 420;
  if (veryLong && tier > 540) tier = 540;
  const dimensions = dimensionsForTier(probe, tier);

  return {
    targetBytes,
    audioKbps,
    videoKbps,
    tier,
    ...dimensions,
    duration,
    fps: '30000/1001',
    preset: longForm ? 'superfast' : (videoKbps >= 1800 ? 'fast' : 'veryfast'),
    scaleFlags: longForm ? 'bicubic' : 'lanczos',
    threads: Math.max(1, Math.min(2, Number(process.env.STATUS_FFMPEG_THREADS || 1))),
    filterThreads: Math.max(1, Math.min(2, Number(process.env.STATUS_FILTER_THREADS || 1))),
  };
}

function resourceSafePlan(plan, probe) {
  const tier = Math.min(Number(plan.tier || 720), 720);
  return {
    ...plan,
    ...dimensionsForTier(probe, tier),
    tier,
    videoKbps: Math.min(Number(plan.videoKbps || 3000), 3000),
    preset: 'veryfast',
    scaleFlags: 'lanczos',
    threads: 1,
    filterThreads: 1,
  };
}

function isResourceFailure(error) {
  const signal = String(error?.signal || '').toUpperCase();
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toUpperCase();
  return signal === 'SIGKILL'
    || code === 'ENOMEM'
    || message.includes('SIGKILL')
    || message.includes('OUT OF MEMORY')
    || message.includes('ENOMEM');
}

function statusVideoFilter(plan) {
  const maxWidth = Math.max(2, Math.floor(Number(plan.maxWidth || 720) / 2) * 2);
  const maxHeight = Math.max(2, Math.floor(Number(plan.maxHeight || 1280) / 2) * 2);
  const sar = 'if(gt(sar,0),sar,1)';
  const fit = `min(1,min(${maxWidth}/(iw*${sar}),${maxHeight}/ih))`;
  return [
    `scale=w='max(2,trunc((iw*${sar})*${fit}/2)*2)':h='max(2,trunc(ih*${fit}/2)*2)':flags=${plan.scaleFlags || 'lanczos'}`,
    'setsar=1',
    `fps=${plan.fps}`,
  ].join(',');
}

async function encodeSingleStatusFile(inputPath, outputPath, plan, bitrateScale = 1, sourceProbe = null) {
  await rm(outputPath, { force: true }).catch(() => {});
  const videoKbps = Math.max(160, Math.floor(plan.videoKbps * bitrateScale));
  const maxRate = Math.max(videoKbps, Math.floor(videoKbps * 1.18));
  const buffer = Math.max(maxRate * 2, 1000);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-filter_threads', String(plan.filterThreads ?? 1),
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', statusVideoFilter(plan),
    '-c:v', 'libx264', '-preset', plan.preset, '-pix_fmt', 'yuv420p',
    '-b:v', `${videoKbps}k`, '-maxrate', `${maxRate}k`, '-bufsize', `${buffer}k`,
    '-profile:v', 'main', '-level:v', '3.1', '-tag:v', 'avc1',
    '-g', '60', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', `${plan.audioKbps}k`,
    '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0',
    '-map_metadata', '-1', '-f', 'mp4', '-threads', String(plan.threads ?? 1), outputPath,
  ];

  try {
    await execFileAsync(ffmpegPath, args, commandOptions(Number(process.env.STATUS_ENCODE_TIMEOUT_MS || 260000)));
  } catch (error) {
    console.error('Status HQ ffmpeg failed:', {
      code: error?.code ?? null,
      signal: error?.signal ?? null,
      killed: Boolean(error?.killed),
      stderr: String(error?.stderr || '').slice(-4000),
    });
    throw error;
  }

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Status HQ encoding completed without an output file.');
    err.code = 'STATUS_OUTPUT_MISSING';
    throw err;
  }

  const outputProbe = await probeLocalVideo(outputPath);
  if (sourceProbe?.hasAudio && !outputProbe.hasAudio) {
    const err = new Error('Status HQ output lost the source audio track.');
    err.code = 'STATUS_AUDIO_MISSING';
    throw err;
  }

  return { size: fileStat.size, videoKbps, hasAudio: outputProbe.hasAudio };
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
      try {
        await downloadRemoteVideo(video, inputPath);
      } catch (directError) {
        if (!sourceUrl || platform === 'telegram') throw directError;
        console.warn('Status HQ direct source fetch failed; falling back to yt-dlp:', directError?.code, directError?.message);
        await rm(inputPath, { force: true }).catch(() => {});
        inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source-ytdlp`, platform || 'generic');
        allPaths.push(inputPath);
      }
    }

    const probe = await probeLocalVideo(inputPath);
    const plan = chooseEncodePlan(probe);
    let activePlan = plan;
    let resourceFallbackUsed = false;
    const safeLimit = Math.floor(configuredUploadLimitBytes() * 0.94);
    const attempts = [1, 0.84, 0.7];
    let encoded = null;
    let outputPath = '';
    let usedAttempt = 0;

    for (let index = 0; index < attempts.length; index += 1) {
      outputPath = `${base}-status-a${index + 1}.mp4`;
      allPaths.push(outputPath);
      try {
        encoded = await encodeSingleStatusFile(inputPath, outputPath, activePlan, attempts[index], probe);
      } catch (error) {
        if (!resourceFallbackUsed && isResourceFailure(error)) {
          resourceFallbackUsed = true;
          activePlan = resourceSafePlan(plan, probe);
          console.warn('[status-hq] FFmpeg resource kill detected; retrying with safe 720p/1-thread plan.');
          index -= 1;
          continue;
        }
        throw error;
      }
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
        mode: 'single', tier: activePlan.tier, maxWidth: activePlan.maxWidth, maxHeight: activePlan.maxHeight,
        videoKbps: encoded.videoKbps, audioKbps: activePlan.audioKbps,
        hasAudio: encoded.hasAudio,
        resourceFallbackUsed,
      },
      quality: `Status HQ • single file • ${activePlan.tier}p class • H.264 Main/AAC-LC • mobile-safe${resourceFallbackUsed ? ' • safe fallback' : ''}`,
      attempt: usedAttempt,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}
