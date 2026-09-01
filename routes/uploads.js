const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const User = require('../models/User');
const { uploadBuffer, getObjectStream, isConfigured } = require('../services/r2Storage');

const router = express.Router();

const getUser = async (req) => {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  try {
    const parts = Buffer.from(raw, 'base64').toString('utf8').split('.');
    const id = Buffer.from(parts[0] || '', 'base64').toString('utf8');
    if (!id || User.db?.readyState !== 1) return null;
    return User.findById(id);
  } catch {
    return null;
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: 'Stockage fichiers indisponible.' });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ message: 'Connexion requise.' });
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'Fichier requis.' });

  const folder = String(req.body.folder || 'uploads').replace(/[^a-z0-9-_]/gi, '').slice(0, 40) || 'uploads';
  const extension = path.extname(file.originalname).toLowerCase() || '';
  const key = `${folder}/${crypto.randomUUID()}${extension}`;

  try {
    const url = await uploadBuffer(file.buffer, key, file.mimetype);
    res.status(201).json({ url, key });
  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ message: 'Impossible d’envoyer le fichier.' });
  }
});

router.get('/:folder/:filename', async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: 'Stockage fichiers indisponible.' });
  const key = `${req.params.folder}/${req.params.filename}`;
  try {
    const { body, contentType } = await getObjectStream(key);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (body.pipe) body.pipe(res);
    else res.send(body);
  } catch {
    res.status(404).json({ message: 'Fichier introuvable.' });
  }
});

module.exports = router;
