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
    out['User-Agent'] = 'Mozilla/5.0 (compatible; ARDownloader-HQLabPremiumPlus/1.0)';
  }
  return out;
}

function safeExtension(item, fallback = 'mp4') {
  const ext = String(item?.ext || fallback).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || fallback;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 30000));
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadRemoteFile(item, filePath, label = 'source') {
  if (!item?.url) throw new Error(`Premium+ ${label} URL is missing.`);
  const response = await fetchWithTimeout(
    item.url,
    { method: 'GET', headers: sourceHeaders(item.headers) },
    Number(process.env.HQ_LAB_SOURCE_HEADER_TIMEOUT_MS || 30000),
  );
  if (!response.ok || !response.body) throw new Error(`Premium+ ${label} returned HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const info = await stat(filePath);
  if (!info.isFile() || !info.size) throw new Error(`Premium+ ${label} download is empty.`);
  return filePath;
}

async function downloadWithYtDlp(url, outputBase) {
  const binary = ytdlpBinary();
  await chmod(binary, 0o755).catch(() => {});
  const args = [
    ...ytdlpCommonArgs(),
    '--format', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegPath,
    '--no-progress',
    '--output', `${outputBase}.%(ext)s`,
    '--print', 'after_move:filepath',
    '--', url,
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
  throw new Error('Premium+ yt-dlp did not produce a video file.');
}

function parseClockDuration(value) {
  const match = String(value || '').match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function parseFps(videoLine) {
  const fps = Number(String(videoLine || '').match(/(?:,|\s)(\d+(?:\.\d+)?)\s*fps\b/i)?.[1] || 0);
  return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : 30;
}

async function probeVideo(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], commandOptions(15000));
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }
  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const videoLine = stderr.match(/Video:[^\n]+/i)?.[0] || '';
  const dimensions = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/i);
  if (!duration || !dimensions) throw new Error('Premium+ could not determine video metadata.');
  return {
    duration,
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    fps: parseFps(videoLine),
    hasAudio: /Audio:/i.test(stderr),
  };
}

async function mergeExternalAudio(videoPath, audioPath, outputPath) {
  await rm(outputPath, { force: true }).catch(() => {});
  await execFileAsync(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-shortest', '-map_metadata', '-1', '-f', 'matroska', outputPath,
  ], commandOptions(Number(process.env.HQ_LAB_MUX_TIMEOUT_MS || 120000)));
  return outputPath;
}

async function recoverAudio({ inputPath, sourceUrl, platform, audio, base, paths }) {
  let activePath = inputPath;
  let source = await probeVideo(activePath);
  if (source.hasAudio || platform === 'telegram') return { inputPath: activePath, source };

  if (audio?.url) {
    const audioPath = `${base}-audio.${safeExtension(audio, 'm4a')}`;
    const muxedPath = `${base}-source-av.mkv`;
    paths.push(audioPath, muxedPath);
    try {
      await downloadRemoteFile(audio, audioPath, 'audio');
      await mergeExternalAudio(activePath, audioPath, muxedPath);
      const muxedProbe = await probeVideo(muxedPath);
      if (muxedProbe.hasAudio) return { inputPath: muxedPath, source: muxedProbe };
    } catch (error) {
      console.warn('[hq-lab/premium+] resolver audio restore failed:', error?.message);
    }
  }

  if (sourceUrl) {
    try {
      const mergedPath = await downloadWithYtDlp(sourceUrl, `${base}-ytdlp-av`);
      paths.push(mergedPath);
      const mergedProbe = await probeVideo(mergedPath);
      if (mergedProbe.hasAudio) return { inputPath: mergedPath, source: mergedProbe };
    } catch (error) {
      console.warn('[hq-lab/premium+] yt-dlp audio restore failed:', error?.message);
    }
  }

  return { inputPath: activePath, source };
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

function premiumPlan(source) {
  const duration = Math.max(1, Number(source.duration || 0));
  const audioKbps = source.hasAudio ? 128 : 0;
  const totalKbps = Math.max(420, Math.floor((targetOutputBytes() * 8 / duration / 1000) * 0.92));
  const videoKbps = Math.max(280, Math.min(3350, totalKbps - audioKbps - 60));
  const maxRateKbps = Math.max(videoKbps, Math.min(3900, Math.floor(videoKbps * 1.16)));
  return { videoKbps, audioKbps, maxRateKbps, bufferKbps: Math.max(1000, maxRateKbps * 2) };
}

async function canBurnLabel() {
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=s=64x64:d=0.05',
      '-vf', "drawtext=text='TEST':x=2:y=2:fontsize=12:fontcolor=white",
      '-frames:v', '1', '-f', 'null', '-',
    ], commandOptions(7000));
    return true;
  } catch {
    return false;
  }
}

function scaleFilter(source) {
  if (source.width === source.height) return "scale=1280:1280:flags=lanczos";
  if (source.width > source.height) return "scale=1280:-2:flags=lanczos";
  return "scale=-2:1280:flags=lanczos";
}

async function encodePremiumPlus(inputPath, outputPath, source) {
  const plan = premiumPlan(source);
  const burnLabel = await canBurnLabel();
  const filters = [
    scaleFilter(source),
    'setsar=1',
    'fps=30000/1001',
    'hqdn3d=0.18:0.18:0.70:0.70',
    'unsharp=5:5:0.18:3:3:0.0',
    'eq=contrast=1.012:saturation=1.015',
  ];
  if (burnLabel) {
    filters.push("drawtext=text='PREMIUM + HQ':x=24:y=24:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=10");
  }

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-filter_threads', '1', '-i', inputPath,
    '-map', '0:v:0', ...(source.hasAudio ? ['-map', '0:a:0?'] : []),
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-b:v', `${plan.videoKbps}k`, '-maxrate', `${plan.maxRateKbps}k`, '-bufsize', `${plan.bufferKbps}k`,
    '-profile:v', 'main', '-level:v', '3.1', '-tag:v', 'avc1',
    '-g', '60', '-keyint_min', '30', '-sc_threshold', '0',
    ...(source.hasAudio ? ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '128k'] : ['-an']),
    '-brand', 'isom', '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0',
    '-map_metadata', '-1', '-f', 'mp4', '-threads', '1', outputPath,
  ];

  const startedAt = performance.now();
  await execFileAsync(ffmpegPath, args, commandOptions(Number(process.env.HQ_LAB_ENCODE_TIMEOUT_MS || 360000)));
  const elapsedMs = Math.round(performance.now() - startedAt);
  const info = await stat(outputPath);
  const output = await probeVideo(outputPath).catch(() => null);
  if (source.hasAudio && output && !output.hasAudio) throw new Error('Premium+ lost the source audio track.');

  return {
    ok: true,
    id: 'PREMIUM+',
    slug: 'premiumplus',
    name: 'Premium + HQ',
    label: 'PREMIUM + HQ',
    videoKbps: plan.videoKbps,
    audioKbps: plan.audioKbps,
    filePath: outputPath,
    size: info.size,
    elapsedMs,
    output,
    burnLabel,
  };
}

export async function preparePremiumPlusHq({ sourceUrl = '', platform = 'generic', video = null, audio = null }) {
  const base = path.join(tmpdir(), `ar-hqlab-premiumplus-${randomUUID()}`);
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
        await downloadRemoteFile(video, inputPath, 'video');
      } catch (error) {
        if (!sourceUrl) throw error;
        await rm(inputPath, { force: true }).catch(() => {});
        inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source-ytdlp`);
        paths.push(inputPath);
      }
    } else if (sourceUrl) {
      inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source`);
      paths.push(inputPath);
    } else {
      throw new Error('Premium+ has no usable input source.');
    }

    const recovered = await recoverAudio({ inputPath, sourceUrl, platform, audio, base, paths });
    inputPath = recovered.inputPath;
    const source = recovered.source;
    const outputPath = `${base}-premiumplus.mp4`;
    paths.push(outputPath);
    const result = await encodePremiumPlus(inputPath, outputPath, source);

    return {
      source,
      result,
      cleanup: () => Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {}))),
    };
  } catch (error) {
    await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
    throw error;
  }
}
