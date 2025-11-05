// di processManager.js (CommonJS)
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const processes = new Map();

function startProject(name, command, cwd, logDir, opts = {}) {
  const sname = String(name).replace(/[^a-zA-Z0-9._-]/g,'_');
  if (processes.has(sname)) throw new Error('Project already running');

  fs.ensureDirSync(logDir);
  const outLog = path.join(logDir, `${sname}.log`);
  const outStream = fs.createWriteStream(outLog, { flags: 'a' });

  // run command via shell so it can be 'npm start' or 'node src/index.js'
  const child = spawn(command, { shell: true, cwd, env: Object.assign({}, process.env, opts.env || {}), stdio: ['ignore','pipe','pipe'] });

  child.stdout.on('data', d => outStream.write(`[OUT ${new Date().toISOString()}] ${d}`));
  child.stderr.on('data', d => outStream.write(`[ERR ${new Date().toISOString()}] ${d}`));

  child.on('exit', (code, sig) => {
    outStream.write(`[EXIT ${new Date().toISOString()}] code=${code} sig=${sig}\n`);
    processes.delete(sname);
    outStream.end();
    if (opts.autoRestart && !opts.stoppedManually) {
      setTimeout(()=> startProject(name, command, cwd, logDir, opts), 1500);
    }
  });

  processes.set(sname, { child, pid: child.pid, startedAt: Date.now(), outLog, cwd });
  return processes.get(sname);
}

function stopProject(name) {
  const sname = String(name).replace(/[^a-zA-Z0-9._-]/g,'_');
  const meta = processes.get(sname);
  if (!meta) throw new Error('Not running');
  meta.child.kill('SIGTERM');
  return true;
}

function isProjectRunning(name){ return processes.has(String(name).replace(/[^a-zA-Z0-9._-]/g,'_')); }
function listProjectsRunning(){ return Array.from(processes.entries()).map(([k,v])=>({ name:k, pid:v.pid, startedAt:v.startedAt })); }

module.exports = { startProject, stopProject, isProjectRunning, listProjectsRunning };
