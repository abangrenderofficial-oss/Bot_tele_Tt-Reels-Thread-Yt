import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(absolute);
  }
  return out;
}

function fail(message) {
  console.error(`ARCHITECTURE_CHECK_FAILED: ${message}`);
  process.exitCode = 1;
}

async function assertRelativeImportsResolve(file, source) {
  const importPattern = /(?:import\s+(?:[^'\"]+?\s+from\s+)?|export\s+[^'\"]+?\s+from\s+)['\"]([^'\"]+)['\"]/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(file), specifier);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) fail(`${path.relative(root, file)} imports non-file ${specifier}`);
    } catch {
      fail(`${path.relative(root, file)} has missing relative import ${specifier}`);
    }
  }
}

const productionFiles = [
  path.join(root, 'server.js'),
  ...await walk(path.join(root, 'api')),
  ...await walk(path.join(root, 'src')),
];

for (const file of productionFiles) {
  try {
    await execFileAsync(process.execPath, ['--check', file]);
  } catch (error) {
    fail(`syntax error in ${path.relative(root, file)}: ${String(error?.stderr || error?.message || error)}`);
    continue;
  }
  const source = await readFile(file, 'utf8');
  await assertRelativeImportsResolve(file, source);
}

const routerPath = path.join(root, 'api', 'telegram.js');
const router = await readFile(routerPath, 'utf8');
const forbiddenRouterTokens = [
  "node:child_process",
  "ffmpeg-static",
  "../src/status-hq.js",
  "../src/status-image-hq.js",
  "../src/social-video.js",
  "../src/tiktok-rescue.js",
  "../src/downloader.js",
  "../src/live-wallpaper.js",
];
for (const token of forbiddenRouterTokens) {
  if (router.includes(token)) fail(`api/telegram.js directly depends on heavy implementation: ${token}`);
}
if (router.split(/\r?\n/).length > 260) {
  fail(`api/telegram.js grew beyond thin-router limit (${router.split(/\r?\n/).length} lines)`);
}

const featureDir = path.join(root, 'src', 'features');
for (const file of await walk(featureDir)) {
  const source = await readFile(file, 'utf8');
  if (/from ['\"]\.\/[^'\"]+['\"]/.test(source)) {
    fail(`${path.relative(root, file)} imports another feature module directly`);
  }
}

const live = await readFile(path.join(featureDir, 'live-wallpaper.js'), 'utf8');
if (live.includes('../live-wallpaper.js')) {
  fail('Live Wallpaper route must stay on external Apple worker, not local FFmpeg implementation');
}
if (!live.includes('dispatchHeavyMediaJob')) {
  fail('Live Wallpaper route is missing external-worker dispatch');
}

const status = await readFile(path.join(featureDir, 'status-hq.js'), 'utf8');
if (!status.includes('localMediaLane')) fail('Status HQ local processing is missing isolated local-media lane');

const downloader = await readFile(path.join(featureDir, 'downloader.js'), 'utf8');
if (!downloader.includes('localMediaLane')) fail('Downloader compression/rescue is missing isolated local-media lane');

const packageJson = await readFile(path.join(root, 'package.json'), 'utf8');
if (packageJson.includes('runtime-patch') || packageJson.includes('patch-runtime')) {
  fail('package.json still executes legacy runtime patch chain');
}
if (!packageJson.includes('check-feature-boundaries.mjs')) {
  fail('package.json is not enforcing the architecture guard');
}

const statusCore = await readFile(path.join(root, 'src', 'status-hq.js'), 'utf8');
const envBoundedThreads = statusCore.includes('STATUS_FFMPEG_THREADS') && statusCore.includes('STATUS_FILTER_THREADS');
const hardBoundedPremiumV2Threads = statusCore.includes("'-filter_threads', String(plan.filterThreads ?? 1)")
  && statusCore.includes("'-x265-params', 'pools=1:frame-threads=1");
if (!envBoundedThreads && !hardBoundedPremiumV2Threads) {
  fail('Status HQ is missing bounded FFmpeg thread configuration');
}
if (!statusCore.includes('fetchWithHeaderTimeout')) {
  fail('Status HQ source fetch is missing header-only timeout protection');
}

const relay = await readFile(path.join(root, 'api', 'media.js'), 'utf8');
if (relay.includes('AbortSignal.timeout(45000)')) {
  fail('Relay still has whole-stream 45s abort timeout');
}
if (!relay.includes('MEDIA_RELAY_HEADER_TIMEOUT_MS')) {
  fail('Relay is missing isolated header timeout');
}

if (!process.exitCode) {
  console.log(`Architecture check passed: ${productionFiles.length} production JS files verified.`);
}
