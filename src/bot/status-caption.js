import { telegram } from '../telegram.js';

async function currentBotUsername() {
  try {
    const me = await telegram('getMe');
    return String(me?.username || '').trim().replace(/^@+/, '');
  } catch (error) {
    console.warn('[status-caption] getMe failed:', error?.message);
    return '';
  }
}

async function buildStatusCaption(title) {
  const username = await currentBotUsername();
  return username ? `${title}\nDownload In @${username}` : title;
}

export function statusVideoCaption() {
  return buildStatusCaption('Video Ready For Status ✅');
}

export function statusAndroidVideoCaption() {
  return buildStatusCaption('Video Ready For Android Status ✅');
}
