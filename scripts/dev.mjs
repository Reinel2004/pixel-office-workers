// Starts the backend (API server, port 8787) and the frontend (the office, port 5173) together.
// Usage, from the top folder: npm run dev        Stop both with Ctrl+C.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['backend', 'frontend']) {
  if (!existsSync(join(root, dir, 'node_modules'))) {
    console.error(`${dir}/node_modules is missing. Run "npm run install:all" first.`);
    process.exit(1);
  }
}
if (!existsSync(join(root, 'backend', '.env'))) {
  console.warn('Note: backend/.env not found. Copy backend/.env.example to backend/.env for Connected Mode.');
}

const colors = { backend: '\x1b[35m', frontend: '\x1b[36m' };
const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // On Windows, kill the whole process tree (npm -> node); elsewhere a signal is enough.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(code);
}

for (const name of ['backend', 'frontend']) {
  const child = spawn('npm', ['run', 'dev'], { cwd: join(root, name), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${prefix}stopped (exit code ${code}). Stopping the other one too.`);
    stopAll(code ?? 1);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
