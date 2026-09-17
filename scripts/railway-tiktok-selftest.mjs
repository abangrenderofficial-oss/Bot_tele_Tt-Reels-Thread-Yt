import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { sendVideoUpload, sendVideoUrl } from '../src/telegram.js';

const TEST_URL = 'https://vt.tiktok.com/ZSqsKvFLE';
const chatId = String(process.env.BOT_OWNER_ID || '').trim();
if (!chatId) throw new Error('BOT_OWNER_ID is required for TikTok self-test');

const media = await parseMedia(TEST_URL);
const pool = (media.videos || []).filter((item) => item?.url);
const ordered = [];
while (pool.length) {
  const best = chooseBestVideo(pool);
  if (!best) break;
  ordered.push(best);
  pool.splice(pool.indexOf(best), 1);
}
if (!ordered.length) throw new Error('TikTok self-test resolved no video candidates');

let lastError = null;
for (const candidate of ordered) {
  console.log(`SELFTEST candidate: ${candidate.quality || 'video'}`);
  try {
    // Try Telegram URL ingestion first, matching normal delivery behavior.
    await sendVideoUrl(chatId, candidate.url, '✅ Railway TikTok self-test berjaya');
    console.log(`SELFTEST SUCCESS via URL: ${candidate.quality || 'video'}`);
    process.exit(0);
  } catch (error) {
    console.warn(`SELFTEST URL failed (${candidate.quality || 'video'}): ${error?.message || error}`);
    lastError = error;
  }

  try {
    // Then stream through Railway and upload to Telegram.
    await sendVideoUpload(chatId, candidate, '✅ Railway TikTok self-test berjaya');
    console.log(`SELFTEST SUCCESS via server upload: ${candidate.quality || 'video'}`);
    process.exit(0);
  } catch (error) {
    console.warn(`SELFTEST upload failed (${candidate.quality || 'video'}): ${error?.code || ''} ${error?.message || error}`);
    lastError = error;
  }
}

throw new Error(`TikTok self-test exhausted all candidates: ${lastError?.message || lastError || 'unknown error'}`);
