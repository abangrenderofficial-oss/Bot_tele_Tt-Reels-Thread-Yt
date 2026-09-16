import { execFile } from 'node:child_process';
import { chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

const QUALITY_PROFILES = [
  {
    label: '1080p',
    selector: 'bestvideo[ext=mp4][height<=1080][height>720]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080][height>720]',
  },
  {
    label: '720p',
    selector: 'bestvideo[ext=mp4][height<=720][height>480]+bestaudio[ext=m4a]/best[ext=mp4][height<=720][height>480]',
  },
  {
    label: '480p',
    selector: 'bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]',
  },
];

function ytdlpBinary() {
  return path.join(process.cwd(), 'bin', 'yt-dlp');
}

function commonArgs() {
  return [
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
  ];
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

function selectedSize(info = {}) {
  const requested = Array.isArray(info.requested_formats) ? info.requested_formats : [];
  if (requested.length) {
    let total = 0;
    for (const format of requested) {
      const size = Number(format?.filesize || format?.filesize_approx || 0);
      if (!size) return 0;
      total += size;
    }
    return total;
  }
  return Number(info.filesize || info.filesize_approx || 0);
}

async function probe(url, profile) {
  const binary = ytdlpBinary();
  await chmod(binary, 0o755).catch(() => {});
  const args = [
    ...commonArgs(),
    '--dump-single-json',
    '--skip-download',
    '--format', profile.selector,
    '--',
    url,
  ];

  try {
    const { stdout } = await execFileAsync(
      binary,
      args,
      commandOptions(Number(process.env.YOUTUBE_PROBE_TIMEOUT_MS || 12000)),
    );
    const info = JSON.parse(stdout);
    return {
      info,
      estimatedSize: selectedSize(info),
      title: String(info?.title || ''),
    };
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || 'yt-dlp probe failed');
    if (/Requested format is not available|format is not available|No video formats found/i.test(detail)) {
      return null;
    }
    throw error;
  }
}

async function download(url, profile, outputBase) {
  const binary = ytdlpBinary();
  const outputTemplate = `${outputBase}.%(ext)s`;
  const args = [
    ...commonArgs(),
    '--format', profile.selector,
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
    commandOptions(Number(process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS || 35000)),
  );

  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const reported = lines.at(-1);
  const candidates = [reported, `${outputBase}.mp4`, `${outputBase}.mkv`, `${outputBase}.webm`].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) return { filePath: candidate, size: fileStat.size };
    } catch {}
  }

  const err = new Error('yt-dlp completed but the merged output file was not found.');
  err.code = 'YOUTUBE_OUTPUT_MISSING';
  throw err;
}

export async function prepareYouTubeTelegramUpload(url, maxBytes) {
  const limit = Number(maxBytes || 0);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('A valid Telegram upload limit is required.');

  const attemptId = randomUUID();
  const outputBase = path.join(tmpdir(), `ar-youtube-${attemptId}`);
  let lastError = null;

  for (const profile of QUALITY_PROFILES) {
    let probeResult;
    try {
      probeResult = await probe(url, profile);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!probeResult) continue;

    if (probeResult.estimatedSize && probeResult.estimatedSize > limit) {
      console.info(`YouTube ${profile.label} skipped: estimated ${probeResult.estimatedSize} > ${limit}.`);
      continue;
    }

    try {
      const result = await download(url, profile, outputBase);
      if (result.size > limit) {
        console.info(`YouTube ${profile.label} skipped after download: ${result.size} > ${limit}.`);
        await rm(result.filePath, { force: true }).catch(() => {});
        continue;
      }

      return {
        ...result,
        quality: profile.label,
        title: probeResult.title,
        cleanup: async () => {
          await rm(result.filePath, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      lastError = error;
      for (const extension of ['mp4', 'mkv', 'webm', 'm4a', 'part']) {
        await rm(`${outputBase}.${extension}`, { force: true }).catch(() => {});
      }
    }
  }

  const err = new Error(lastError?.message || 'No 1080p/720p/480p YouTube version fits the Telegram upload limit.');
  err.code = 'YOUTUBE_NO_SENDABLE_QUALITY';
  throw err;
}
