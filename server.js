import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { startScript, stopScript, listRunning, isRunning, ensureDir } from './processManager.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'supersecret123';
const SCRIPTS_DIR = process.env.UPLOAD_DIR || './scripts';
const LOG_DIR = process.env.LOG_DIR || './logs';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '2000000');

ensureDir(SCRIPTS_DIR);
ensureDir(LOG_DIR);
ensureDir('./uploads');

// Simple auth middleware
function auth(req, res, next) {
  const key = req.body.apikey || req.query.apikey || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(403).json({ success: false, error: 'Invalid API key' });
  next();
}

// Multer for upload
const upload = multer({
  dest: './uploads',
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.js')) return cb(new Error('Only .js allowed'));
    cb(null, true);
  }
});

// Upload script
app.post('/api/upload', auth, upload.single('script'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'No file' });

    const name = req.body.name ? String(req.body.name).replace(/[^a-zA-Z0-9._-]/g, '_') : file.originalname;
    const dest = path.join(SCRIPTS_DIR, name);
    await fs.move(file.path, dest, { overwrite: true });

    return res.json({ success: true, name });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// List scripts
app.get('/api/list', auth, async (req, res) => {
  const files = await fs.readdir(SCRIPTS_DIR);
  const meta = files.filter(f => f.endsWith('.js'))
    .map(f => ({ name: f, running: isRunning(f) }));
  res.json({ success: true, scripts: meta });
});

// Start
app.post('/api/start', auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  const scriptPath = path.join(SCRIPTS_DIR, name);
  if (!await fs.pathExists(scriptPath)) return res.status(404).json({ success: false, error: 'not found' });
  try {
    const meta = startScript(name, scriptPath, LOG_DIR);
    return res.json({ success: true, pid: meta.pid });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Stop
app.post('/api/stop', auth, async (req, res) => {
  const { name } = req.body;
  try {
    stopScript(name);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Logs (tail)
app.get('/api/logs', auth, async (req, res) => {
  const name = req.query.name;
  const tail = parseInt(req.query.tail || '2000');
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  const logFile = path.join(LOG_DIR, `${name}.log`);
  if (!await fs.pathExists(logFile)) return res.json({ success: true, logs: '' });
  const data = await fs.readFile(logFile, 'utf8');
  // Return last N chars
  const out = data.slice(-tail);
  res.json({ success: true, logs: out, running: isRunning(name) });
});

// Download script
app.get('/api/download', auth, async (req, res) => {
  const name = req.query.name;
  const p = path.join(SCRIPTS_DIR, name);
  if (!await fs.pathExists(p)) return res.status(404).send('Not found');
  res.download(p);
});

// Save (edit) script content
app.post('/api/save', auth, async (req, res) => {
  const { name, content } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name required' });
  const p = path.join(SCRIPTS_DIR, name);
  if (!await fs.pathExists(p)) return res.status(404).json({ success: false, error: 'not found' });
  await fs.writeFile(p, String(content));
  res.json({ success: true });
});

// Health
app.get('/api/status', (req, res) => res.json({ success: true, msg: 'runner ok' }));

app.listen(PORT, () => console.log(`Runner listening on port ${PORT}`));
