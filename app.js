// app.js (modified — adds project upload/clone/install/start/stop while keeping existing endpoints)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

const {
  ensureDir,
  startScript,
  stopScript,
  listRunning,
  isRunning,
  safeName
} = require('./processManager');

let unzipper;
try {
  unzipper = require('unzipper');
} catch (e) {
  // if unzipper not installed, project upload will return an error explaining to install it
  unzipper = null;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'supersecret123';
const SCRIPTS_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'scripts');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(__dirname, 'projects');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '4000000', 10); // 4MB default

// project process map: name -> { child, logPath, startedAt, autoRestart }
const projectProcesses = new Map();

// create folders
ensureDir(SCRIPTS_DIR);
ensureDir(LOG_DIR);
ensureDir(path.join(__dirname, 'uploads'));
ensureDir(PROJECTS_DIR);

// simple auth middleware: accept apikey in body/query/header 'x-api-key'
function auth(req, res, next) {
  const key = (req.body && req.body.apikey) || req.query.apikey || req.query.key || req.headers['x-api-key'];
  if (!key || key !== API_KEY) return res.status(403).json({ success: false, error: 'Invalid API key' });
  next();
}

// multer config
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // allow both .js and .zip for project upload (zip will be handled on project endpoints)
    if (!file.originalname.endsWith('.js') && !file.originalname.endsWith('.zip')) return cb(new Error('Only .js or .zip allowed'));
    cb(null, true);
  }
});

// ------------------ existing endpoints (unchanged behavior) ------------------

// HEALTH (requires key)
app.get('/status', auth, (req, res) => {
  res.json({ success: true, msg: 'runner ok' });
});

// UPLOAD single script (.js)
app.post('/api/upload', auth, upload.single('script'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'No file' });

    const provided = req.body.name && String(req.body.name).trim();
    const name = provided ? provided.replace(/[^a-zA-Z0-9._-]/g, '_') : file.originalname;
    const dest = path.join(SCRIPTS_DIR, name);

    await fs.move(file.path, dest, { overwrite: true });
    return res.json({ success: true, message: 'Uploaded', name });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// LIST single-file scripts
app.get('/api/list', auth, async (req, res) => {
  try {
    const files = await fs.readdir(SCRIPTS_DIR);
    const meta = files.filter(f => f.endsWith('.js')).map(f => ({ name: f, running: isRunning(f) }));
    res.json({ success: true, scripts: meta });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DOWNLOAD single-file script
app.get('/api/download', auth, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).send('name required');
    const p = path.join(SCRIPTS_DIR, name);
    if (!await fs.pathExists(p)) return res.status(404).send('Not found');
    res.download(p);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// SAVE / EDIT single-file script
app.post('/api/save', auth, async (req, res) => {
  try {
    const { name, content } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const p = path.join(SCRIPTS_DIR, name);
    if (!await fs.pathExists(p)) return res.status(404).json({ success: false, error: 'not found' });
    await fs.writeFile(p, String(content));
    res.json({ success: true, message: 'Saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// START single-file script (node <script>)
app.post('/api/start', auth, async (req, res) => {
  try {
    const name = req.body.name;
    const autoRestart = !!req.body.autoRestart;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const scriptPath = path.join(SCRIPTS_DIR, name);
    if (!await fs.pathExists(scriptPath)) return res.status(404).json({ success: false, error: 'not found' });
    const meta = startScript(name, scriptPath, LOG_DIR, { autoRestart });
    res.json({ success: true, pid: meta.pid, message: 'Started' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// STOP single-file script
app.post('/api/stop', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    stopScript(name);
    res.json({ success: true, message: 'Stopped' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// LOGS (single-file)
app.get('/api/logs', auth, async (req, res) => {
  try {
    const name = req.query.name;
    const tail = parseInt(req.query.tail || '4000', 10);
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const logFile = path.join(LOG_DIR, `${safeName(name)}.log`);
    if (!await fs.pathExists(logFile)) return res.json({ success: true, logs: '' });
    const data = await fs.readFile(logFile, 'utf8');
    const out = data.slice(-tail);
    res.json({ success: true, logs: out, running: isRunning(name) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DIAGNOSTIC: list running (single-file)
app.get('/api/running', auth, (req, res) => {
  res.json({ success: true, running: listRunning() });
});

// ------------------ project endpoints (new) ------------------

// Helper: list projects in PROJECTS_DIR
async function listProjects() {
  await fs.ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR);
  const projects = [];
  for (const e of entries) {
    const statPath = path.join(PROJECTS_DIR, e);
    try {
      const stat = await fs.stat(statPath);
      if (!stat.isDirectory()) continue;
      // read meta if exists
      let meta = {};
      try { meta = await fs.readJson(path.join(statPath, '.meta.json')); } catch (err) {}
      projects.push({
        name: e,
        createdAt: meta.createdAt || stat.ctimeMs,
        startCommand: meta.startCommand || null,
        running: projectProcesses.has(e)
      });
    } catch (e) { continue; }
  }
  return projects;
}

// Upload project as ZIP (field: archive), name optional, startCommand optional
app.post('/api/project/upload', auth, upload.single('archive'), async (req, res) => {
  try {
    if (!unzipper) return res.status(500).json({ success: false, error: 'Server missing dependency "unzipper". Please install: npm i unzipper' });

    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'No archive uploaded' });

    const provided = req.body.name && String(req.body.name).trim();
    const name = provided ? provided.replace(/[^a-zA-Z0-9._-]/g, '_') : (file.originalname.replace(/\.[^/.]+$/, '')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destDir = path.join(PROJECTS_DIR, name);

    // remove existing (overwrite)
    await fs.remove(destDir);
    await fs.ensureDir(destDir);

    // extract
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(file.path);
      rs.pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    // ensure sessions & logs
    await fs.ensureDir(path.join(destDir, 'sessions'));
    await fs.ensureDir(path.join(destDir, 'logs'));

    // write metadata
    const meta = { name, createdAt: Date.now(), startCommand: req.body.startCommand || null };
    await fs.writeJson(path.join(destDir, '.meta.json'), meta, { spaces: 2 });

    // optionally start npm install in background
    const installer = spawn('npm', ['install', '--production'], { cwd: destDir, shell: false });
    installer.stdout.on('data', d => console.log(`[npm ${name}] ${d}`));
    installer.stderr.on('data', d => console.error(`[npm ${name}] ${d}`));
    installer.on('close', code => console.log(`npm install exit code ${code} for ${name}`));

    res.json({ success: true, message: 'Project uploaded and extraction started', name });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Clone git repo into projects
app.post('/api/project/clone', auth, async (req, res) => {
  try {
    const { git_url, branch, name } = req.body;
    if (!git_url) return res.status(400).json({ success: false, error: 'git_url required' });

    const projectName = (name || path.basename(git_url).replace(/\.git$/, '')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destDir = path.join(PROJECTS_DIR, projectName);

    await fs.remove(destDir);
    await fs.ensureDir(destDir);

    // use git clone (assumes git binary available)
    const args = ['clone', git_url, destDir];
    if (branch) args.splice(1, 0, '--branch', branch);

    const git = spawn('git', args, { shell: false });
    let out = '';
    let errout = '';
    git.stdout.on('data', d => out += d.toString());
    git.stderr.on('data', d => errout += d.toString());
    git.on('close', async (code) => {
      if (code !== 0) {
        await fs.remove(destDir);
        return res.status(500).json({ success: false, error: `git clone failed: ${errout || out}` });
      }
      await fs.ensureDir(path.join(destDir, 'sessions'));
      await fs.ensureDir(path.join(destDir, 'logs'));
      await fs.writeJson(path.join(destDir, '.meta.json'), { name: projectName, git_url, createdAt: Date.now() }, { spaces: 2 });

      // start npm install in background
      const installer = spawn('npm', ['install', '--production'], { cwd: destDir, shell: false });
      installer.stdout.on('data', d => console.log(`[npm ${projectName}] ${d}`));
      installer.stderr.on('data', d => console.error(`[npm ${projectName}] ${d}`));
      installer.on('close', c => console.log(`npm install exit ${c} for ${projectName}`));

      res.json({ success: true, name: projectName });
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger npm install in project
app.post('/api/project/install', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!await fs.pathExists(projectDir)) return res.status(404).json({ success: false, error: 'not found' });

    const installer = spawn('npm', ['install', '--production'], { cwd: projectDir, shell: false });
    installer.stdout.on('data', d => console.log(`[npm ${name}] ${d}`));
    installer.stderr.on('data', d => console.error(`[npm ${name}] ${d}`));
    installer.on('close', code => console.log(`npm install exit ${code} for ${name}`));
    res.json({ success: true, message: 'install started' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start project (reads startCommand from request > .meta.json > package.json.scripts.start)
app.post('/api/project/start', auth, async (req, res) => {
  try {
    const { name, startCommand, autoRestart } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!await fs.pathExists(projectDir)) return res.status(404).json({ success: false, error: 'not found' });

    // determine command
    let cmd = startCommand || null;
    try {
      const meta = await fs.readJson(path.join(projectDir, '.meta.json')).catch(()=>({}));
      if (!cmd && meta.startCommand) cmd = meta.startCommand;
    } catch (e) {}
    if (!cmd) {
      try {
        const pj = await fs.readJson(path.join(projectDir, 'package.json')).catch(()=>null);
        if (pj && pj.scripts && pj.scripts.start) cmd = 'npm start';
      } catch (e) {}
    }
    if (!cmd) {
      // fallback common files
      if (await fs.pathExists(path.join(projectDir, 'src','index.js'))) cmd = 'node src/index.js';
      else if (await fs.pathExists(path.join(projectDir, 'index.js'))) cmd = 'node index.js';
      else return res.status(400).json({ success: false, error: 'No start command found. Provide startCommand or add package.json scripts.start or index.js' });
    }

    // prepare log file
    const logDir = path.join(projectDir, 'logs');
    await fs.ensureDir(logDir);
    const outLog = path.join(logDir, `${name}.log`);
    const outStream = fs.createWriteStream(outLog, { flags: 'a' });

    // if already running, return info
    if (projectProcesses.has(name)) {
      return res.json({ success: true, message: 'Already running', name });
    }

    // spawn command via shell so npm start or complex commands work
    const child = spawn(cmd, { shell: true, cwd: projectDir, env: Object.assign({}, process.env, (await fs.readJson(path.join(projectDir,'.env.meta.json')).catch(()=>({})))) });

    child.stdout.on('data', (d) => {
      outStream.write(`[OUT ${new Date().toISOString()}] ${d}`);
    });
    child.stderr.on('data', (d) => {
      outStream.write(`[ERR ${new Date().toISOString()}] ${d}`);
    });

    child.on('exit', (code, signal) => {
      outStream.write(`[EXIT ${new Date().toISOString()}] code=${code} signal=${signal}\n`);
      outStream.end();
      const meta = projectProcesses.get(name);
      projectProcesses.delete(name);
      // autoRestart logic (basic) - restart if autoRestart true and exit non-zero
      if (meta && meta.autoRestart && code !== 0) {
        // backoff 2s
        setTimeout(() => {
          // re-run start (async, ignore response here)
          spawn(cmd, { shell: true, cwd: projectDir, env: Object.assign({}, process.env, (fs.pathExistsSync(path.join(projectDir,'.env.meta.json')) ? JSON.parse(fs.readFileSync(path.join(projectDir,'.env.meta.json'), 'utf8')) : {})) });
        }, 2000);
      }
    });

    projectProcesses.set(name, { child, pid: child.pid, startedAt: Date.now(), outLog, autoRestart: !!autoRestart });

    res.json({ success: true, pid: child.pid, message: 'Started project', name });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stop project
app.post('/api/project/stop', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const meta = projectProcesses.get(name);
    if (!meta) return res.status(400).json({ success: false, error: 'not running' });
    try {
      meta.child.kill('SIGTERM');
    } catch (e) {
      try { meta.child.kill(); } catch (ee) {}
    }
    projectProcesses.delete(name);
    res.json({ success: true, message: 'Stopped' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Project logs (tail)
app.get('/api/project/logs', auth, async (req, res) => {
  try {
    const name = req.query.name;
    const tail = parseInt(req.query.tail || '4000', 10);
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const logFile = path.join(PROJECTS_DIR, name, 'logs', `${name}.log`);
    if (!await fs.pathExists(logFile)) return res.json({ success: true, logs: '' });
    const data = await fs.readFile(logFile, 'utf8');
    const out = data.slice(-tail);
    res.json({ success: true, logs: out, running: projectProcesses.has(name) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Project list
app.get('/api/project/list', auth, async (req, res) => {
  try {
    const projects = await listProjects();
    res.json({ success: true, projects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Project set-env (store per-project env keys as JSON)
app.post('/api/project/env', auth, async (req, res) => {
  try {
    const { name, env } = req.body;
    if (!name || !env) return res.status(400).json({ success: false, error: 'name & env required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!await fs.pathExists(projectDir)) return res.status(404).json({ success: false, error: 'not found' });
    await fs.writeJson(path.join(projectDir, '.env.meta.json'), env, { spaces: 2 });
    res.json({ success: true, message: 'env saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------ keep health endpoints (public) ------------------
// HEALTH CHECK (no auth) for Deployra
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'panel-runner', time: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// start server
app.listen(PORT, () => console.log(`Runner listening on port ${PORT}`));
