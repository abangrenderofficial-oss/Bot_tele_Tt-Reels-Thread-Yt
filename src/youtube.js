const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://invidious.f5.si',
];

const COBALT_TRACKER = 'https://instances.cobalt.best/instances.json';
const STATIC_COBALT = [
  'https://cobalt-api.meowing.de',
  'https://capi.3kh0.net',
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

async function tryInvidious(inputUrl, failures) {
  const videoId = youtubeIdFromUrl(inputUrl);
  for (const base of INVIDIOUS_INSTANCES) {
    const host = new URL(base).host;
    try {
      const response = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}?region=US`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; ARDownloader/1.0)',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        failures.push(`inv:${host}:${response.status}`);
        continue;
      }

      const data = await response.json();
      const streams = Array.isArray(data?.formatStreams) ? data.formatStreams : [];
      const videos = streams
        .filter((stream) => stream?.url)
        .map((stream) => {
          const quality = stream.qualityLabel || stream.quality || stream.resolution || 'video';
          return {
            url: absoluteUrl(stream.url, base),
            quality,
            width: null,
            height: parseResolution(quality),
            ext: String(stream.container || '').toLowerCase() || (String(stream.type || '').includes('mp4') ? 'mp4' : null),
            hasAudio: true,
            source: 'invidious',
            headers: null,
            filesize: null,
          };
        })
        .filter((item) => item.url);

      if (!videos.length) {
        failures.push(`inv:${host}:no-formatStreams`);
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
      failures.push(`inv:${host}:${error?.name || 'error'}`);
    }
  }
  return null;
}

async function discoverCobaltInstances() {
  const discovered = [];
  try {
    const response = await fetch(COBALT_TRACKER, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ARDownloader/1.0 (+https://github.com/abangrenderofficial-oss/Bot_tele_Tt-Reels-Thread-Yt)',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const list = await response.json();
      if (Array.isArray(list)) {
        list
          .filter((item) => item?.online === true || item?.online?.api === true)
          .filter((item) => item?.services?.youtube === true)
          .filter((item) => item?.info?.auth !== true)
          .filter((item) => item?.api)
          .filter((item) => !String(item.api).includes('imput.net') && !String(item.api).includes('cobalt.tools'))
          .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
          .slice(0, 6)
          .forEach((item) => {
            const protocol = item.protocol === 'http' ? 'http' : 'https';
            discovered.push(`${protocol}://${String(item.api).replace(/^https?:\/\//, '').replace(/\/$/, '')}`);
          });
      }
    }
  } catch {}

  return [...new Set([...discovered, ...STATIC_COBALT])];
}

async function tryCobalt(inputUrl, failures) {
  const instances = await discoverCobaltInstances();
  for (const base of instances.slice(0, 8)) {
    let host = base;
    try { host = new URL(base).host; } catch {}
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'ARDownloader/1.0 (+https://github.com/abangrenderofficial-oss/Bot_tele_Tt-Reels-Thread-Yt)',
        },
        body: JSON.stringify({
          url: inputUrl,
          downloadMode: 'auto',
          videoQuality: '720',
          youtubeVideoCodec: 'h264',
          youtubeVideoContainer: 'mp4',
          disableMetadata: true,
          alwaysProxy: true,
          localProcessing: 'disabled',
        }),
        signal: AbortSignal.timeout(18000),
      });

      const raw = await response.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}

      if (!response.ok) {
        const detail = data?.error?.code || data?.code || raw.replace(/\s+/g, ' ').slice(0, 180) || 'empty';
        failures.push(`cobalt:${host}:${response.status}:${detail}`);
        continue;
      }

      if ((data?.status === 'tunnel' || data?.status === 'redirect') && data?.url) {
        return {
          platform: 'YouTube',
          title: data.filename || 'YouTube video',
          thumbnail: '',
          duration: null,
          images: [],
          videos: [{
            url: absoluteUrl(data.url, base),
            quality: '720p',
            width: null,
            height: 720,
            ext: 'mp4',
            hasAudio: true,
            source: 'cobalt',
            headers: null,
            filesize: null,
          }],
          audios: [],
        };
      }

      if (data?.status === 'picker' && Array.isArray(data.picker)) {
        const video = data.picker.find((item) => item?.type === 'video' && item?.url);
        if (video) {
          return {
            platform: 'YouTube',
            title: data.filename || 'YouTube video',
            thumbnail: video.thumb || '',
            duration: null,
            images: [],
            videos: [{
              url: absoluteUrl(video.url, base),
              quality: 'video',
              width: null,
              height: null,
              ext: 'mp4',
              hasAudio: true,
              source: 'cobalt',
              headers: null,
              filesize: null,
            }],
            audios: [],
          };
        }
      }

      failures.push(`cobalt:${host}:${data?.status || data?.error?.code || 'invalid-response'}`);
    } catch (error) {
      failures.push(`cobalt:${host}:${error?.name || 'error'}`);
    }
  }
  return null;
}

export async function parseYouTubeFree(inputUrl) {
  const videoId = youtubeIdFromUrl(inputUrl);
  if (!videoId) {
    const err = new Error('YouTube video ID tidak dapat dibaca.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  const failures = [];
  const invidious = await tryInvidious(inputUrl, failures);
  if (invidious) return invidious;

  const cobalt = await tryCobalt(inputUrl, failures);
  if (cobalt) return cobalt;

  const err = new Error(`YouTube free extractors unavailable: ${failures.join(', ')}`);
  err.code = 'DOWNLOADER_ERROR';
  throw err;
}
