import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWatchContexts, copyStatic } from './build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronBin = createRequire(import.meta.url)('electron');

let child = null;
let started = false;

function restart() {
  if (child && !child.killed) child.kill();
  child = spawn(electronBin, [path.join(root, 'dist', 'main.js')], { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => {
    if (code !== null && code !== 0 && started) console.error(`\nTalos exited with code ${code}`);
  });
}

const restartOnRebuild = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return console.error('build failed, not relaunching');
      copyStatic();
      started = true;
      restart();
    });
  }
};

const contexts = await createWatchContexts([restartOnRebuild]);
await Promise.all(contexts.map((c) => c.watch()));
console.log('watching src/ — Talos relaunches on every change (Ctrl+C to stop)\n');

process.on('SIGINT', async () => {
  if (child) child.kill();
  await Promise.all(contexts.map((c) => c.dispose()));
  process.exit(0);
});
