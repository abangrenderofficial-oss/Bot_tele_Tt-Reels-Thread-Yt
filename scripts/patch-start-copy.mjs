import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

const replacement = `const START_TEXT = [
  '📥 Social Downloader Bot',
  '',
  'Hantar link public daripada:',
  '• TikTok',
  '• Instagram Reels / Post',
  '• Threads',
  '• YouTube / Shorts / unlisted',
  '',
  'Bot akan cuba hantar media terus dalam chat.',
  '',
  'Boleh juga upload media dari gallery untuk:',
  '• 📱 Status HQ',
  '• 🍎 Live Wallpaper iPhone',
].join('\\n');`;

const pattern = /const START_TEXT = \[[\s\S]*?\]\.join\('\\n'\);/;
if (!pattern.test(source)) {
  throw new Error('START_TEXT block not found.');
}

source = source.replace(pattern, replacement);
await writeFile(apiFile, source);
console.log('Applied current /start and /help copy');
