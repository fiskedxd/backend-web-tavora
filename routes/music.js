const express = require('express');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const User = require('../models/User');
const Playlist = require('../models/Playlist');
const Track = require('../models/Track');
const { uploadBuffer, deleteObject, getPublicUrl, isConfigured } = require('../services/r2Storage');

const router = express.Router();
const ADMIN_EMAIL = 'slyre6w@gmail.com';
const memoryPlaylists = [];
const memoryTracks = [];

const getUser = async (req) => {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  try {
    const parts = Buffer.from(raw, 'base64').toString('utf8').split('.');
    const id = Buffer.from(parts[0] || '', 'base64').toString('utf8');
    const email = Buffer.from(parts[1] || '', 'base64').toString('utf8');
    if (!id) return null;
    if (User.db?.readyState === 1) return User.findById(id);
    return { _id: id, email };
  } catch { return null; }
};
const requireUser = async (req, res) => {
  const user = await getUser(req);
  if (!user) { res.status(401).json({ message: 'Connexion requise.' }); return null; }
  return user;
};
const mongooseReady = () => Boolean(Track.db?.readyState === 1);
const normalizeTrack = (track) => ({
  filename: track.filename || track.storageKey?.split('/').pop() || '',
  title: track.title || '',
  artist: track.artist || '',
  cover: track.cover || '',
  url: track.url || (track.filename ? getPublicUrl(`music/${track.filename}`) : ''),
});
const serializePlaylist = async (playlist) => {
  const owner = playlist.ownerId && typeof playlist.ownerId === 'object' ? playlist.ownerId : null;
  const serialized = { ...playlist.toObject ? playlist.toObject() : playlist, id: String(playlist._id || playlist.id), owner: owner ? { id: owner._id, username: owner.username, displayName: owner.displayName, avatarUrl: owner.avatarUrl || '' } : null, trackCount: (playlist.tracks || []).length };
  serialized.ownerName = serialized.owner?.displayName || serialized.owner?.username || '';
  return serialized;
};
const listTracks = async () => {
  if (mongooseReady()) {
    const tracks = await Track.find().sort({ uploadedAt: -1 }).lean();
    return tracks.map(normalizeTrack);
  }
  return memoryTracks.map(normalizeTrack);
};
const saveTrack = async (entry) => {
  if (mongooseReady()) return Track.create(entry);
  memoryTracks.unshift(entry);
  return entry;
};
const removeTrackByFilename = async (filename) => {
  if (mongooseReady()) {
    const track = await Track.findOne({ filename });
    if (track) {
      if (track.storageKey) await deleteObject(track.storageKey).catch(() => {});
      await track.deleteOne();
    }
    return;
  }
  const index = memoryTracks.findIndex((track) => track.filename === filename);
  if (index >= 0) memoryTracks.splice(index, 1);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'track' && (extension !== '.mp3' || file.mimetype !== 'audio/mpeg')) return callback(new Error('Seuls les fichiers MP3 audio/mpeg sont acceptés.'));
    if (['cover', 'banner'].includes(file.fieldname) && !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(new Error('Format d’image non accepté.'));
    callback(null, true);
  },
});

const uploadToR2 = async (file, folder) => {
  const extension = path.extname(file.originalname).toLowerCase() || '';
  const key = `${folder}/${crypto.randomUUID()}${extension}`;
  const url = await uploadBuffer(file.buffer, key, file.mimetype);
  return { key, url, filename: `${key.split('/').pop()}` };
};

router.get('/tracks', async (req, res) => res.json({ tracks: await listTracks() }));

router.post('/tracks', async (req, res, next) => {
  const user = await requireUser(req, res);
  if (!user) return;
  req.musicUser = user;
  next();
}, upload.fields([{ name: 'track', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ message: 'Stockage fichiers indisponible.' });
  const user = req.musicUser;
  const file = req.files?.track?.[0];
  if (!file) return res.status(400).json({ message: 'Un fichier MP3 est requis.' });
  const title = String(req.body.title || path.basename(file.originalname, '.mp3')).trim().slice(0, 120);
  const artist = String(req.body.artist || '').trim().slice(0, 120);
  try {
    const uploaded = await uploadToR2(file, 'music');
    let cover = '';
    if (req.files?.cover?.[0]) {
      const coverUpload = await uploadToR2(req.files.cover[0], 'covers');
      cover = coverUpload.url;
    }
    const entry = { filename: uploaded.filename, title, artist, cover, url: uploaded.url, storageKey: uploaded.key, uploadedBy: user._id, uploadedAt: new Date() };
    await saveTrack(entry);
    res.status(201).json({ track: normalizeTrack(entry) });
  } catch (error) {
    console.error('Track upload error:', error.message);
    res.status(500).json({ message: 'Impossible d’importer la musique.' });
  }
});

router.delete('/tracks/:filename', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (String(user.email).toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ message: 'Action réservée à l’administrateur.' });
  const filename = path.basename(decodeURIComponent(req.params.filename));
  const tracks = await listTracks();
  const match = tracks.find((track) => track.filename === filename);
  if (!match) return res.status(404).json({ message: 'Musique introuvable.' });
  await removeTrackByFilename(filename);
  const playlists = mongooseReady() ? await Playlist.find({ tracks: filename }) : memoryPlaylists.filter((playlist) => playlist.tracks.includes(filename));
  await Promise.all(playlists.map((playlist) => { playlist.tracks = playlist.tracks.filter((track) => track !== filename); return playlist.save ? playlist.save() : Promise.resolve(); }));
  res.json({ message: 'Musique supprimée.', tracks: await listTracks() });
});

router.get('/playlists', async (req, res) => {
  const playlists = mongooseReady() ? await Playlist.find().populate('ownerId', 'username displayName avatarUrl').sort({ createdAt: -1 }).lean() : memoryPlaylists;
  res.json({ playlists: await Promise.all(playlists.map(serializePlaylist)) });
});

router.get('/playlists/:id', async (req, res) => {
  const playlist = mongooseReady() ? await Playlist.findById(req.params.id).populate('ownerId', 'username displayName avatarUrl') : memoryPlaylists.find((item) => String(item.id) === req.params.id);
  if (!playlist) return res.status(404).json({ message: 'Playlist introuvable.' });
  res.json({ playlist: await serializePlaylist(playlist) });
});

router.post('/playlists', async (req, res, next) => {
  const user = await requireUser(req, res);
  if (!user) return;
  req.musicUser = user;
  next();
}, upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const user = req.musicUser;
  let cover = String(req.body.cover || '').trim();
  let banner = String(req.body.banner || '').trim();
  try {
    if (req.files?.cover?.[0]) cover = (await uploadToR2(req.files.cover[0], 'playlist-covers')).url;
    if (req.files?.banner?.[0]) banner = (await uploadToR2(req.files.banner[0], 'playlist-banners')).url;
  } catch (error) {
    return res.status(500).json({ message: 'Impossible d’envoyer les visuels.' });
  }
  const payload = { title: String(req.body.title || '').trim().slice(0, 120), description: String(req.body.description || '').trim().slice(0, 1000), cover, banner, ownerId: user._id, tracks: Array.isArray(req.body.tracks) ? req.body.tracks.map((track) => path.basename(String(track))).slice(0, 500) : [] };
  if (!payload.title) return res.status(400).json({ message: 'Le titre est requis.' });
  const playlist = mongooseReady() ? await Playlist.create(payload) : { ...payload, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerId: { _id: user._id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl || '' } };
  if (!mongooseReady()) memoryPlaylists.unshift(playlist);
  res.status(201).json({ playlist: await serializePlaylist(playlist) });
});

router.patch('/playlists/:id', async (req, res, next) => {
  const user = await requireUser(req, res);
  if (!user) return;
  req.musicUser = user;
  next();
}, upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const user = req.musicUser;
  const playlist = mongooseReady() ? await Playlist.findById(req.params.id) : memoryPlaylists.find((item) => String(item.id) === req.params.id);
  if (!playlist || String(playlist.ownerId?._id || playlist.ownerId) !== String(user._id)) return res.status(403).json({ message: 'Vous ne pouvez modifier que vos playlists.' });
  ['title', 'description', 'cover', 'banner'].forEach((field) => { if (req.body[field] !== undefined) playlist[field] = String(req.body[field]).trim(); });
  try {
    if (req.files?.cover?.[0]) playlist.cover = (await uploadToR2(req.files.cover[0], 'playlist-covers')).url;
    if (req.files?.banner?.[0]) playlist.banner = (await uploadToR2(req.files.banner[0], 'playlist-banners')).url;
  } catch (error) {
    return res.status(500).json({ message: 'Impossible d’envoyer les visuels.' });
  }
  if (Array.isArray(req.body.tracks)) playlist.tracks = req.body.tracks.map((track) => path.basename(String(track))).slice(0, 500);
  if (playlist.save) await playlist.save();
  res.json({ playlist: await serializePlaylist(playlist) });
});

router.delete('/playlists/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const playlist = mongooseReady() ? await Playlist.findById(req.params.id) : memoryPlaylists.find((item) => String(item.id) === req.params.id);
  if (!playlist || String(playlist.ownerId?._id || playlist.ownerId) !== String(user._id)) return res.status(403).json({ message: 'Vous ne pouvez supprimer que vos playlists.' });
  if (playlist.deleteOne) await playlist.deleteOne(); else memoryPlaylists.splice(memoryPlaylists.indexOf(playlist), 1);
  res.json({ message: 'Playlist supprimée.' });
});

module.exports = router;
