import { readFile, writeFile } from 'node:fs/promises';

const downloaderFile = new URL('../src/downloader.js', import.meta.url);
let source = await readFile(downloaderFile, 'utf8');

if (!source.includes('TikWM POST fallback')) {
  const marker = `  if (payload?.code !== 0 || !payload?.data) {\n    const err = new Error(payload?.msg || 'TikWM could not resolve this TikTok link.');`;
  if (!source.includes(marker)) {
    throw new Error('patch-tikwm-post-fallback: TikWM payload validation marker not found');
  }

  const replacement = `  // TikWM POST fallback: their short-link parser can intermittently reject vt/vm links\n  // on the query-string endpoint while accepting the same URL as form data.\n  if (payload?.code !== 0 || !payload?.data) {\n    try {\n      const form = new URLSearchParams();\n      form.set('url', url);\n      form.set('hd', '1');\n      const postResponse = await fetch(TIKWM_API, {\n        method: 'POST',\n        headers: {\n          Accept: 'application/json',\n          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',\n          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',\n          Referer: 'https://www.tikwm.com/',\n          Origin: 'https://www.tikwm.com',\n        },\n        body: form.toString(),\n        signal: AbortSignal.timeout(Number(process.env.DOWNLOADER_TIMEOUT_MS || 25000)),\n      });\n      if (postResponse.ok) {\n        const postPayload = await postResponse.json().catch(() => null);\n        if (postPayload?.code === 0 && postPayload?.data) payload = postPayload;\n      }\n    } catch (postError) {\n      console.warn('TikWM POST fallback failed:', postError?.message || postError);\n    }\n  }\n\n  if (payload?.code !== 0 || !payload?.data) {\n    const err = new Error(payload?.msg || 'TikWM could not resolve this TikTok link.');`;

  source = source.replace(marker, replacement);
}

await writeFile(downloaderFile, source);
console.log('Applied TikWM POST fallback for short-link resolution');
