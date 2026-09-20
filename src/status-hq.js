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

function safeExtension(item, fallback = 'mp4') {
  const ext = String(item?.ext || fallback).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || fallback;
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

async function downloadRemoteFile(item, filePath, label = 'source') {
  if (!item?.url) {
    const err = new Error(`Status HQ ${label} URL is missing.`);
    err.code = 'STATUS_SOURCE_MISSING';
    throw err;
  }

  const response = await fetchWithHeaderTimeout(
    item.url,
    { method: 'GET', headers: sourceHeaders(item.headers), redirect: 'follow' },
    Number(process.env.STATUS_SOURCE_HEADER_TIMEOUT_MS || 30000),
  );

  if (!response.ok || !response.body) {
    const err = new Error(`Status HQ ${label} returned HTTP ${response.status}.`);
    err.code = 'STATUS_SOURCE_FETCH_ERROR';
    throw err;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error(`Status HQ ${label} download is empty.`);
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
  const format = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
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

function sourceColorMode(videoLine = '') {
  const line = String(videoLine || '').toLowerCase();
  const bt2020 = line.includes('bt2020');
  if (bt2020 && line.includes('arib-std-b67')) return 'hlg';
  if (bt2020 && line.includes('smpte2084')) return 'pq';
  return 'sdr';
}

async function probeLocalVideo(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], commandOptions(Number(process.env.STATUS_PROBE_TIMEOUT_MS || 12000)));
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }

  const duration = parseClockDuration(stderr.match(/Duration:\s*([^,]+)/i)?.[1] || '');
  const videoLine = stderr.match(/Video:[^\n]+/i)?.[0] || '';
  const dimensions = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/i);
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
    colorMode: sourceColorMode(videoLine),
  };
}

async function mergeExternalAudio(videoPath, audioPath, outputPath) {
  await rm(outputPath, { force: true }).catch(() => {});
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-shortest', '-map_metadata', '-1', '-f', 'matroska', outputPath,
  ];
  await execFileAsync(ffmpegPath, args, commandOptions(Number(process.env.STATUS_AUDIO_MUX_TIMEOUT_MS || 120000)));
  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Status HQ audio mux produced an empty file.');
    err.code = 'STATUS_AUDIO_MUX_EMPTY';
    throw err;
  }
  return outputPath;
}

async function recoverAudioSource({ inputPath, sourceUrl, platform, audio, base, allPaths }) {
  let activePath = inputPath;
  let probe = await probeLocalVideo(activePath);
  if (probe.hasAudio || platform === 'telegram') return { inputPath: activePath, probe };

  if (audio?.url) {
    const audioPath = `${base}-audio.${safeExtension(audio, 'm4a')}`;
    const muxedPath = `${base}-source-av.mkv`;
    allPaths.push(audioPath, muxedPath);
    try {
      await downloadRemoteFile(audio, audioPath, 'audio');
      await mergeExternalAudio(activePath, audioPath, muxedPath);
      const muxedProbe = await probeLocalVideo(muxedPath);
      if (muxedProbe.hasAudio) {
        console.info('[status-hq] restored source audio using resolver audio track.');
        await rm(activePath, { force: true }).catch(() => {});
        activePath = muxedPath;
        probe = muxedProbe;
        return { inputPath: activePath, probe };
      }
    } catch (error) {
      console.warn('[status-hq] resolver audio restore failed:', error?.code, error?.message);
    }
  }

  if (sourceUrl) {
    try {
      const mergedPath = await downloadWithYtDlp(sourceUrl, `${base}-source-ytdlp-av`, platform || 'generic');
      allPaths.push(mergedPath);
      const mergedProbe = await probeLocalVideo(mergedPath);
      if (mergedProbe.hasAudio) {
        console.info('[status-hq] restored source audio using original URL + yt-dlp.');
        await rm(activePath, { force: true }).catch(() => {});
        activePath = mergedPath;
        probe = mergedProbe;
      } else {
        console.warn('[status-hq] yt-dlp fallback also had no audio; keeping direct source.');
      }
    } catch (error) {
      console.warn('[status-hq] yt-dlp audio restore failed; keeping direct source:', error?.code, error?.message);
    }
  }

  return { inputPath: activePath, probe };
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

function boundedThreadCount(envName) {
  const value = Number(process.env[envName] || 1);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(2, Math.floor(value)));
}

function premiumV2Dimensions(probe) {
  const width = Number(probe.width || 0);
  const height = Number(probe.height || 0);
  const squareish = width && height && Math.abs(width - height) / Math.max(width, height) < 0.08;
  if (squareish) return { maxWidth: 1280, maxHeight: 1280 };
  if (width > height) return { maxWidth: 1280, maxHeight: 720 };
  return { maxWidth: 720, maxHeight: 1280 };
}

function chooseEncodePlan(probe) {
  const duration = Math.max(1, Number(probe.duration || 0));
  const audioKbps = probe.hasAudio ? 128 : 0;
  const targetBytes = targetOutputBytes();
  const totalKbps = Math.max(500, Math.floor((targetBytes * 8 / duration / 1000) * 0.92));
  const maxRateKbps = Math.max(300, Math.min(5000, totalKbps - audioKbps - 80));
  return {
    targetBytes,
    audioKbps,
    maxRateKbps,
    bufferKbps: Math.max(1000, maxRateKbps * 2),
    tier: 720,
    ...premiumV2Dimensions(probe),
    duration,
    fps: '30000/1001',
    scaleFlags: 'lanczos',
    threads: boundedThreadCount('STATUS_FFMPEG_THREADS'),
    filterThreads: boundedThreadCount('STATUS_FILTER_THREADS'),
  };
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

function colorArgs(sourceProbe) {
  if (sourceProbe?.colorMode === 'hlg') {
    return ['-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc'];
  }
  if (sourceProbe?.colorMode === 'pq') {
    return ['-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'];
  }
  return ['-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
}

async function encodeSingleStatusFile(inputPath, outputPath, plan, bitrateScale = 1, sourceProbe = null) {
  await rm(outputPath, { force: true }).catch(() => {});
  const maxRateKbps = Math.max(280, Math.floor(plan.maxRateKbps * bitrateScale));
  const bufferKbps = Math.max(1000, maxRateKbps * 2);
  const hasAudio = Boolean(sourceProbe?.hasAudio);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-nostdin',
    '-filter_threads', String(plan.filterThreads ?? 1),
    '-i', inputPath,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0?'] : []),
    '-vf', statusVideoFilter(plan),
    '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '18',
    '-maxrate', `${maxRateKbps}k`, '-bufsize', `${bufferKbps}k`,
    '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
    '-x265-params', 'pools=1:frame-threads=1:vbv-init=0.8:scenecut=0',
    ...colorArgs(sourceProbe),
    ...(hasAudio
      ? ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', `${plan.audioKbps || 128}k`]
      : ['-an']),
    '-brand', 'isom', '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0',
    '-map_metadata', '-1', '-f', 'mp4', '-threads', String(plan.threads ?? 1), outputPath,
  ];

  try {
    await execFileAsync(ffmpegPath, args, commandOptions(Number(process.env.STATUS_ENCODE_TIMEOUT_MS || 360000)));
  } catch (error) {
    console.error('Premium+ HQ V2 ffmpeg failed:', {
      code: error?.code ?? null,
      signal: error?.signal ?? null,
      killed: Boolean(error?.killed),
      stderr: String(error?.stderr || '').slice(-4000),
    });
    throw error;
  }

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Premium+ HQ V2 encoding completed without an output file.');
    err.code = 'STATUS_OUTPUT_MISSING';
    throw err;
  }

  const outputProbe = await probeLocalVideo(outputPath);
  if (hasAudio && !outputProbe.hasAudio) {
    const err = new Error('Premium+ HQ V2 output lost the source audio track.');
    err.code = 'STATUS_AUDIO_MISSING';
    throw err;
  }

  return { size: fileStat.size, videoKbps: maxRateKbps, hasAudio: outputProbe.hasAudio };
}

async function cleanup(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

export async function prepareWhatsAppStatusHQ({ sourceUrl, platform, video, audio = null }) {
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
        await downloadRemoteFile(video, inputPath, 'video');
      } catch (directError) {
        if (!sourceUrl || platform === 'telegram') throw directError;
        console.warn('Status HQ direct source fetch failed; falling back to yt-dlp:', directError?.code, directError?.message);
        await rm(inputPath, { force: true }).catch(() => {});
        inputPath = await downloadWithYtDlp(sourceUrl, `${base}-source-ytdlp`, platform || 'generic');
        allPaths.push(inputPath);
      }
    }

    const recovered = await recoverAudioSource({ inputPath, sourceUrl, platform, audio, base, allPaths });
    inputPath = recovered.inputPath;
    const probe = recovered.probe;
    const plan = chooseEncodePlan(probe);
    const safeLimit = Math.floor(configuredUploadLimitBytes() * 0.94);
    const attempts = [1, 0.84, 0.7];
    let encoded = null;
    let outputPath = '';
    let usedAttempt = 0;

    for (let index = 0; index < attempts.length; index += 1) {
      outputPath = `${base}-premium-plus-v2-a${index + 1}.mp4`;
      allPaths.push(outputPath);
      encoded = await encodeSingleStatusFile(inputPath, outputPath, plan, attempts[index], probe);
      usedAttempt = index + 1;
      if (encoded.size <= safeLimit) break;
      await rm(outputPath, { force: true }).catch(() => {});
    }

    if (!encoded || encoded.size > safeLimit) {
      const err = new Error(`Premium+ HQ V2 output masih melebihi had Telegram (${encoded?.size || 0} bytes).`);
      err.code = 'STATUS_FILE_TOO_LARGE';
      throw err;
    }

    await rm(inputPath, { force: true }).catch(() => {});
    return {
      filePath: outputPath,
      size: encoded.size,
      source: probe,
      profile: {
        mode: 'premium-plus-v2',
        tier: 720,
        maxWidth: plan.maxWidth,
        maxHeight: plan.maxHeight,
        videoKbps: encoded.videoKbps,
        audioKbps: plan.audioKbps,
        hasAudio: encoded.hasAudio,
        colorMode: probe.colorMode,
        codec: 'hevc-main10',
      },
      quality: `Premium+ HQ V2 • 720p class • 29.97fps • HEVC Main10/AAC-LC • preservation-first • ${probe.colorMode.toUpperCase()}`,
      attempt: usedAttempt,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}
