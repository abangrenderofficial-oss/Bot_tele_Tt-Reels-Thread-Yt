import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
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
const WHATSAPP_SAFE_MAX_BYTES = Math.floor(15.5 * MB);

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

async function fetchWithHeaderTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 30000));
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function downloadSourceVideo(item, filePath) {
  if (!item?.url) {
    const error = new Error('Android Status HQ source video URL is missing.');
    error.code = 'STATUS_ANDROID_SOURCE_MISSING';
    throw error;
  }

  const response = await fetchWithHeaderTimeout(
    item.url,
    { method: 'GET', headers: sourceHeaders(item.headers) },
    Number(process.env.STATUS_ANDROID_SOURCE_HEADER_TIMEOUT_MS || 30000),
  );
  if (!response.ok || !response.body) {
    const error = new Error(`Android Status HQ source returned HTTP ${response.status}.`);
    error.code = 'STATUS_ANDROID_SOURCE_FETCH_ERROR';
    throw error;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const info = await stat(filePath);
  if (!info.isFile() || !info.size) {
    const error = new Error('Android Status HQ source download is empty.');
    error.code = 'STATUS_ANDROID_SOURCE_EMPTY';
    throw error;
  }
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
      commandOptions(Number(process.env.STATUS_ANDROID_PROBE_TIMEOUT_MS || 12000)),
    );
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  if (!duration) {
    const error = new Error('Android Status HQ could not determine source duration.');
    error.code = 'STATUS_ANDROID_PROBE_FAILED';
    throw error;
  }
  return { duration };
}

function configuredUploadLimitBytes() {
  const configured = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : 50;
  return Math.floor(mb * MB);
}

function whatsappSafeOutputBytes() {
  const telegramSafe = Math.floor(configuredUploadLimitBytes() * 0.9);
  const customMb = Number(process.env.STATUS_ANDROID_TARGET_MB || 0);
  const requested = Number.isFinite(customMb) && customMb > 0
    ? Math.floor(customMb * MB)
    : WHATSAPP_SAFE_MAX_BYTES;
  return Math.max(1 * MB, Math.min(requested, WHATSAPP_SAFE_MAX_BYTES, telegramSafe));
}

function chooseAndroidPlan(probe) {
  const duration = Math.max(1, Number(probe.duration || 0));
  const audioKbps = 128;
  const totalKbps = Math.max(320, Math.floor((whatsappSafeOutputBytes() * 8 / duration / 1000) * 0.94));
  const videoKbps = Math.max(180, Math.min(3800, totalKbps - audioKbps - 80));
  return {
    duration,
    audioKbps,
    videoKbps,
    threads: Math.max(1, Math.min(2, Number(process.env.STATUS_ANDROID_FFMPEG_THREADS || 2))),
    filterThreads: Math.max(1, Math.min(2, Number(process.env.STATUS_ANDROID_FILTER_THREADS || 1))),
  };
}

function androidVideoFilter() {
  const landscapeMaxW = 1920;
  const landscapeMaxH = 1080;
  const portraitMaxW = 1080;
  const portraitMaxH = 1920;
  const maxW = `if(gte(iw,ih),${landscapeMaxW},${portraitMaxW})`;
  const maxH = `if(gte(iw,ih),${landscapeMaxH},${portraitMaxH})`;
  const fit = `min(1,min((${maxW})/iw,(${maxH})/ih))`;
  return [
    `scale=w='max(2,trunc(iw*${fit}/2)*2)':h='max(2,trunc(ih*${fit}/2)*2)':flags=lanczos`,
    'setsar=1',
    'fps=30',
  ].join(',');
}

async function encodeAndroidStatus(inputPath, outputPath, plan, attempt) {
  await rm(outputPath, { force: true }).catch(() => {});
  const rateScale = Number(attempt?.rateScale || 1);
  const crf = Math.max(18, Math.min(28, Number(attempt?.crf || 23)));
  const maxRate = Math.max(180, Math.floor(plan.videoKbps * rateScale));
  const buffer = Math.max(1000, Math.floor(maxRate * 1.5));
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-filter_threads', String(plan.filterThreads),
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', androidVideoFilter(),
    '-c:v', 'libx264', '-preset', 'faster', '-pix_fmt', 'yuv420p',
    '-crf', String(crf), '-maxrate', `${maxRate}k`, '-bufsize', `${buffer}k`,
    '-profile:v', 'high', '-level:v', '4.0',
    '-g', '250', '-sc_threshold', '0',
    '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', `${plan.audioKbps}k`,
    '-brand', 'isom', '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0',
    '-map_metadata', '-1', '-f', 'mp4', '-threads', String(plan.threads), outputPath,
  ];

  try {
    await execFileAsync(
      ffmpegPath,
      args,
      commandOptions(Number(process.env.STATUS_ANDROID_ENCODE_TIMEOUT_MS || 320000)),
    );
  } catch (error) {
    console.error('[status-hq/android] ffmpeg failed:', {
      code: error?.code ?? null,
      signal: error?.signal ?? null,
      killed: Boolean(error?.killed),
      stderr: String(error?.stderr || '').slice(-4000),
    });
    throw error;
  }

  const info = await stat(outputPath);
  if (!info.isFile() || !info.size) {
    const error = new Error('Android Status HQ encoding completed without an output file.');
    error.code = 'STATUS_ANDROID_OUTPUT_MISSING';
    throw error;
  }
  return { size: info.size, videoKbps: maxRate, crf };
}

async function cleanup(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function prepareWhatsAppStatusAndroidHQ({ video }) {
  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-status-android-${attemptId}`);
  const inputPath = `${base}-source.${String(video?.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4'}`;
  const paths = [inputPath];

  try {
    await downloadSourceVideo(video, inputPath);
    const probe = await probeLocalVideo(inputPath);
    const plan = chooseAndroidPlan(probe);
    const safeLimit = whatsappSafeOutputBytes();
    const attempts = [
      { rateScale: 1, crf: 23 },
      { rateScale: 0.84, crf: 24 },
      { rateScale: 0.70, crf: 25 },
    ];
    let encoded = null;
    let outputPath = '';
    let usedAttempt = 0;

    for (let index = 0; index < attempts.length; index += 1) {
      outputPath = `${base}-a${index + 1}.mp4`;
      paths.push(outputPath);
      encoded = await encodeAndroidStatus(inputPath, outputPath, plan, attempts[index]);
      usedAttempt = index + 1;
      if (encoded.size <= safeLimit) break;
      await rm(outputPath, { force: true }).catch(() => {});
    }

    if (!encoded || encoded.size > safeLimit) {
      const error = new Error('Android Status HQ output masih melebihi had profile WhatsApp-safe.');
      error.code = 'STATUS_ANDROID_FILE_TOO_LARGE';
      throw error;
    }

    await rm(inputPath, { force: true }).catch(() => {});
    return {
      filePath: outputPath,
      size: encoded.size,
      source: probe,
      profile: {
        mode: 'android-beta-v2',
        maxLandscape: '1920x1080',
        maxPortrait: '1080x1920',
        fps: 30,
        maxVideoKbps: encoded.videoKbps,
        crf: encoded.crf,
        audioKbps: plan.audioKbps,
        maxOutputMb: Number((safeLimit / MB).toFixed(2)),
      },
      quality: 'Status HQ Android Beta v2 • H.264 High • 30fps CFR • yuv420p • WhatsApp-safe size • ratio asal',
      attempt: usedAttempt,
      cleanup: async () => cleanup(paths),
    };
  } catch (error) {
    await cleanup(paths);
    throw error;
  }
}
