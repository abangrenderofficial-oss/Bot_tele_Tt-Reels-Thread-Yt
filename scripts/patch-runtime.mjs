import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../src/downloader.js', import.meta.url);
let s = await readFile(file, 'utf8');

if (!s.includes("./youtube-free.js")) s = "import { parseYouTubeFree } from './youtube-free.js';\n" + s;
s = s.replace("'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',", "'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',");
s = s.replace("'--remote-components', 'ejs:github',\n      '--',", "'--remote-components', 'ejs:github',\n      '--extractor-args', 'youtube:player_client=tv_simply,web_embedded',\n      '--force-ipv4',\n      '--',");
s = s.replace('return parseYouTubeWithPiped(url).catch((fallbackError) => {', 'return parseYouTubeFree(url).catch((fallbackError) => {');
await writeFile(file, s);
console.log('Applied cloud extractor runtime patches');
