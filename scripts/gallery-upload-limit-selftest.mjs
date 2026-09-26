import { MAX_GALLERY_VIDEO_BYTES, isGalleryVideoTooLarge } from '../src/features/uploaded-media.js';

const MB = 1024 * 1024;
const cases = [
  { label: '199MB', size: 199 * MB, expected: false },
  { label: '200MB', size: 200 * MB, expected: false },
  { label: '200MB + 1 byte', size: (200 * MB) + 1, expected: true },
  { label: '201MB', size: 201 * MB, expected: true },
];

if (MAX_GALLERY_VIDEO_BYTES !== 200 * MB) throw new Error('Gallery limit is not exactly 200 MiB');
for (const test of cases) {
  const actual = isGalleryVideoTooLarge(test.size);
  console.log(`${test.label}: ${actual ? 'REJECT' : 'ACCEPT'}`);
  if (actual !== test.expected) throw new Error(`Boundary failed: ${test.label}`);
}
console.log('Gallery 200MB boundary self-test passed.');
