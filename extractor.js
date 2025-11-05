// extractor.js (standalone)
import express from 'express';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import unzipper from 'unzipper';

const PORT = process.env.EXTRACTOR_PORT || 3020;
const UPLOADS = path.join(process.cwd(), 'uploads');
const PROJECTS = path.join(process.cwd(), 'projects');

fs.ensureDirSync(UPLOADS);
fs.ensureDirSync(PROJECTS);

const app = express();
const upload = multer({ dest: UPLOADS, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB

function safeName(n){ return String(n).replace(/[^a-zA-Z0-9_-]/g, '_'); }

app.post('/extract', upload.single('archive'), async (req, res) => {
  try {
    const file = req.file;
    const projectName = req.body.projectName ? safeName(req.body.projectName) : safeName((file.originalname||'project').replace(/\.zip$/i,''));
    if (!file) return res.status(400).json({ success: false, error: 'No file (field: archive)' });

    const dest = path.join(PROJECTS, projectName);
    await fs.ensureDir(dest);

    // unzip using unzipper
    await new Promise((ok, fail) => {
      fs.createReadStream(file.path)
        .pipe(unzipper.Extract({ path: dest }))
        .on('close', ok)
        .on('error', fail);
    });

    // optionally remove uploaded zip (to save space)
    // await fs.remove(file.path);

    res.json({ success: true, project: projectName, path: dest });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// quick health
app.get('/health', (req,res) => res.json({ok:true}));

app.listen(PORT, () => console.log(`Extractor listening on ${PORT}`));
