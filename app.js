// app.js (project-enabled, accepts startCommand provided by client)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

const pm = require('./processManager');

let unzipper;
try { unzipper = require('unzipper'); } catch (e) { unzipper = null; }

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'supersecret123';
const SCRIPTS_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'scripts');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(__dirname, 'projects');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '4000000', 10);

pm.ensureDir(SCRIPTS_DIR);
pm.ensureDir(LOG_DIR);
pm.ensureDir(path.join(__dirname, 'uploads'));
pm.ensureDir(PROJECTS_DIR);

function auth(req, res, next) {
  const key = (req.body && req.body.apikey) || req.query.apikey || req.query.key || req.headers['x-api-key'];
  if (!key || key !== API_KEY) return res.status(403).json({ success: false, error: 'Invalid API key' });
  next();
}

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.js') && !file.originalname.endsWith('.zip')) return cb(new Error('Only .js or .zip allowed'));
    cb(null, true);
  }
});

// ---------------- legacy single-file endpoints (keep working) ----------------
app.get('/status', auth, (req, res) => res.json({ success: true, msg: 'runner ok' }));

app.post('/api/upload', auth, upload.single('script'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success:false, error:'No file' });
    const provided = req.body.name && String(req.body.name).trim();
    const name = provided ? provided.replace(/[^a-zA-Z0-9._-]/g,'_') : file.originalname;
    const dest = path.join(SCRIPTS_DIR, name);
    await fs.move(file.path, dest, { overwrite: true });
    res.json({ success:true, message:'Uploaded', name });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

app.get('/api/list', auth, async (req, res) => {
  try {
    const files = await fs.readdir(SCRIPTS_DIR);
    const meta = files.filter(f => f.endsWith('.js')).map(f => ({ name: f, running: pm.isRunning(f, 'script') }));
    res.json({ success:true, scripts: meta });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

app.post('/api/start', auth, async (req, res) => {
  try {
    const name = req.body.name;
    const autoRestart = !!req.body.autoRestart;
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    const scriptPath = path.join(SCRIPTS_DIR, name);
    if (!await fs.pathExists(scriptPath)) return res.status(404).json({ success:false, error:'not found' });
    const meta = pm.startScript(name, scriptPath, LOG_DIR, { autoRestart });
    res.json({ success:true, pid: meta.pid, message:'Started' });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

app.post('/api/stop', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    pm.stopScript(name);
    res.json({ success:true, message:'Stopped' });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

app.get('/api/logs', auth, async (req, res) => {
  try {
    const name = req.query.name;
    const tail = parseInt(req.query.tail||'4000', 10);
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    const logFile = path.join(LOG_DIR, `${pm.safeName(name)}.log`);
    if (!await fs.pathExists(logFile)) return res.json({ success:true, logs:'' });
    const data = await fs.readFile(logFile,'utf8');
    res.json({ success:true, logs: data.slice(-tail), running: pm.isRunning(name, 'script') });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

app.get('/api/running', auth, (req, res) => res.json({ success:true, running: pm.listRunning() }));

// ---------------- project endpoints ----------------

// list projects
app.get('/api/project/list', auth, async (req, res) => {
  try {
    const entries = await fs.readdir(PROJECTS_DIR);
    const projects = [];
    for (const e of entries) {
      const pdir = path.join(PROJECTS_DIR, e);
      if (! (await fs.stat(pdir)).isDirectory()) continue;
      let meta = {};
      try { meta = await fs.readJson(path.join(pdir,'.meta.json')); } catch(_) {}
      projects.push({ name: e, createdAt: meta.createdAt||null, startCommand: meta.startCommand||null, running: pm.isRunning(e,'project') });
    }
    res.json({ success:true, projects });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// upload project zip (optional field: startCommand)
app.post('/api/project/upload', auth, upload.single('archive'), async (req, res) => {
  try {
    if (!unzipper) return res.status(500).json({ success:false, error: 'Server missing "unzipper". Install: npm i unzipper' });
    const file = req.file;
    if (!file) return res.status(400).json({ success:false, error:'No archive' });
    const provided = req.body.name && String(req.body.name).trim();
    const name = provided ? provided.replace(/[^a-zA-Z0-9._-]/g,'_') : path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-zA-Z0-9._-]/g,'_');
    const destDir = path.join(PROJECTS_DIR, name);
    await fs.remove(destDir);
    await fs.ensureDir(destDir);

    // extract zip
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(file.path);
      rs.pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });

    await fs.ensureDir(path.join(destDir,'sessions'));
    await fs.ensureDir(path.join(destDir,'logs'));

    const meta = { name, createdAt: Date.now(), startCommand: req.body.startCommand || null };
    await fs.writeJson(path.join(destDir,'.meta.json'), meta, { spaces: 2 });

    // background npm install
    const installer = spawn('npm', ['install', '--production'], { cwd: destDir, shell: false });
    installer.stdout.on('data', d => console.log(`[npm ${name}] ${d}`));
    installer.stderr.on('data', d => console.error(`[npm ${name}] ${d}`));
    installer.on('close', c => console.log(`npm install exit ${c} for ${name}`));

    res.json({ success:true, message:'uploaded', name });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// clone from git (if git binary available)
app.post('/api/project/clone', auth, async (req, res) => {
  try {
    const { git_url, branch, name } = req.body;
    if (!git_url) return res.status(400).json({ success:false, error:'git_url required' });
    const projectName = (name || path.basename(git_url).replace(/\.git$/,'')).replace(/[^a-zA-Z0-9._-]/g,'_');
    const destDir = path.join(PROJECTS_DIR, projectName);
    await fs.remove(destDir);
    await fs.ensureDir(destDir);

    const args = ['clone', git_url, destDir];
    if (branch) args.splice(1, 0, '--branch', branch);

    const git = spawn('git', args, { shell: false });
    let out='', errout='';
    git.stdout.on('data', d => out += d.toString());
    git.stderr.on('data', d => errout += d.toString());
    git.on('close', async code => {
      if (code !== 0) { await fs.remove(destDir); return res.status(500).json({ success:false, error: `git clone failed: ${errout||out}` }); }
      await fs.ensureDir(path.join(destDir,'sessions')); await fs.ensureDir(path.join(destDir,'logs'));
      await fs.writeJson(path.join(destDir,'.meta.json'), { name: projectName, git_url, createdAt: Date.now() }, { spaces:2 });
      // background install
      const installer = spawn('npm', ['install','--production'], { cwd: destDir, shell:false });
      installer.on('close', ()=>{});
      res.json({ success:true, name: projectName });
    });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// install deps
app.post('/api/project/install', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!await fs.pathExists(projectDir)) return res.status(404).json({ success:false, error:'not found' });
    const installer = spawn('npm', ['install', '--production'], { cwd: projectDir, shell:false });
    installer.stdout.on('data', d => console.log(`[npm ${name}] ${d}`));
    installer.stderr.on('data', d => console.error(`[npm ${name}] ${d}`));
    installer.on('close', code => console.log(`npm install exit ${code} for ${name}`));
    res.json({ success:true, message:'install started' });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// start project — can include startCommand in body (you choose)
app.post('/api/project/start', auth, async (req, res) => {
  try {
    const { name, startCommand, autoRestart } = req.body;
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!await fs.pathExists(projectDir)) return res.status(404).json({ success:false, error:'not found' });

    // determine command preference: request > meta > package.json.scripts.start > common fallbacks
    let cmd = startCommand || null;
    try {
      const meta = await fs.readJson(path.join(projectDir,'.meta.json')).catch(()=>({}));
      if (!cmd && meta.startCommand) cmd = meta.startCommand;
    } catch(e){}
    if (!cmd) {
      try {
        const pj = await fs.readJson(path.join(projectDir,'package.json')).catch(()=>null);
        if (pj && pj.scripts && pj.scripts.start) cmd = 'npm start';
      } catch(e){}
    }
    if (!cmd) {
      if (await fs.pathExists(path.join(projectDir,'src','index.js'))) cmd = 'node src/index.js';
      else if (await fs.pathExists(path.join(projectDir,'index.js'))) cmd = 'node index.js';
      else return res.status(400).json({ success:false, error:'No start command found. Provide startCommand or add package.json scripts.start or index.js' });
    }

    // store startCommand into meta for convenience if provided
    if (startCommand) {
      const metaPath = path.join(projectDir,'.meta.json');
      const metaObj = await fs.readJson(metaPath).catch(()=>({}));
      metaObj.startCommand = startCommand;
      await fs.writeJson(metaPath, metaObj, { spaces:2 });
    }

    const logDir = path.join(projectDir,'logs'); await fs.ensureDir(logDir);

    // if already running => return
    if (pm.isRunning(name,'project')) return res.json({ success:true, message:'Already running', name });

    const meta = pm.startProject(name, cmd, projectDir, logDir, { autoRestart: !!autoRestart, env: await fs.readJson(path.join(projectDir,'.env.meta.json')).catch(()=>({})) });
    res.json({ success:true, pid: meta.pid, message:'Started project', name });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// stop project
app.post('/api/project/stop', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    pm.stopProject(name);
    res.json({ success:true, message:'Stopped' });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// project logs
app.get('/api/project/logs', auth, async (req, res) => {
  try {
    const name = req.query.name;
    const tail = parseInt(req.query.tail||'4000',10);
    if (!name) return res.status(400).json({ success:false, error:'name required' });
    const logFile = path.join(PROJECTS_DIR, name, 'logs', `${name}.log`);
    if (!await fs.pathExists(logFile)) return res.json({ success:true, logs:'' });
    const data = await fs.readFile(logFile,'utf8');
    res.json({ success:true, logs:data.slice(-tail), running: pm.isRunning(name,'project') });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// project set env (save JSON object)
app.post('/api/project/env', auth, async (req, res) => {
  try {
    const { name, env } = req.body;
    if (!name || !env) return res.status(400).json({ success:false, error:'name & env required' });
    const projectDir = path.join(PROJECTS_DIR, name);
    if (!await fs.pathExists(projectDir)) return res.status(404).json({ success:false, error:'not found' });
    await fs.writeJson(path.join(projectDir,'.env.meta.json'), env, { spaces:2 });
    res.json({ success:true, message:'env saved' });
  } catch (err) { res.status(500).json({ success:false, error: err.message }); }
});

// public health
app.get('/', (req, res) => res.status(200).json({ ok:true, service:'panel-runner', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.status(200).json({ ok:true }));

app.listen(PORT, () => console.log(`Runner listening on port ${PORT}`));
