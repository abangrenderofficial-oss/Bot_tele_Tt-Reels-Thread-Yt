const DEFAULT_API_URL = 'https://api.easydown.org/api/v1/parse';

function timeoutSignal(ms = 20000) {
  return AbortSignal.timeout(ms);
}

function normalizeMedia(payload) {
  const root = payload?.data?.media ?? payload?.data ?? payload?.media ?? payload;
  if (!root || typeof root !== 'object') {
    throw new Error('Downloader returned an invalid response.');
  }

  return {
    platform: root.platform ?? null,
    title: root.title ?? payload?.data?.title ?? '',
    thumbnail: root.thumbnail ?? payload?.data?.thumbnail ?? '',
    duration: root.duration ?? payload?.data?.duration ?? null,
    images: Array.isArray(root.images) ? root.images.filter((item) => item?.url) : [],
    videos: Array.isArray(root.videos) ? root.videos.filter((item) => item?.url) : [],
    audios: Array.isArray(root.audios) ? root.audios.filter((item) => item?.url) : [],
  };
}

export async function parseMedia(url) {
  const token = process.env.EASYDOWN_API_TOKEN;
  if (!token) {
    const err = new Error('Downloader API is not configured.');
    err.code = 'DOWNLOADER_NOT_CONFIGURED';
    throw err;
  }

  const apiUrl = process.env.EASYDOWN_API_URL || DEFAULT_API_URL;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ url }),
    signal: timeoutSignal(Number(process.env.DOWNLOADER_TIMEOUT_MS || 20000)),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Downloader returned HTTP ${response.status} with non-JSON content.`);
  }

  if (!response.ok || payload?.status >= 400) {
    const message = payload?.msg || payload?.message || payload?.detail || `Downloader error (${response.status}).`;
    const err = new Error(String(message));
    err.code = 'DOWNLOADER_ERROR';
    err.status = response.status;
    throw err;
  }

  const media = normalizeMedia(payload);
  if (!media.images.length && !media.videos.length && !media.audios.length) {
    const err = new Error('No downloadable media was found for this link.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  return media;
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
  return !!item?.headers && Object.keys(item.headers).length > 0;
}
