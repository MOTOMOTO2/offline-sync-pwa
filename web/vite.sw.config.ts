import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, type UserConfig } from 'vite';

/**
 * Second build pass: the service worker.
 *
 * It runs after the app build (see the `build` script) so it can read the real
 * hashed filenames out of dist/ and bake them into the worker as a precache
 * list. That is what makes a cold, fully offline launch work: the app shell is
 * already in the cache before the first offline load happens.
 *
 * It is emitted as a classic (iife) worker rather than an ES module because
 * module service workers are still not supported everywhere.
 */

const DIST = 'dist';

/** Files without which the app cannot boot at all. */
function corePrecacheUrls(): string[] {
  const urls = new Set<string>(['/', '/index.html']);
  for (const file of listFiles(join(DIST, 'assets'))) {
    // Source maps are for debugging, not for offline booting.
    if (file.endsWith('.js') || file.endsWith('.css')) urls.add('/assets/' + file);
  }
  return [...urls];
}

/** Nice to have offline, but a failure to fetch one must not break install. */
function optionalPrecacheUrls(): string[] {
  const urls = new Set<string>(['/manifest.webmanifest', '/runtime-config.js']);
  for (const file of listFiles(join(DIST, 'icons'))) urls.add('/icons/' + file);
  return [...urls];
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name: string) => statSync(join(dir, name)).isFile());
}

export default defineConfig(() => {
  const core = corePrecacheUrls();
  const optional = optionalPrecacheUrls();

  if (core.length <= 2) {
    console.warn('[sw build] dist/assets is empty — run `vite build` first for a precached shell.');
  }

  // Changes whenever any shell file changes, which is exactly when old caches
  // should be dropped.
  const buildId = createHash('sha256').update([...core, ...optional].sort().join('|')).digest('hex').slice(0, 12);

  console.log(`[sw build] build ${buildId}: ${core.length} core + ${optional.length} optional files`);

  const config: UserConfig = {
    publicDir: false,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __PRECACHE_CORE__: JSON.stringify(core),
      __PRECACHE_OPTIONAL__: JSON.stringify(optional),
    },
    build: {
      target: 'es2022',
      outDir: DIST,
      emptyOutDir: false,
      sourcemap: false,
      copyPublicDir: false,
      rollupOptions: {
        input: 'src/sw.ts',
        output: {
          format: 'iife',
          entryFileNames: 'sw.js',
          inlineDynamicImports: true,
        },
      },
    },
  };
  return config;
});
