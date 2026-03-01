import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watchMode = process.argv.includes('--watch');

function copyAssets() {
  fs.mkdirSync('dist', { recursive: true });
  fs.copyFileSync(path.join('src', 'popup', 'index.html'), path.join('dist', 'popup.html'));
  fs.copyFileSync(path.join('src', 'popup', 'styles.css'), path.join('dist', 'styles.css'));
}

const copyAssetsPlugin = {
  name: 'copy-assets',
  setup(buildApi) {
    buildApi.onEnd(() => {
      copyAssets();
    });
  }
};

const buildOptions = {
  entryPoints: {
    content: path.join('src', 'content', 'index.ts'),
    popup: path.join('src', 'popup', 'index.ts')
  },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: watchMode,
  plugins: [copyAssetsPlugin]
};

async function run() {
  if (watchMode) {
    const ctx = await context(buildOptions);
    await ctx.watch();
    copyAssets();
    console.log('watch mode started');
    return;
  }

  await build(buildOptions);
  copyAssets();
  console.log('build complete');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
