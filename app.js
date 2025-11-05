// app.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');

const {
  ensureDir,
  startScript,
  stopScript,
  listRunning,
  isRunning,
  safeName
} = require('./processManager');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'supersecret123';
const SCRIPTS_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'scripts');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '4000000', 10); // 4MB default

// create folders
ensureDir(SCRIPTS_DIR);
ensureDir(LOG_DIR);
ensureDir(path.join(__dirname, 'uploads'));

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
    if (!file.originalname.endsWith('.js')) return cb(new Error('Only .js allowed'));
    cb(null, true);
  }
});

// HEALTH
app.get('/status', auth, (req, res) => {
  res.json({ success: true, msg: 'runner ok' });
});

// UPLOAD
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

// LIST
app.get('/api/list', auth, async (req, res) => {
  try {
    const files = await fs.readdir(SCRIPTS_DIR);
    const meta = files.filter(f => f.endsWith('.js')).map(f => ({ name: f, running: isRunning(f) }));
    res.json({ success: true, scripts: meta });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DOWNLOAD
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

// SAVE / EDIT
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

// START (body: { name, autoRestart (optional bool) })
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

// STOP
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

// LOGS (tail by characters)
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

// DIAGNOSTIC: list running
app.get('/api/running', auth, (req, res) => {
  res.json({ success: true, running: listRunning() });
});

app.listen(PORT, () => console.log(`Runner listening on port ${PORT}`));
