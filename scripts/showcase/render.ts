/**
 * Rewrites the README's "See it work" transcripts from the eval recordings:
 * `npm run readme:showcase`. Run it after re-recording (npm run eval -- --record);
 * tests/scripts/showcaseLib.test.ts fails until you do.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderShowcase, replaceSection } from './lib.js';

const before = readFileSync('README.md', 'utf8');
const after = replaceSection(before, renderShowcase());
writeFileSync('README.md', after);
console.log(after === before ? 'README.md already up to date' : 'README.md updated');
