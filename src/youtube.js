const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://invidious.f5.si',
];

function youtubeIdFromUrl(input) {
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const parts = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live'].includes(parts[0])) return parts[1] || '';
    }
  } catch {}
  return '';
}

function absoluteUrl(value, base) {
  if (!value) return '';
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

function parseResolution(value = '') {
  const match = String(value).match(/(\d{3,4})p/i);
  return match ? Number(match[1]) : null;
}

export async function parseYouTubeFree(inputUrl) {
  const videoId = youtubeIdFromUrl(inputUrl);
  if (!videoId) {
    const err = new Error('YouTube video ID tidak dapat dibaca.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  const failures = [];
  for (const base of INVIDIOUS_INSTANCES) {
    const host = new URL(base).host;
    try {
      const response = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}?region=US`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; ARDownloader/1.0)',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        failures.push(`${host}:${response.status}`);
        continue;
      }

      const data = await response.json();
      const streams = Array.isArray(data?.formatStreams) ? data.formatStreams : [];
      const videos = streams
        .filter((stream) => stream?.url)
        .map((stream) => {
          const quality = stream.qualityLabel || stream.quality || stream.resolution || 'video';
          const height = parseResolution(quality);
          return {
            url: absoluteUrl(stream.url, base),
            quality,
            width: null,
            height,
            ext: String(stream.container || '').toLowerCase() || (String(stream.type || '').includes('mp4') ? 'mp4' : null),
            hasAudio: true,
            source: 'invidious',
            headers: null,
            filesize: null,
          };
        })
        .filter((item) => item.url);

      if (!videos.length) {
        failures.push(`${host}:no-formatStreams`);
        continue;
      }

      return {
        platform: 'YouTube',
        title: data.title || '',
        thumbnail: Array.isArray(data.videoThumbnails) ? (data.videoThumbnails.find((item) => item?.url)?.url || '') : '',
        duration: Number(data.lengthSeconds || 0) || null,
        images: [],
        videos,
        audios: [],
      };
    } catch (error) {
      failures.push(`${host}:${error?.name || 'error'}`);
    }
  }

  const err = new Error(`YouTube free extractors unavailable: ${failures.join(', ')}`);
  err.code = 'DOWNLOADER_ERROR';
  throw err;
}
