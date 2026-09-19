import { createWriteStream } from 'node:fs';
import { access, chmod, rm, stat } from 'node:fs/promises';
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
let labelSupportPromise = null;

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
    out['User-Agent'] = 'Mozilla/5.0 (compatible; ARDownloader-HQLab/1.0)';
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
    const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function downloadRemoteVideo(item, filePath) {
  if (!item?.url) {
    const error = new Error('HQ Lab source URL is missing.');
    error.code = 'HQ_LAB_SOURCE_MISSING';
    throw error;
  }

  const response = await fetchWithHeaderTimeout(
    item.url,
    { method: 'GET', headers: sourceHeaders(item.headers) },
    Number(process.env.HQ_LAB_SOURCE_HEADER_TIMEOUT_MS || 30000),
  );
  if (!response.ok || !response.body) {
    const error = new Error(`HQ Lab source returned HTTP ${response.status}.`);
    error.code = 'HQ_LAB_SOURCE_FETCH_ERROR';
    throw error;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const info = await stat(filePath);
  if (!info.isFile() || !info.size) {
    const error = new Error('HQ Lab source download is empty.');
    error.code = 'HQ_LAB_SOURCE_EMPTY';
    throw error;
  }
  return filePath;
}

async function downloadWithYtDlp(url, outputBase) {
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
    commandOptions(Number(process.env.HQ_LAB_YTDLP_TIMEOUT_MS || 150000)),
  );
  const reported = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const candidates = [reported, `${outputBase}.mp4`, `${outputBase}.mkv`, `${outputBase}.webm`, `${outputBase}.mov`].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size) return candidate;
    } catch {}
  }
  const error = new Error('HQ Lab yt-dlp did not produce a video file.');
  error.code = 'HQ_LAB_YTDLP_OUTPUT_MISSING';
  throw error;
}

function parseClockDuration(value) {
  const match = String(value || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function parseFps(videoLine) {
  const fps = Number(String(videoLine || '').match(/(?:,|\s)(\d+(?:\.\d+)?)\s*fps\b/i)?.[1] || 0);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return 30;
  return fps;
}

async function probeVideo(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], commandOptions(Number(process.env.HQ_LAB_PROBE_TIMEOUT_MS || 15000)));
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const videoLine = stderr.match(/Video:[^\n]+/i)?.[0] || '';
  const dimensions = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/i);
  if (!duration || !dimensions) {
    const error = new Error('HQ Lab could not determine video metadata.');
    error.code = 'HQ_LAB_PROBE_FAILED';
    throw error;
  }

  return {
    duration,
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    fps: parseFps(videoLine),
    hasAudio: /Audio:/i.test(stderr),
  };
}

function uploadLimitBytes() {
  const configured = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : 50;
  return Math.floor(mb * MB);
}

function targetOutputBytes() {
  const customMb = Number(process.env.STATUS_HQ_TARGET_MB || 0);
  const requested = Number.isFinite(customMb) && customMb > 0 ? customMb * MB : 45 * MB;
  return Math.floor(Math.min(requested, uploadLimitBytes() * 0.9));
}

function currentPlan(probe) {
  const duration = Math.max(1, Number(probe.duration || 0));
  const audioKbps = probe.hasAudio ? 128 : 0;
  const totalKbps = Math.max(300, Math.floor((targetOutputBytes() * 8 / duration / 1000) * 0.92));
  const videoKbps = Math.max(180, Math.min(4300, totalKbps - audioKbps - 60));

  let tier;
  if (videoKbps >= 2400) tier = 1080;
  else if (videoKbps >= 1050) tier = 720;
  else if (videoKbps >= 650) tier = 540;
  else tier = 360;
  if (duration >= 420 && tier > 540) tier = 540;

  const landscape = probe.width > probe.height;
  const squareish = Math.abs(probe.width - probe.height) / Math.max(probe.width, probe.height) < 0.08;
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
    maxWidth,
    maxHeight,
    fps: 30000 / 1001,
    videoKbps,
    audioKbps,
    preset: duration >= 180 ? 'superfast' : (videoKbps >= 1800 ? 'fast' : 'veryfast'),
    scaleFlags: duration >= 180 ? 'bicubic' : 'lanczos',
  };
}

function cappedSourceBox(probe, maxLong, maxShort) {
  const landscape = probe.width >= probe.height;
  return landscape
    ? { maxWidth: maxLong, maxHeight: maxShort }
    : { maxWidth: maxShort, maxHeight: maxLong };
}

function variantsFor(probe) {
  const base = currentPlan(probe);
  const lightBox = cappedSourceBox(probe, 1920, 1080);
  const box900 = cappedSourceBox(probe, 1600, 900);
  const sourceFps = Math.max(12, Math.min(30, Number(probe.fps || 30)));

  return [
    {
      id: 'A', name: 'Current HQ', label: 'A  CURRENT HQ',
      ...base,
      sharpen: '', tune: '', gop: 0, scenecut: null,
    },
    {
      id: 'B', name: 'Light HQ', label: 'B  LIGHT HQ',
      ...base,
      ...lightBox,
      fps: sourceFps,
      preset: 'veryfast',
      scaleFlags: 'bicubic',
      sharpen: '', tune: '', gop: 0, scenecut: null,
    },
    {
      id: 'C', name: 'Sharp HQ', label: 'C  SHARP HQ',
      ...base,
      ...lightBox,
      videoKbps: base.videoKbps,
      preset: 'fast',
      scaleFlags: 'lanczos',
      sharpen: 'unsharp=5:5:0.45:3:3:0.0', tune: 'film', gop: 0, scenecut: null,
    },
    {
      id: 'D', name: '900p HQ', label: 'D  900P HQ',
      ...base,
      ...box900,
      preset: 'veryfast',
      scaleFlags: 'lanczos',
      sharpen: '', tune: '', gop: 0, scenecut: null,
    },
    {
      id: 'E', name: 'Motion HQ', label: 'E  MOTION HQ',
      ...base,
      ...lightBox,
      fps: 30,
      videoKbps: base.videoKbps,
      preset: 'fast',
      scaleFlags: 'lanczos',
      sharpen: '', tune: 'film', gop: 60, scenecut: 40,
    },
  ];
}

async function canBurnLabel() {
  if (!labelSupportPromise) {
    labelSupportPromise = (async () => {
      try {
        await execFileAsync(
          ffmpegPath,
          [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=s=64x64:d=0.05',
            '-vf', "drawtext=text='TEST':x=2:y=2:fontsize=12:fontcolor=white",
            '-frames:v', '1', '-f', 'null', '-',
          ],
          commandOptions(7000),
        );
        return true;
      } catch (error) {
        console.warn('[hq-lab] drawtext unavailable; captions will still identify variants:', error?.message);
        return false;
      }
    })();
  }
  return labelSupportPromise;
}

async function knownFontArg() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return `fontfile='${candidate}':`;
    } catch {}
  }
  return '';
}

function escapeDrawtext(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

async function videoFilter(variant, burnLabel) {
  const maxWidth = Math.max(2, Math.floor(Number(variant.maxWidth || 1080) / 2) * 2);
  const maxHeight = Math.max(2, Math.floor(Number(variant.maxHeight || 1920) / 2) * 2);
  const fit = `min(1,min(${maxWidth}/iw,${maxHeight}/ih))`;
  const filters = [
    `scale=w='max(2,trunc(iw*${fit}/2)*2)':h='max(2,trunc(ih*${fit}/2)*2)':flags=${variant.scaleFlags || 'lanczos'}`,
    'setsar=1',
    `fps=${Number(variant.fps || 30).toFixed(3)}`,
  ];
  if (variant.sharpen) filters.push(variant.sharpen);
  if (burnLabel) {
    const fontArg = await knownFontArg();
    filters.push(
      `drawtext=${fontArg}text='${escapeDrawtext(variant.label)}':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=10`,
    );
  }
  return filters.join(',');
}

async function encodeVariant(inputPath, outputPath, variant, burnLabel, hasAudio) {
  await rm(outputPath, { force: true }).catch(() => {});
  const maxRate = Math.max(variant.videoKbps, Math.floor(variant.videoKbps * 1.18));
  const buffer = Math.max(1000, maxRate * 2);
  const filter = await videoFilter(variant, burnLabel);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-filter_threads', '1',
    '-i', inputPath,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : []),
    '-vf', filter,
    '-c:v', 'libx264', '-preset', variant.preset, '-pix_fmt', 'yuv420p',
    '-b:v', `${variant.videoKbps}k`, '-maxrate', `${maxRate}k`, '-bufsize', `${buffer}k`,
    '-profile:v', 'high', '-level:v', '4.0',
    ...(variant.tune ? ['-tune', variant.tune] : []),
    ...(variant.gop ? ['-g', String(variant.gop), '-keyint_min', String(Math.max(1, Math.floor(variant.gop / 2)))] : []),
    ...(variant.scenecut !== null && variant.scenecut !== undefined ? ['-sc_threshold', String(variant.scenecut)] : []),
    ...(hasAudio ? ['-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', `${variant.audioKbps || 128}k`] : ['-an']),
    '-brand', 'isom', '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0',
    '-map_metadata', '-1', '-f', 'mp4', '-threads', '2', outputPath,
  ];

  const startedAt = performance.now();
  await execFileAsync(ffmpegPath, args, commandOptions(Number(process.env.HQ_LAB_ENCODE_TIMEOUT_MS || 360000)));
  const elapsedMs = Math.round(performance.now() - startedAt);
  const info = await stat(outputPath);
  if (!info.isFile() || !info.size) throw new Error(`HQ Lab ${variant.id} produced an empty output.`);
  const outputProbe = await probeVideo(outputPath).catch(() => null);
  return {
    ...variant,
    filePath: outputPath,
    size: info.size,
    elapsedMs,
    output: outputProbe,
  };
}

export async function prepareHqLab({ sourceUrl = '', platform = 'generic', video = null }) {
  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-hqlab-${attemptId}`);
  const paths = [];
  let inputPath = '';

  try {
    if (platform === 'youtube' && sourceUrl) {
      inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source`);
      paths.push(inputPath);
    } else if (video?.url) {
      inputPath = `${base}-source.${safeExtension(video)}`;
      paths.push(inputPath);
      try {
        await downloadRemoteVideo(video, inputPath);
      } catch (directError) {
        if (!sourceUrl) throw directError;
        console.warn('[hq-lab] direct source failed; falling back to yt-dlp:', directError?.code, directError?.message);
        await rm(inputPath, { force: true }).catch(() => {});
        inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source-ytdlp`);
        paths.push(inputPath);
      }
    } else if (sourceUrl) {
      inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source`);
      paths.push(inputPath);
    } else {
      const error = new Error('HQ Lab has no usable input source.');
      error.code = 'HQ_LAB_NO_INPUT';
      throw error;
    }

    const source = await probeVideo(inputPath);
    const burnLabel = await canBurnLabel();
    const variants = variantsFor(source);
    const results = [];

    for (const variant of variants) {
      const outputPath = `${base}-${variant.id.toLowerCase()}.mp4`;
      paths.push(outputPath);
      try {
        const encoded = await encodeVariant(inputPath, outputPath, variant, burnLabel, source.hasAudio);
        results.push({ ok: true, ...encoded });
      } catch (error) {
        console.error(`[hq-lab/${variant.id}] failed:`, error?.code, error?.message);
        results.push({ ok: false, id: variant.id, name: variant.name, label: variant.label, error: error?.message || 'encode_failed' });
      }
    }

    return {
      source,
      burnLabel,
      results,
      cleanup: () => Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {}))),
    };
  } catch (error) {
    await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}
