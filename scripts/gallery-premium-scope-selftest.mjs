import fs from 'node:fs';

const feature = fs.readFileSync('src/features/status-hq.js', 'utf8');
const workflow = fs.readFileSync('.github/workflows/heavy-status-hq.yml', 'utf8');
const worker = fs.readFileSync('scripts/heavy_status_worker.py', 'utf8');
const socialStatus = fs.readFileSync('src/status-hq.js', 'utf8');

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

requireText(feature, "sourceKind: 'gallery'", 'gallery dispatch');
requireText(workflow, 'HEAVY_SOURCE_KIND: ${{ inputs.source_kind }}', 'worker source kind');
requireText(workflow, 'if [ "$HEAVY_SOURCE_KIND" = "gallery" ]; then', 'gallery-only condition');
requireText(workflow, "needle = \"'-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',\"", 'gallery patch source');
requireText(workflow, "replacement = \"'-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',\"", 'gallery patch target');
requireText(worker, "'-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',", 'base Premium+ worker must stay Main10');

if (socialStatus.includes('HEAVY_SOURCE_KIND') || socialStatus.includes('gallery compatibility')) {
  throw new Error('Social-link Premium+ pipeline was contaminated by gallery compatibility logic');
}

console.log('Premium+ HQ gallery isolation self-test passed.');
console.log('Gallery heavy job: HEVC 8-bit runtime patch.');
console.log('Base/social Premium+ preset: HEVC Main10 remains unchanged.');
