import youtubedl from 'youtube-dl-exec';

function normalizeInfo(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function qualityLabel(format = {}) {
  if (format.height) return `${format.height}p`;
  if (format.format_note) return String(format.format_note);
  if (format.format) return String(format.format);
  return 'video';
}

function hasAudio(format = {}) {
  return format.acodec && format.acodec !== 'none';
}

function hasVideo(format = {}) {
  return format.vcodec && format.vcodec !== 'none';
}

function usableVideoFormats(info = {}) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const direct = formats
    .filter((f) => f?.url && hasVideo(f) && hasAudio(f))
    .map((f) => ({
      url: f.url,
      quality: qualityLabel(f),
      width: f.width ?? null,
      height: f.height ?? null,
      ext: f.ext ?? null,
      hasAudio: true,
      source: 'direct',
      headers: f.http_headers ?? info.http_headers ?? null,
      filesize: f.filesize ?? f.filesize_approx ?? null,
    }));

  if (direct.length) return direct;

  if (info.url) {
    return [{
      url: info.url,
      quality: info.height ? `${info.height}p` : 'video',
      width: info.width ?? null,
      height: info.height ?? null,
      ext: info.ext ?? null,
      hasAudio: info.acodec !== 'none',
      source: 'direct',
      headers: info.http_headers ?? null,
      filesize: info.filesize ?? info.filesize_approx ?? null,
    }];
  }

  return [];
}

export async function parseMedia(url) {
  if (/threads\.(net|com)/i.test(url)) {
    const err = new Error('Threads needs a dedicated free extractor adapter.');
    err.code = 'THREADS_ADAPTER_PENDING';
    throw err;
  }

  let raw;
  try {
    raw = await youtubedl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noPlaylist: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
    }, {
      timeout: Number(process.env.DOWNLOADER_TIMEOUT_MS || 25000),
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const err = new Error(error?.stderr || error?.message || 'yt-dlp failed.');
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  const info = normalizeInfo(raw);
  if (!info) {
    const err = new Error('yt-dlp returned invalid metadata.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  const videos = usableVideoFormats(info);
  if (!videos.length) {
    const err = new Error('No directly downloadable video format was found.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  return {
    platform: info.extractor_key ?? info.extractor ?? null,
    title: info.title ?? '',
    thumbnail: info.thumbnail ?? '',
    duration: info.duration ?? null,
    images: [],
    videos,
    audios: [],
  };
}

function qualityScore(value = '') {
  const match = String(value).match(/(\d{3,4})p?/i);
  return match ? Number(match[1]) : 0;
}

export function chooseBestVideo(videos = []) {
  if (!videos.length) return null;

  return [...videos].sort((a, b) => {
    const aDirectAudio = Number(a?.hasAudio !== false && a?.source === 'direct');
    const bDirectAudio = Number(b?.hasAudio !== false && b?.source === 'direct');
    if (aDirectAudio !== bDirectAudio) return bDirectAudio - aDirectAudio;

    const aAudio = Number(a?.hasAudio !== false);
    const bAudio = Number(b?.hasAudio !== false);
    if (aAudio !== bAudio) return bAudio - aAudio;

    return qualityScore(b?.quality) - qualityScore(a?.quality);
  })[0];
}

export function needsCustomHeaders(item) {
  const headers = item?.headers && typeof item.headers === 'object' ? item.headers : null;
  if (!headers) return false;
  const keys = Object.keys(headers).filter((key) => {
    const lower = key.toLowerCase();
    return lower !== 'accept-language' && lower !== 'accept';
  });
  return keys.length > 0;
}
