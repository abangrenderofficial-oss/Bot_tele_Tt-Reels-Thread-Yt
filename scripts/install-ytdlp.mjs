import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const targetDir = path.join(process.cwd(), 'bin');
const target = path.join(targetDir, 'yt-dlp');
const source = process.env.YTDLP_BINARY_URL || 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

await mkdir(targetDir, { recursive: true });

const response = await fetch(source, {
  redirect: 'follow',
  headers: { 'User-Agent': 'ARDownloader-build/1.0' },
});

if (!response.ok) {
  throw new Error(`Failed to download yt-dlp standalone binary: HTTP ${response.status}`);
}

const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.length < 1_000_000) {
  throw new Error(`yt-dlp binary looks too small (${bytes.length} bytes)`);
}

await writeFile(target, bytes);
await chmod(target, 0o755);
console.log(`Installed standalone yt-dlp (${bytes.length} bytes) -> ${target}`);
