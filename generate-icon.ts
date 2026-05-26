/**
 * Converts icon.svg → icon.png (128×128) using @resvg/resvg-js.
 * Run with: bun generate-icon.ts
 */
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';

const svg = readFileSync('./icon.svg', 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 128 },
});
const png = resvg.render().asPng();
writeFileSync('./icon.png', png);
console.log('Generated icon.png (128×128)');
