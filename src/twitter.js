import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function ytdlpBinary() {
  return path.join(process.cwd(), 'bin', 'yt-dlp');
}

function normalizeTwitterUrl(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (host === 'x.com' || host.endsWith('.x.com')) {
      url.hostname = 'twitter.com';
      return url.toString();
    }
  } catch {}
  return input;
}

function hasVideo(format = {}) {
  return format.vcodec && format.vcodec !== 'none';
}

function hasAudio(format = {}) {
  return format.acodec && format.acodec !== 'none';
}

function score(format = {}) {
  const height = Number(format.height || 0);
  const width = Number(format.width || 0);
  const bitrate = Number(format.tbr || format.vbr || 0);
  const audioBonus = hasAudio(format) ? 1_000_000_000 : 0;
  return audioBonus + (height * 1_000_000) + (width * 100) + bitrate;
}

function quality(format = {}) {
  if (format.height) return `${format.height}p`;
  if (format.format_note) return String(format.format_note);
  return hasAudio(format) ? 'video' : 'video (no audio)';
}

function normalizeInfo(raw) {
  if (!raw) return null;
  let info = raw;
  if (typeof raw === 'string') {
    try {
      info = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (Array.isArray(info?.entries) && info.entries.length) {
    return info.entries.find((entry) => entry && typeof entry === 'object') || info;
  }
  return info;
}

export async function parseTwitterVideo(inputUrl) {
  const binary = ytdlpBinary();
  await chmod(binary, 0o755).catch(() => {});

  const url = normalizeTwitterUrl(inputUrl);
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--js-runtimes', `node:${process.execPath}`,
    '--remote-components', 'ejs:github',
    '--',
    url,
  ];

  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: Number(process.env.DOWNLOADER_TIMEOUT_MS || 45000),
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
      },
    });

    const info = normalizeInfo(stdout);
    if (!info) {
      const err = new Error('X/Twitter extractor returned invalid metadata.');
      err.code = 'NO_MEDIA';
      throw err;
    }

    const formats = Array.isArray(info.formats) ? info.formats : [];
    const seen = new Set();
    const videos = formats
      .filter((format) => format?.url && hasVideo(format))
      .sort((a, b) => score(b) - score(a))
      .map((format) => ({
        url: format.url,
        quality: quality(format),
        width: format.width ?? null,
        height: format.height ?? null,
        ext: format.ext ?? 'mp4',
        hasAudio: hasAudio(format),
        source: 'twitter-ytdlp',
        headers: format.http_headers ?? info.http_headers ?? null,
        filesize: format.filesize ?? format.filesize_approx ?? null,
        duration: info.duration ?? null,
      }))
      .filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });

    if (!videos.length && info.url && hasVideo(info)) {
      videos.push({
        url: info.url,
        quality: info.height ? `${info.height}p` : 'video',
        width: info.width ?? null,
        height: info.height ?? null,
        ext: info.ext ?? 'mp4',
        hasAudio: hasAudio(info),
        source: 'twitter-ytdlp',
        headers: info.http_headers ?? null,
        filesize: info.filesize ?? info.filesize_approx ?? null,
        duration: info.duration ?? null,
      });
    }

    if (!videos.length) {
      const err = new Error('X/Twitter post has no downloadable video.');
      err.code = 'NO_MEDIA';
      throw err;
    }

    return {
      platform: 'X / Twitter',
      title: info.title ?? info.description ?? '',
      thumbnail: info.thumbnail ?? '',
      duration: info.duration ?? null,
      images: [],
      videos,
      audios: [],
    };
  } catch (error) {
    if (error?.code === 'NO_MEDIA') throw error;
    const detail = String(error?.stderr || error?.stdout || error?.message || 'X/Twitter yt-dlp failed.');
    const err = new Error(detail);
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }
}
