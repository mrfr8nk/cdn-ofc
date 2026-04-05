require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { Octokit } = require('octokit');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const upload = multer({ dest: 'tmp/' });

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const REPO = 'cdn-mrfrank';
const BRANCH = 'main';

// Build jsDelivr CDN URL for instant global delivery
function jsDelivrUrl(filePath) {
  return `https://cdn.jsdelivr.net/gh/${process.env.GITHUB_OWNER}/${REPO}@${BRANCH}/${filePath}`;
}

// In-memory file store with upload timestamps
const fileStore = {
  _map: new Map(),

  async init() {
    try {
      console.log('Syncing file store from GitHub...');
      const { data } = await octokit.rest.repos.getContent({
        owner: process.env.GITHUB_OWNER,
        repo: REPO,
        path: '',
        ref: BRANCH
      });

      const files = data.filter(item => item.type === 'file');

      files.forEach(file => {
        const existing = this._map.get(file.path);
        this._map.set(file.path, {
          githubUrl: file.download_url,
          cdnUrl: `${process.env.CDN_DOMAIN}/${file.path}`,
          jsdelivrUrl: jsDelivrUrl(file.path),
          size: file.size,
          sha: file.sha,
          uploadedAt: existing?.uploadedAt || new Date().toISOString()
        });
      });

      console.log(`Loaded ${files.length} files into memory`);
    } catch (error) {
      console.error('Error initializing file store:', error.message);
    }
  },

  get(p) { return this._map.get(p); },
  set(p, value) { this._map.set(p, value); },
  delete(p) { this._map.delete(p); },
  getAll() { return Array.from(this._map.entries()); },
  size() { return this._map.size; }
};

fileStore.init();
setInterval(() => fileStore.init(), 3600000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });

    const customName = req.body.customName || path.parse(req.file.originalname).name;
    const fileExt = path.extname(req.file.originalname);
    const finalFilename = `${customName}${fileExt}`;

    let storagePath = req.body.path || 'media/';
    storagePath = storagePath.replace(/^\/|\/$/g, '') + '/';
    const filePath = `${storagePath}${finalFilename}`;

    const fileContent = fs.readFileSync(req.file.path, { encoding: 'base64' });

    // Check if file already exists to get its SHA (for update)
    let existingSha;
    const existing = fileStore.get(filePath);
    if (existing) existingSha = existing.sha;

    const { data } = await octokit.rest.repos.createOrUpdateFileContents({
      owner: process.env.GITHUB_OWNER,
      repo: REPO,
      path: filePath,
      message: `Upload ${finalFilename}`,
      content: fileContent,
      sha: existingSha,
      branch: BRANCH
    });

    fs.unlinkSync(req.file.path);

    const uploadedAt = new Date().toISOString();
    fileStore.set(filePath, {
      githubUrl: data.content.download_url,
      cdnUrl: `${process.env.CDN_DOMAIN}/${filePath}`,
      jsdelivrUrl: jsDelivrUrl(filePath),
      size: req.file.size,
      sha: data.content.sha,
      uploadedAt
    });

    res.json({
      success: true,
      cdnUrl: `${process.env.CDN_DOMAIN}/${filePath}`,
      jsdelivrUrl: jsDelivrUrl(filePath),
      filename: finalFilename,
      path: filePath,
      size: req.file.size,
      uploadedAt
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// List all files (admin)
app.get('/api/files', (req, res) => {
  try {
    const files = fileStore.getAll().map(([filePath, file]) => ({
      name: filePath.split('/').pop(),
      path: filePath,
      size: file.size,
      url: file.cdnUrl,
      jsdelivrUrl: file.jsdelivrUrl,
      download_url: file.githubUrl,
      uploaded_at: file.uploadedAt || new Date().toISOString(),
      type: filePath.split('.').pop().toLowerCase(),
      sha: file.sha
    }));

    res.json({ files, total: files.length });
  } catch (error) {
    console.error('Files error:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Legacy admin endpoint
app.get('/admin/files', (req, res) => res.redirect('/api/files'));

// Delete file
app.delete('/api/files/:path(*)', async (req, res) => {
  try {
    const filePath = decodeURIComponent(req.params.path);
    const fileInfo = fileStore.get(filePath);

    if (!fileInfo) {
      return res.status(404).json({ error: 'File not found' });
    }

    await octokit.rest.repos.deleteFile({
      owner: process.env.GITHUB_OWNER,
      repo: REPO,
      path: filePath,
      message: `Delete ${filePath}`,
      sha: fileInfo.sha,
      branch: BRANCH
    });

    fileStore.delete(filePath);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file', details: error.message });
  }
});

// Legacy delete endpoint
app.delete('/admin/files/:path(*)', async (req, res) => {
  req.params.path = req.params.path;
  res.redirect(307, `/api/files/${req.params.path}`);
});

// CDN Status API
app.get('/api/status', (req, res) => {
  const files = fileStore.getAll();
  const totalSize = files.reduce((sum, [, f]) => sum + (f.size || 0), 0);
  const types = {};
  files.forEach(([p]) => {
    const ext = p.split('.').pop().toLowerCase();
    types[ext] = (types[ext] || 0) + 1;
  });

  res.json({
    status: 'active',
    repo: REPO,
    owner: process.env.GITHUB_OWNER,
    filesInMemory: fileStore.size(),
    totalSize,
    types,
    cdnDomain: process.env.CDN_DOMAIN,
    uptime: process.uptime()
  });
});

// CDN File serving — proxy through jsDelivr (keeps your domain URL, ultra-fast + cached)
app.get('/*', async (req, res) => {
  try {
    const requestPath = req.path.substring(1);

    if (!requestPath || requestPath === '') {
      return res.status(404).send('Not found');
    }

    // Check memory store first
    let fileInfo = fileStore.get(requestPath);

    // Fallback: discover file from GitHub
    if (!fileInfo) {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner: process.env.GITHUB_OWNER,
          repo: REPO,
          path: requestPath,
          ref: BRANCH
        });

        if (data.type === 'file') {
          fileInfo = {
            githubUrl: data.download_url,
            cdnUrl: `${process.env.CDN_DOMAIN}/${requestPath}`,
            jsdelivrUrl: jsDelivrUrl(requestPath),
            size: data.size,
            sha: data.sha,
            uploadedAt: new Date().toISOString()
          };
          fileStore.set(requestPath, fileInfo);
        }
      } catch (fallbackError) {
        return res.status(404).send('File not found');
      }
    }

    if (!fileInfo) return res.status(404).send('File not found');

    // Stream from jsDelivr — stays on your domain, edge-cached globally
    return streamFromJsdelivr(fileInfo.jsdelivrUrl, requestPath, res);

  } catch (error) {
    console.error('File serving error:', error);
    res.status(500).send('Error retrieving file');
  }
});

// Map file extension to MIME content type
function getContentType(ext) {
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
    '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.oga': 'audio/ogg',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.json': 'application/json', '.xml': 'application/xml',
    '.js': 'application/javascript', '.css': 'text/css',
    '.html': 'text/html', '.txt': 'text/plain',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject'
  };
  return types[ext.toLowerCase()] || null;
}

// Proxy file from jsDelivr — your URL stays intact, content served from edge
async function streamFromJsdelivr(jsdelivrUrl, filePath, res) {
  try {
    const response = await axios.get(jsdelivrUrl, {
      responseType: 'stream',
      timeout: 15000,
      headers: { 'User-Agent': 'MrFrank-CDN/1.0' }
    });

    const ext = '.' + filePath.split('.').pop().toLowerCase();
    const contentType = getContentType(ext);

    // Aggressive caching — browser caches for 1 year, CDN edge for 24h
    res.set({
      'Content-Type': contentType || response.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'CDN-Served-By': 'MrFrank-CDN',
      'Access-Control-Allow-Origin': '*'
    });

    if (response.headers['content-length']) {
      res.set('Content-Length', response.headers['content-length']);
    }

    response.data.pipe(res);
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(502).send('Failed to fetch file');
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`CDN Server running on port ${PORT}`);
  console.log(`CDN Domain: ${process.env.CDN_DOMAIN}`);
  console.log(`GitHub Repo: ${process.env.GITHUB_OWNER}/${REPO}`);
  console.log(`Admin UI: http://localhost:${PORT}/admin.html`);
});
