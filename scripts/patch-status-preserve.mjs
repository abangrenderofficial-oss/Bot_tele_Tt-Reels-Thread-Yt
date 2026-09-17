import { readFile, writeFile } from 'node:fs/promises';

const statusFile = new URL('../src/status-hq.js', import.meta.url);
let source = await readFile(statusFile, 'utf8');

const oldFit = "  const fit = `min(${maxWidth}/(iw*${sar}),${maxHeight}/ih)`;";
const newFit = "  const fit = `min(1,min(${maxWidth}/(iw*${sar}),${maxHeight}/ih))`;";

if (source.includes(oldFit)) {
  source = source.replace(oldFit, newFit);
}

// Status HQ is preservation/transport optimization only: never upscale a
// smaller source and never add denoise, sharpen or enhancement filters.
await writeFile(statusFile, source);
console.log('Applied Status HQ preserve-only scaling patch');
