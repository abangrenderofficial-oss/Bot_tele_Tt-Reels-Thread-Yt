const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const THREADS_REFERER = 'https://www.threads.com/';
const MEDIA_KEYS = new Set(['video_versions', 'video_dash_manifest', 'image_versions2', 'carousel_media']);

function decodeHtml(value = '') {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function readMeta(html, keys) {
  const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attrs[match[1].toLowerCase()] = decodeHtml(match[3]);
    }
    const name = String(attrs.property || attrs.name || '').toLowerCase();
    if (wanted.has(name) && attrs.content) return attrs.content;
  }
  return '';
}

function urlOrEmpty(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(decodeHtml(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function targetCodeFromUrl(input) {
  try {
    const pathname = new URL(input).pathname;
    return pathname.match(/\/(?:post|t)\/([\w-]+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function collectPosts(value, out, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPosts(item, out, seen);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const code = typeof value.code === 'string' ? value.code : '';
  const hasMedia = Object.keys(value).some((key) => MEDIA_KEYS.has(key));
  if (code && hasMedia && !seen.has(value)) {
    seen.add(value);
    out.push(value);
  }
  for (const child of Object.values(value)) collectPosts(child, out, seen);
}

function extractPosts(html) {
  const posts = [];
  const seen = new Set();
  const regex = /<script\b(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(regex)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      collectPosts(JSON.parse(raw), posts, seen);
    } catch {
      // Threads includes unrelated JSON blocks. Ignore blocks that are not valid JSON.
    }
  }
  return posts;
}

function headers() {
  return {
    Referer: THREADS_REFERER,
    'User-Agent': GOOGLEBOT_UA,
  };
}

function bestImage(media) {
  const candidates = Array.isArray(media?.image_versions2?.candidates)
    ? media.image_versions2.candidates
    : [];
  return candidates
    .map((item) => ({
      url: urlOrEmpty(item?.url),
      width: Number(item?.width || 0),
      height: Number(item?.height || 0),
    }))
    .filter((item) => item.url)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
}

function addMedia(media, result, itemIndex = 0) {
  if (!media || typeof media !== 'object') return;

  const versions = Array.isArray(media.video_versions) ? media.video_versions : [];
  const fallbackWidth = Number(media.original_width || 0) || null;
  const fallbackHeight = Number(media.original_height || 0) || null;
  const videoSeen = new Set(result.videos.map((item) => item.url.split('?')[0]));

  for (const version of versions) {
    const url = urlOrEmpty(version?.url);
    if (!url) continue;
    const path = url.split('?')[0];
    if (videoSeen.has(path)) continue;
    videoSeen.add(path);

    const width = Number(version?.width || 0) || fallbackWidth;
    const height = Number(version?.height || 0) || fallbackHeight;
    result.videos.push({
      url,
      quality: height ? `${height}p` : `video${itemIndex ? ` ${itemIndex + 1}` : ''}`,
      width,
      height,
      ext: 'mp4',
      hasAudio: media.has_audio !== false,
      source: 'threads-direct',
      headers: headers(),
      filesize: null,
      itemIndex,
    });
  }

  // image_versions2 is also the thumbnail for video posts. Only treat it as
  // a downloadable image when this media item does not contain video versions.
  if (!versions.length) {
    const image = bestImage(media);
    if (image && !result.images.some((item) => item.url === image.url)) {
      result.images.push({ ...image, headers: headers(), itemIndex });
    }
  }
}

function postCaption(post) {
  const caption = post?.caption?.text || post?.accessibility_caption || '';
  return decodeHtml(String(caption || '')).trim();
}

export async function parseThreadsPost(url) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': GOOGLEBOT_UA,
      },
      signal: AbortSignal.timeout(Number(process.env.DOWNLOADER_TIMEOUT_MS || 25000)),
    });
  } catch (error) {
    const err = new Error(`Threads request failed: ${error?.message || error}`);
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`Threads HTTP ${response.status}`);
    err.code = 'DOWNLOADER_ERROR';
    throw err;
  }

  const html = await response.text();
  const canonical = readMeta(html, ['og:url']);
  const targetCode = targetCodeFromUrl(url) || targetCodeFromUrl(canonical) || targetCodeFromUrl(response.url);
  const posts = extractPosts(html);

  let post = targetCode ? posts.find((item) => item?.code === targetCode) : null;
  if (!post && !targetCode) {
    post = posts.find((item) => Array.isArray(item?.video_versions) && item.video_versions.length)
      || posts[0]
      || null;
  }

  if (!post) {
    // Safe fallback: only accept explicit OpenGraph video metadata. We do not
    // fall back to og:image because it can be just the thumbnail of a video.
    const ogVideo = readMeta(html, ['og:video', 'og:video:secure_url', 'twitter:player:stream']);
    const direct = urlOrEmpty(ogVideo);
    if (direct) {
      return {
        platform: 'Threads',
        title: readMeta(html, ['og:title', 'twitter:title']) || 'Threads video',
        thumbnail: readMeta(html, ['og:image', 'twitter:image']) || '',
        duration: null,
        images: [],
        videos: [{
          url: direct,
          quality: 'video',
          width: null,
          height: null,
          ext: 'mp4',
          hasAudio: true,
          source: 'threads-og',
          headers: headers(),
          filesize: null,
        }],
        audios: [],
      };
    }

    const err = new Error(targetCode
      ? `Threads post ${targetCode} was not found in crawler page data.`
      : 'Threads page had no identifiable public media post.');
    err.code = 'NO_MEDIA';
    throw err;
  }

  const result = { videos: [], images: [] };
  const carousel = Array.isArray(post.carousel_media) ? post.carousel_media : [];
  if (carousel.length) {
    carousel.forEach((item, index) => addMedia(item, result, index));
  } else {
    addMedia(post, result, 0);
  }

  if (!result.videos.length && !result.images.length) {
    const err = new Error(`Threads post ${post.code || targetCode || ''} has no downloadable public media.`);
    err.code = 'NO_MEDIA';
    throw err;
  }

  const caption = postCaption(post);
  const username = post?.user?.username || '';
  const title = (caption.split('\n')[0] || '').slice(0, 160)
    || (username ? `Video by ${username}` : 'Threads media');
  const thumbnail = bestImage(post)?.url || bestImage(carousel[0])?.url || '';

  return {
    platform: 'Threads',
    title,
    thumbnail,
    duration: null,
    images: result.images,
    videos: result.videos,
    audios: [],
  };
}
