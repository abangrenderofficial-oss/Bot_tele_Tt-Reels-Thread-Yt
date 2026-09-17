import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

source = source.replaceAll('video Gallery maksimum 250MB.', 'video Gallery maksimum 500MB.');
source = source.replaceAll('Worker 250MB belum aktif sepenuhnya.', 'Worker 500MB belum aktif sepenuhnya.');

await writeFile(apiFile, source);
console.log('Applied 500MB heavy-media limit copy patch');
