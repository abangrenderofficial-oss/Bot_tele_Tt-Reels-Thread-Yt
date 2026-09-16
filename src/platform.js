const PLATFORM_RULES = [
  { platform: 'tiktok', hosts: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'] },
  { platform: 'instagram', hosts: ['instagram.com', 'www.instagram.com'] },
  { platform: 'threads', hosts: ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'] },
  { platform: 'youtube', hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'] },
];

export function extractFirstUrl(text = '') {
  const match = text.match(/https?:\/\/[^\s<>()]+/i);
  if (!match) return null;
  return match[0].replace(/[),.!?]+$/, '');
}

export function detectPlatform(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return PLATFORM_RULES.find((entry) => entry.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)))?.platform ?? null;
  } catch {
    return null;
  }
}

export function platformLabel(platform) {
  return {
    tiktok: 'TikTok',
    instagram: 'Instagram',
    threads: 'Threads',
    youtube: 'YouTube',
  }[platform] ?? 'Media';
}
