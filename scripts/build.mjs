import { context, build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  external: ['electron'],
  absWorkingDir: root
};

export const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'browser', format: 'cjs' },
  { ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' }
];

export async function copyStatic() {
  const target = path.join(dist, 'renderer', 'index.html');
  await mkdir(path.dirname(target), { recursive: true });
  /* readFile/writeFile, not cp: fs.cp with recursive:true unlinks the destination
     before writing it, and on a file that has never been copied that throws ENOENT. */
  await writeFile(target, await readFile(path.join(root, 'src', 'renderer', 'index.html')));
}

export function createWatchContexts(plugins = []) {
  return Promise.all(targets.map((t) => context({ ...t, plugins })));
}

export async function buildAll() {
  await rm(dist, { recursive: true, force: true });
  await Promise.all(targets.map((t) => build(t)));
  await copyStatic();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildAll();
  console.log('built ->', path.relative(root, dist));
}
