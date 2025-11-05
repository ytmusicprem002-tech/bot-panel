const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const running = {};

function ensureDir(dir) {
  fs.ensureDirSync(dir);
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function startScript(name, scriptPath, logDir, { autoRestart = false } = {}) {
  if (running[name]) return running[name];

  const logFile = path.join(logDir, `${safeName(name)}.log`);
  const out = fs.createWriteStream(logFile, { flags: 'a' });

  const child = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);

  const meta = { pid: child.pid, child, autoRestart, path: scriptPath, log: logFile };
  running[name] = meta;

  child.on('exit', (code) => {
    delete running[name];
    if (autoRestart) startScript(name, scriptPath, logDir, { autoRestart });
  });

  return meta;
}

function stopScript(name) {
  if (running[name]) {
    try {
      running[name].child.kill();
    } catch {}
    delete running[name];
  }
}

function listRunning() {
  return Object.keys(running);
}

function isRunning(name) {
  return !!running[name];
}

module.exports = { ensureDir, startScript, stopScript, listRunning, isRunning, safeName };
