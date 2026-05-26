import { build } from 'bun';

console.log('Compiling VS Code extension...');

const result = await build({
  entrypoints: ['./src/extension.ts'],
  outdir: './dist',
  target: 'node',
  external: ['vscode'],
  format: 'cjs', // CommonJS target for VS Code extension execution
  minify: false,
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log('Successfully compiled extension to dist/extension.js!');
