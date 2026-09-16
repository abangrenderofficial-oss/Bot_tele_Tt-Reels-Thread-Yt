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

// This profile mirrors the empirically-tested StatusDrop defaults that were
// designed for WhatsApp Status delivery: fixed portrait canvas, H.264/AAC,
// 29-second chunks, capped rate, faststart and a per-clip size target below
// 16 MiB. It cannot stop WhatsApp from re-encoding, but it prepares the file
// in the format that has performed well in real-device testing.
const STATUS_PROFILE = Object.freeze({
  width: 1080,
  height: 1920,
  clipSeconds: 29,
  fps: '30000/1001',
  crf: 23,
  maxRateKbps: 3800,
  bufferKbps: 5700,
  audioKbps: 128,
  sampleRate: 44100,
  sizeLimitBytes: Math.round(15.5 * 1024 * 1024),
});

const RETRY_PROFILES = [
  { crf: 23, maxRateKbps: 3800, bufferKbps: 5700 },
  { crf: 24, maxRateKbps: 3300, bufferKbps: 4950 },
  { crf: 25, maxRateKbps: 2800, bufferKbps: 4200 },
];

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
    signal: AbortSignal.timeout(Number(process.env.STATUS_SOURCE_TIMEOUT_MS || 60000)),
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
    commandOptions(Number(process.env.STATUS_YOUTUBE_TIMEOUT_MS || 65000)),
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
      commandOptions(Number(process.env.STATUS_PROBE_TIMEOUT_MS || 10000)),
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

function statusVideoFilter() {
  return [
    `scale=w=${STATUS_PROFILE.width}:h=${STATUS_PROFILE.height}:force_original_aspect_ratio=decrease`,
    `pad=${STATUS_PROFILE.width}:${STATUS_PROFILE.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    `fps=${STATUS_PROFILE.fps}`,
  ].join(',');
}

async function encodeStatusClip(inputPath, outputPath, startSeconds, durationSeconds, rateProfile) {
  await rm(outputPath, { force: true }).catch(() => {});

  const args = [
    '-y',
    '-ss', String(startSeconds),
    '-t', String(durationSeconds),
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', statusVideoFilter(),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-color_primaries', 'bt470bg',
    '-color_trc', 'bt709',
    '-colorspace', 'bt470bg',
    '-crf', String(rateProfile.crf),
    '-maxrate', `${rateProfile.maxRateKbps}k`,
    '-bufsize', `${rateProfile.bufferKbps}k`,
    '-g', '250',
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-x264-params', 'sei=0',
    '-c:a', 'aac',
    '-ar', String(STATUS_PROFILE.sampleRate),
    '-ac', '2',
    '-b:a', `${STATUS_PROFILE.audioKbps}k`,
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
    commandOptions(Number(process.env.STATUS_ENCODE_TIMEOUT_MS || 90000)),
  );

  const fileStat = await stat(outputPath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Status HQ encoding completed without an output file.');
    err.code = 'STATUS_OUTPUT_MISSING';
    throw err;
  }
  return fileStat.size;
}

async function encodeClipWithRetries(inputPath, outputBase, index, startSeconds, durationSeconds, allPaths) {
  let lastPath = '';
  let lastSize = 0;

  for (let attempt = 0; attempt < RETRY_PROFILES.length; attempt += 1) {
    const outputPath = `${outputBase}-part-${String(index + 1).padStart(2, '0')}-a${attempt + 1}.mp4`;
    allPaths.push(outputPath);
    lastPath = outputPath;
    lastSize = await encodeStatusClip(
      inputPath,
      outputPath,
      startSeconds,
      durationSeconds,
      RETRY_PROFILES[attempt],
    );

    if (lastSize <= STATUS_PROFILE.sizeLimitBytes) {
      return { filePath: outputPath, size: lastSize, attempt: attempt + 1 };
    }

    await rm(outputPath, { force: true }).catch(() => {});
  }

  const err = new Error(`Status HQ clip still exceeds target size (${lastSize} bytes).`);
  err.code = 'STATUS_CLIP_TOO_LARGE';
  err.filePath = lastPath;
  throw err;
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
    const clipCount = Math.ceil(probe.duration / STATUS_PROFILE.clipSeconds);
    const maxClips = Math.max(1, Number(process.env.STATUS_HQ_MAX_CLIPS || 6));
    if (clipCount > maxClips) {
      const err = new Error(
        `Video ini perlukan ${clipCount} bahagian Status HQ. Had semasa ialah ${maxClips} bahagian supaya proses tak timeout.`,
      );
      err.code = 'STATUS_TOO_MANY_CLIPS';
      err.clipCount = clipCount;
      err.maxClips = maxClips;
      throw err;
    }

    const clips = [];
    for (let index = 0; index < clipCount; index += 1) {
      const startSeconds = index * STATUS_PROFILE.clipSeconds;
      const durationSeconds = Math.min(STATUS_PROFILE.clipSeconds, probe.duration - startSeconds);
      const encoded = await encodeClipWithRetries(
        inputPath,
        base,
        index,
        startSeconds,
        durationSeconds,
        allPaths,
      );
      clips.push({
        ...encoded,
        index: index + 1,
        count: clipCount,
        duration: durationSeconds,
      });
    }

    await rm(inputPath, { force: true }).catch(() => {});

    return {
      clips,
      source: probe,
      quality: 'Status HQ • 1080×1920 • H.264/AAC • 29s max/part',
      profile: STATUS_PROFILE,
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}
