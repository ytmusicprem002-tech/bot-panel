// processManager.js
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const processes = new Map(); // name -> meta

function ensureDir(dir) {
  fs.ensureDirSync(dir);
}

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function startScript(name, scriptPath, logDir, opts = {}) {
  const sname = safeName(name);
  if (processes.has(sname)) throw new Error('Process already running');

  if (!fs.existsSync(scriptPath)) throw new Error('Script file not found');

  const outLog = path.join(logDir, `${sname}.log`);
  fs.ensureFileSync(outLog);
  const outStream = fs.createWriteStream(outLog, { flags: 'a' });

  // use node executable that runs the current process
  const nodeExec = process.execPath;

  // spawn node <scriptPath>
  const child = spawn(nodeExec, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, opts.env || {})
  });

  child.stdout.on('data', (d) => {
    outStream.write(`[OUT ${new Date().toISOString()}] ${d}`);
  });
  child.stderr.on('data', (d) => {
    outStream.write(`[ERR ${new Date().toISOString()}] ${d}`);
  });

  child.on('exit', (code, signal) => {
    outStream.write(`[EXIT ${new Date().toISOString()}] code=${code} signal=${signal}\n`);
    // if requested autoRestart, restart once after short delay
    const meta = processes.get(sname);
    processes.delete(sname);
    outStream.end();
    if (meta && meta.autoRestart && !meta.stoppedManually) {
      // spawn restart after small delay
      setTimeout(() => {
        try {
          startScript(name, scriptPath, logDir, opts);
        } catch (e) {
          // write error to log file
          fs.appendFileSync(outLog, `[RESTART-ERROR ${new Date().toISOString()}] ${e.message}\n`);
        }
      }, 1500);
    }
  });

  processes.set(sname, {
    child,
    outLog,
    pid: child.pid,
    startedAt: Date.now(),
    autoRestart: !!opts.autoRestart,
    stoppedManually: false
  });

  return processes.get(sname);
}

function stopScript(name) {
  const sname = safeName(name);
  const meta = processes.get(sname);
  if (!meta) throw new Error('Not running');
  meta.stoppedManually = true;
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
    arr.push({ name, pid: v.pid, startedAt: v.startedAt, autoRestart: v.autoRestart });
  }
  return arr;
}

function isRunning(name) {
  return processes.has(safeName(name));
}

module.exports = {
  ensureDir,
  startScript,
  stopScript,
  listRunning,
  isRunning,
  safeName
};
