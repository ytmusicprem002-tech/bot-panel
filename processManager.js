// processManager.js
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const processes = new Map(); // key -> meta { child, pid, startedAt, kind, name, cwd, cmd, outLog, autoRestart, stoppedManually }

function ensureDir(dir) {
  fs.ensureDirSync(dir);
}

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Start a single-file script: node <scriptPath>
function startScript(name, scriptPath, logDir, opts = {}) {
  const key = `script:${safeName(name)}`;
  if (processes.has(key)) throw new Error('Process already running');

  fs.ensureDirSync(logDir);
  const outLog = path.join(logDir, `${safeName(name)}.log`);
  const outStream = fs.createWriteStream(outLog, { flags: 'a' });

  const nodeExec = process.execPath || 'node';
  const child = spawn(nodeExec, [scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, opts.env || {})
  });

  child.stdout.on('data', d => outStream.write(`[OUT ${new Date().toISOString()}] ${d}`));
  child.stderr.on('data', d => outStream.write(`[ERR ${new Date().toISOString()}] ${d}`));

  child.on('exit', (code, signal) => {
    outStream.write(`[EXIT ${new Date().toISOString()}] code=${code} signal=${signal}\n`);
    outStream.end();
    const meta = processes.get(key);
    processes.delete(key);
    if (meta && meta.autoRestart && !meta.stoppedManually) {
      // simple backoff
      setTimeout(() => {
        try {
          startScript(name, scriptPath, logDir, opts);
        } catch (e) {
          fs.appendFileSync(outLog, `[RESTART-ERROR ${new Date().toISOString()}] ${e.message}\n`);
        }
      }, 2000);
    }
  });

  const meta = { child, pid: child.pid, startedAt: Date.now(), kind: 'script', name, cwd: path.dirname(scriptPath), cmd: `node ${scriptPath}`, outLog, autoRestart: !!opts.autoRestart, stoppedManually: false };
  processes.set(key, meta);
  return meta;
}

function stopScript(name) {
  const key = `script:${safeName(name)}`;
  const meta = processes.get(key);
  if (!meta) throw new Error('Not running');
  meta.stoppedManually = true;
  try { meta.child.kill('SIGTERM'); } catch (e) { try { meta.child.kill(); } catch(_) {} }
  return true;
}

// Start a project with arbitrary command (shell): e.g. "npm start" or "node src/index.js"
function startProject(name, command, cwd, logDir, opts = {}) {
  const key = `project:${safeName(name)}`;
  if (processes.has(key)) throw new Error('Project already running');

  fs.ensureDirSync(logDir);
  const outLog = path.join(logDir, `${safeName(name)}.log`);
  const outStream = fs.createWriteStream(outLog, { flags: 'a' });

  const child = spawn(command, { shell: true, cwd, env: Object.assign({}, process.env, opts.env || {}), stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', d => outStream.write(`[OUT ${new Date().toISOString()}] ${d}`));
  child.stderr.on('data', d => outStream.write(`[ERR ${new Date().toISOString()}] ${d}`));

  child.on('exit', (code, signal) => {
    outStream.write(`[EXIT ${new Date().toISOString()}] code=${code} signal=${signal}\n`);
    outStream.end();
    const meta = processes.get(key);
    processes.delete(key);
    if (meta && meta.autoRestart && !meta.stoppedManually && code !== 0) {
      setTimeout(() => {
        try { startProject(name, command, cwd, logDir, opts); } catch (e) { fs.appendFileSync(outLog, `[RESTART-ERROR ${new Date().toISOString()}] ${e.message}\n`); }
      }, 2000);
    }
  });

  const meta = { child, pid: child.pid, startedAt: Date.now(), kind: 'project', name, cwd, cmd: command, outLog, autoRestart: !!opts.autoRestart, stoppedManually: false };
  processes.set(key, meta);
  return meta;
}

function stopProject(name) {
  const key = `project:${safeName(name)}`;
  const meta = processes.get(key);
  if (!meta) throw new Error('Not running');
  meta.stoppedManually = true;
  try { meta.child.kill('SIGTERM'); } catch (e) { try { meta.child.kill(); } catch(_) {} }
  return true;
}

function listRunning() {
  const arr = [];
  for (const [k, v] of processes.entries()) {
    arr.push({ key: k, name: v.name, kind: v.kind, pid: v.pid, startedAt: v.startedAt, cmd: v.cmd, cwd: v.cwd });
  }
  return arr;
}

function isRunning(name, kind = 'script') {
  const key = `${kind}:${safeName(name)}`;
  return processes.has(key);
}

module.exports = {
  ensureDir,
  safeName,
  startScript,
  stopScript,
  startProject,
  stopProject,
  listRunning,
  isRunning
};
