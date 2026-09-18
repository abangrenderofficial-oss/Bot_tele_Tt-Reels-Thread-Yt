import { telegram } from '../telegram.js';

export async function statusVideoCaption() {
  try {
    const me = await telegram('getMe');
    const username = String(me?.username || '').trim().replace(/^@+/, '');
    if (username) {
      return `Video Ready For Status ✅\nDownload In @${username}`;
    }
  } catch (error) {
    console.warn('[status-caption] getMe failed:', error?.message);
  }

  return 'Video Ready For Status ✅';
}
