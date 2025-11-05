// processManager.js
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const processes = new Map();

function ensureDir(dir) {
  fs.ensureDirSync(dir);
}

function startScript(name, scriptPath, logDir) {
  if (processes.has(name)) throw new Error('Process already running');

  const safeName = name.replace(/[^\w.-]/g, '_');
  const outLog = path.join(logDir, `${safeName}.log`);
  fs.ensureFileSync(outLog);
  const outStream = fs.createWriteStream(outLog, { flags: 'a' });

  const child = spawn(process.execPath, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env)
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

function stopScript(name) {
  const meta = processes.get(name);
  if (!meta) throw new Error('Not running');
  try {
    meta.child.kill('SIGTERM');
  } catch (e) {
    try { meta.child.kill(); } catch (ee) {}
  }
  return true;
}

function listRunning() {
  const arr = [];
  for (const [name, v] of processes.entries()) {
    arr.push({ name, pid: v.pid, startedAt: v.startedAt });
  }
  return arr;
}

function isRunning(name) {
  return processes.has(name);
}

module.exports = {
  ensureDir,
  startScript,
  stopScript,
  listRunning,
  isRunning
};
