import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../src/downloader.js', import.meta.url);
let s = await readFile(file, 'utf8');

s = s.replace(
  "'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',",
  "'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',"
);

s = s.replace(
  "'--remote-components', 'ejs:github',\n      '--',",
  "'--remote-components', 'ejs:github',\n      '--extractor-args', 'youtube:player_client=tv,web_safari',\n      '--force-ipv4',\n      '--',"
);

// Public Piped nodes change frequently. Keep several currently healthy no-login fallbacks.
s = s.replace(
  /const PIPED_INSTANCES = \[[\s\S]*?\];/,
  `const PIPED_INSTANCES = [\n  'https://piped-api.lunar.icu',\n  'https://yapi.vyper.me',\n  'https://api.looleh.xyz',\n  'https://api.piped.yt',\n  'https://pipedapi.drgns.space',\n  'https://api.piped.minionflo.net',\n  'https://api.piped.private.coffee',\n  'https://pipedapi-libre.kavin.rocks',\n];`
);

await writeFile(file, s);
console.log('Applied cloud extractor runtime patches');
