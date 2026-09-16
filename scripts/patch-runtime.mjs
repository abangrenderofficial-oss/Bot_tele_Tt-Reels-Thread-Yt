import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../src/downloader.js', import.meta.url);
let s = await readFile(file, 'utf8');

// Threads exposes full public post JSON to link-preview crawlers, not ordinary anonymous browsers.
s = s.replace(
  "'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',",
  "'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',"
);

// Cloud IPs are frequently challenged by YouTube's default clients. Try TV/Safari clients first.
s = s.replace(
  "'--remote-components', 'ejs:github',\n      '--',",
  "'--remote-components', 'ejs:github',\n      '--extractor-args', 'youtube:player_client=tv,web_safari',\n      '--force-ipv4',\n      '--',"
);

await writeFile(file, s);
console.log('Applied cloud extractor runtime patches');
