import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

const processes = new Map();

export function ensureDir(dir) {
  fs.ensureDirSync(dir);
}

export function startScript(name, scriptPath, logDir) {
  if (processes.has(name)) throw new Error('Process already running');

  const outLog = path.join(logDir, `${name}.log`);
  const outStream = fs.createWriteStream(outLog, { flags: 'a' });

  const child = spawn('node', [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  child.stdout.on('data', (d) => outStream.write(`[OUT ${new Date().toISOString()}] ${d}`));
  child.stderr.on('data', (d) => outStream.write(`[ERR ${new Date().toISOString()}] ${d}`));

  child.on('exit', (code) => {
    outStream.write(`[EXIT ${new Date().toISOString()}] code=${code}\n`);
    processes.delete(name);
    outStream.end();
  });

  processes.set(name, { child, outLog, pid: child.pid, startedAt: Date.now() });
  return processes.get(name);
}

export function stopScript(name) {
  const meta = processes.get(name);
  if (!meta) throw new Error('Not running');
  meta.child.kill('SIGTERM');
  return true;
}

export function listRunning() {
  const arr = [];
  for (const [name, v] of processes.entries()) {
    arr.push({ name, pid: v.pid, startedAt: v.startedAt });
  }
  return arr;
}

export function isRunning(name) {
  return processes.has(name);
}
