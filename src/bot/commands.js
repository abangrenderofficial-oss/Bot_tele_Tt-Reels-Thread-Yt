import { isResetAdmin } from '../recovery.js';

export const START_TEXT = [
  '📥 Social Downloader Bot',
  '',
  'Hantar link public daripada:',
  '• TikTok',
  '• Instagram Reels / Post',
  '• Threads',
  '• YouTube / Shorts / unlisted',
  '',
  'Bot akan cuba hantar semula media dalam chat dan user boleh download.',
  '',
  'Boleh juga upload media video atau photo dari gallery untuk:',
  '• 📱 Status HQ',
  '• 🍎 Live Wallpaper iPhone',
  '',
  '❤️ Nak support bot & kos server?',
  'Tekan /support untuk pilih amount dan terus ke payment.',
].join('\n');

export function commandMenuText(userId) {
  const lines = [
    '📋 Command Menu',
    '',
    '/start — Info bot',
    '/help — Bantuan ringkas',
    '/menu — Senarai command',
    '/status <link> — Buat Status HQ dari link',
    '/support — ❤️ Support bot',
    '/reset — Reset sesi sendiri jika bot tersangkut',
  ];

  if (isResetAdmin(userId)) {
    lines.push(
      '',
      '👑 Owner',
      '/resetadmin — Reset & recovery semua user',
      '/connect — Sambung group pemantauan',
      '/disconnect — Putus group pemantauan',
      '/totaluser — Statistik penggunaan bot',
    );
  }
  return lines.join('\n');
}
