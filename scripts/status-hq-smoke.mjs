import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const url = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';
console.log('STATUS_TEST_URL', url);

const media = await parseMedia(url);
console.log('platform', media?.platform, 'duration', media?.duration, 'videos', media?.videos?.length || 0);
const best = chooseBestVideo(media?.videos || []);
if (!best) throw new Error('No video candidate resolved');
console.log('best', { quality: best.quality, ext: best.ext, filesize: best.filesize, duration: best.duration });

let prepared;
try {
  prepared = await prepareWhatsAppStatusHQ({ sourceUrl: url, platform: 'tiktok', video: best });
  console.log('prepared', prepared.quality, 'clips', prepared.clips.length, 'profile', prepared.profile?.mode);
  for (const clip of prepared.clips) {
    console.log('clip', clip.index, clip.count, clip.duration, clip.size, clip.filePath);
  }
} finally {
  if (prepared?.cleanup) await prepared.cleanup();
}
