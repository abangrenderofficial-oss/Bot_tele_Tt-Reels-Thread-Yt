import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

function commandOptions(timeoutMs) {
  return {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
    },
  };
}

function sourceHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const allowed = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language']);
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.has(String(key).toLowerCase())) continue;
    if (typeof value !== 'string' || !value) continue;
    out[key] = value;
  }
  return out;
}

function safeExtension(item) {
  const ext = String(item?.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || 'jpg';
}

async function fetchWithHeaderTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 30000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function downloadRemoteImage(item, filePath) {
  if (!item?.url) {
    const err = new Error('Status HQ image source is missing.');
    err.code = 'STATUS_IMAGE_SOURCE_MISSING';
    throw err;
  }

  const response = await fetchWithHeaderTimeout(
    item.url,
    {
      method: 'GET',
      headers: sourceHeaders(item.headers),
      redirect: 'follow',
    },
    process.env.STATUS_IMAGE_SOURCE_HEADER_TIMEOUT_MS || 30000,
  );

  if (!response.ok || !response.body) {
    const err = new Error(`Status HQ image source returned HTTP ${response.status}.`);
    err.code = 'STATUS_IMAGE_FETCH_ERROR';
    throw err;
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(filePath));
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || !fileStat.size) {
    const err = new Error('Status HQ image source download is empty.');
    err.code = 'STATUS_IMAGE_SOURCE_EMPTY';
    throw err;
  }
}

async function cleanup(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => rm(filePath, { force: true }).catch(() => {})));
}

function premiumPlusImageFilter() {
  // Match the Premium+ HQ V2 preservation philosophy used for video:
  // no artificial denoise/sharpen pass, no upscaling, and pre-size the image
  // to a WhatsApp-friendly canvas so WhatsApp has less work to recompress.
  const squareish = 'lt(abs(iw-ih)/max(iw,ih),0.08)';
  const maxWidth = `if(${squareish},1280,if(gt(iw,ih),1280,720))`;
  const maxHeight = `if(${squareish},1280,if(gt(iw,ih),720,1280))`;
  const fit = `min(1,min(${maxWidth}/iw,${maxHeight}/ih))`;

  return [
    `scale=w='max(2,trunc(iw*${fit}/2)*2)':h='max(2,trunc(ih*${fit}/2)*2)':flags=lanczos`,
    'setsar=1',
    'format=yuvj420p',
  ].join(',');
}

export async function prepareWhatsAppStatusImageHQ({ image }) {
  const attemptId = randomUUID();
  const base = path.join(tmpdir(), `ar-status-image-${attemptId}`);
  const inputPath = `${base}-source.${safeExtension(image)}`;
  const outputPath = `${base}-premium-plus-hq.jpg`;
  const allPaths = [inputPath, outputPath];

  try {
    await downloadRemoteImage(image, inputPath);

    await execFileAsync(
      ffmpegPath,
      [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-nostats',
        '-nostdin',
        '-filter_threads', '1',
        '-i', inputPath,
        '-vf', premiumPlusImageFilter(),
        '-frames:v', '1',
        '-q:v', '2',
        '-threads', '1',
        '-map_metadata', '-1',
        outputPath,
      ],
      commandOptions(Number(process.env.STATUS_IMAGE_ENCODE_TIMEOUT_MS || 90000)),
    );

    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || !outputStat.size) {
      const err = new Error('Premium+ HQ image encoding completed without output.');
      err.code = 'STATUS_IMAGE_OUTPUT_MISSING';
      throw err;
    }

    await rm(inputPath, { force: true }).catch(() => {});

    return {
      filePath: outputPath,
      size: outputStat.size,
      quality: 'Premium+ HQ image • preservation V2 • 720×1280 / 1280×720 / 1280² max • JPEG q2 • Telegram-safe file',
      cleanup: async () => cleanup(allPaths),
    };
  } catch (error) {
    await cleanup(allPaths);
    throw error;
  }
}
