import fs from 'node:fs';

const feature = fs.readFileSync('src/features/status-hq.js', 'utf8');
const workflow = fs.readFileSync('.github/workflows/heavy-status-hq.yml', 'utf8');
const worker = fs.readFileSync('scripts/heavy_status_worker.py', 'utf8');
const socialStatus = fs.readFileSync('src/status-hq.js', 'utf8');

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

requireText(feature, "sourceKind: 'gallery'", 'gallery heavy dispatch');
requireText(feature, 'galleryCompatible: Boolean(gallery)', 'local gallery compatibility flag');
requireText(workflow, 'HEAVY_SOURCE_KIND: ${{ inputs.source_kind }}', 'worker source kind');
requireText(workflow, 'if [ "$HEAVY_SOURCE_KIND" = "gallery" ]; then', 'gallery-only heavy condition');
requireText(workflow, "replacement = \"'-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',\"", 'gallery heavy patch target');
requireText(worker, "'-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',", 'base heavy Premium+ remains Main10');
requireText(socialStatus, 'galleryCompatible = false', 'default Premium+ mode remains social Main10');
requireText(socialStatus, "const pixelFormat = galleryCompatible ? 'yuv420p' : 'yuv420p10le';", 'local gallery pixel-format switch');
requireText(socialStatus, "pixelFormat = 'yuv420p10le'", 'encoder default remains Main10');

const socialHelperStart = feature.indexOf('async function prepareStatusFromSourceUrl');
const socialHelperEnd = feature.indexOf('export async function processStatusFromLink');
if (socialHelperStart < 0 || socialHelperEnd <= socialHelperStart) {
  throw new Error('Could not isolate social Premium+ helper for verification');
}
const socialHelper = feature.slice(socialHelperStart, socialHelperEnd);
if (socialHelper.includes('galleryCompatible')) {
  throw new Error('Social-link Premium+ helper must not enable gallery compatibility mode');
}

const galleryCall = feature.indexOf('galleryCompatible: Boolean(gallery)');
if (galleryCall < 0) throw new Error('Gallery local Premium+ compatibility call missing');

console.log('Premium+ HQ gallery isolation self-test passed.');
console.log('Gallery local + heavy: HEVC 8-bit yuv420p.');
console.log('Social-link/default Premium+: HEVC Main10 unchanged.');
