import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const execFileAsync = promisify(execFile);
const savedLink = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';
const controlLink = process.env.STATUS_CONTROL_URL || 'https://vt.tiktok.com/ZSqqYxc13/';
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkSavedLink(url) {
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': ua, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(15000),
    });
    const loc = r.headers.get('location') || '';
    console.log('SAVED_LINK_REDIRECT', r.status, loc || '(none)');
    try { await r.body?.cancel(); } catch {}
    if (/\/video\/\d+/i.test(loc)) return { alive: true, canonical: new URL(loc, url).toString() };
    if (/^https:\/\/www\.tiktok\.com\/?\?_r=1/i.test(loc)) return { alive: false, reason: 'expired_or_removed_shortlink' };
  } catch (e) {
    console.log('SAVED_LINK_CHECK_ERROR', String(e?.message || e));
  }
  return { alive: true, canonical: url };
}

async function parseWithRetry(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const media = await parseMedia(url);
      console.log('PARSE_ATTEMPT_OK', label, attempt);
      return media;
    } catch (error) {
      lastError = error;
      console.log('PARSE_ATTEMPT_FAIL', label, attempt, error?.code, String(error?.message || error).slice(0, 500));
      if (attempt < 6) await sleep(attempt * 2500);
    }
  }
  throw lastError;
}

async function probeDimensions(filePath) {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    stderr = String(error?.stderr || error?.message || '');
  }
  const match = stderr.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
}

function assertRatioPreserved(source, output) {
  if (!source?.width || !source?.height || !output?.width || !output?.height) return;
  const sourceRatio = source.width / source.height;
  const outputRatio = output.width / output.height;
  const diff = Math.abs(outputRatio - sourceRatio) / sourceRatio;
  console.log('RATIO_CHECK', 'source=', sourceRatio.toFixed(6), 'output=', outputRatio.toFixed(6), 'diff=', diff.toFixed(6));
  if (diff > 0.02) throw new Error(`aspect ratio changed too much: ${diff}`);
}

async function runStatus(url, label) {
  console.log('RUN_STATUS', label, url);
  const media = await parseWithRetry(url, label);
  console.log('MEDIA_OK', label, media?.platform, 'duration=', media?.duration, 'videos=', media?.videos?.length || 0);
  const best = chooseBestVideo(media?.videos || []);
  if (!best) throw new Error(`${label}: no video candidate`);
  console.log('BEST_OK', label, best.quality, best.width, best.height, new URL(best.url).host);

  let prepared;
  try {
    prepared = await prepareWhatsAppStatusHQ({ sourceUrl: url, platform: 'tiktok', video: best });
    if (!prepared?.filePath || !prepared?.size) throw new Error(`${label}: invalid single-file output`);

    const fileStat = await stat(prepared.filePath);
    if (!fileStat.isFile() || !fileStat.size) throw new Error(`${label}: generated output is empty`);
    if (fileStat.size !== prepared.size) throw new Error(`${label}: output size metadata mismatch`);

    const output = await probeDimensions(prepared.filePath);
    assertRatioPreserved(prepared.source, output);

    console.log(
      'STATUS_HQ_OK',
      label,
      prepared.quality,
      'single=true',
      'bytes=', prepared.size,
      'attempt=', prepared.attempt,
      'source=', `${prepared.source?.width || '?'}x${prepared.source?.height || '?'}`,
      'output=', `${output.width || '?'}x${output.height || '?'}`,
      'videoKbps=', prepared.profile?.videoKbps,
    );
    return true;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup();
  }
}

console.log('SAVED_LINK', savedLink);
const saved = await checkSavedLink(savedLink);
if (saved.alive) {
  await runStatus(saved.canonical || savedLink, 'saved-link');
} else {
  console.log('SAVED_LINK_DEAD', saved.reason);
  console.log('CONTROL_LINK', controlLink);
  await runStatus(controlLink, 'control-link');
}
