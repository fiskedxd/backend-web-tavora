const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const User = require('../models/User');
const Playlist = require('../models/Playlist');

const router = express.Router();
const publicRoot = path.resolve(__dirname, '../../frontend/public');
const musicRoot = path.join(publicRoot, 'musiques');
const coverRoot = path.join(publicRoot, 'covers');
const playlistCoverRoot = path.join(publicRoot, 'playlist-covers');
const playlistBannerRoot = path.join(publicRoot, 'playlist-banners');
const manifestPath = path.join(musicRoot, 'manifest.json');
const ADMIN_EMAIL = 'slyre6w@gmail.com';
const memoryPlaylists = [];

fs.mkdirSync(musicRoot, { recursive: true });
fs.mkdirSync(coverRoot, { recursive: true });
fs.mkdirSync(playlistCoverRoot, { recursive: true });
fs.mkdirSync(playlistBannerRoot, { recursive: true });
const readManifest = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Array.isArray(parsed.tracks) ? parsed.tracks : [];
  } catch {
    return [];
  }
};
const writeManifest = (tracks) => fs.writeFileSync(manifestPath, `${JSON.stringify({ tracks }, null, 2)}\n`, 'utf8');
const normalizeTrack = (track) => typeof track === 'string' ? { filename: track, title: track.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim(), artist: '', cover: '' } : { filename: track.filename || track.file, title: track.title || '', artist: track.artist || '', cover: track.cover || '' };
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
const serializePlaylist = async (playlist) => {
  const owner = playlist.ownerId && typeof playlist.ownerId === 'object' ? playlist.ownerId : null;
  const serialized = { ...playlist.toObject ? playlist.toObject() : playlist, id: String(playlist._id || playlist.id), owner: owner ? { id: owner._id, username: owner.username, displayName: owner.displayName, avatarUrl: owner.avatarUrl || '' } : null, trackCount: (playlist.tracks || []).length };
  serialized.ownerName = serialized.owner?.displayName || serialized.owner?.username || '';
  return serialized;
};
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, file.fieldname === 'cover' ? coverRoot : musicRoot),
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'track' && (extension !== '.mp3' || file.mimetype !== 'audio/mpeg')) return callback(new Error('Seuls les fichiers MP3 audio/mpeg sont acceptés.'));
    if (['cover', 'banner'].includes(file.fieldname) && !['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(new Error('Format d’image non accepté.'));
    callback(null, true);
  },
});
const playlistUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, callback) => callback(null, file.fieldname === 'cover' ? playlistCoverRoot : playlistBannerRoot),
    filename: (req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(new Error('Format d’image non accepté.'));
    callback(null, true);
  },
});

router.get('/tracks', (req, res) => res.json({ tracks: readManifest().map(normalizeTrack) }));
router.post('/tracks', async (req, res, next) => {
  const user = await requireUser(req, res);
  if (!user) return;
  req.musicUser = user;
  next();
}, upload.fields([{ name: 'track', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  const user = req.musicUser;
  const file = req.files?.track?.[0];
  if (!file) return res.status(400).json({ message: 'Un fichier MP3 est requis.' });
  const title = String(req.body.title || path.basename(file.originalname, '.mp3')).trim().slice(0, 120);
  const artist = String(req.body.artist || '').trim().slice(0, 120);
  const tracks = readManifest();
  const entry = { filename: file.filename, title, artist, cover: req.files?.cover?.[0] ? `/covers/${req.files.cover[0].filename}` : '', uploadedBy: String(user._id), uploadedAt: new Date().toISOString() };
  tracks.push(entry);
  writeManifest(tracks);
  res.status(201).json({ track: normalizeTrack(entry) });
});
router.delete('/tracks/:filename', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (String(user.email).toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ message: 'Action réservée à l’administrateur.' });
  const filename = path.basename(decodeURIComponent(req.params.filename));
  const tracks = readManifest();
  const match = tracks.map(normalizeTrack).find((track) => track.filename === filename);
  if (!match) return res.status(404).json({ message: 'Musique introuvable.' });
  fs.rmSync(path.join(musicRoot, filename), { force: true });
  const nextTracks = tracks.filter((track) => normalizeTrack(track).filename !== filename);
  writeManifest(nextTracks);
  const playlists = mongooseReady() ? await Playlist.find({ tracks: filename }) : memoryPlaylists.filter((playlist) => playlist.tracks.includes(filename));
  await Promise.all(playlists.map((playlist) => { playlist.tracks = playlist.tracks.filter((track) => track !== filename); return playlist.save ? playlist.save() : Promise.resolve(); }));
  res.json({ message: 'Musique supprimée.', tracks: nextTracks.map(normalizeTrack) });
});
const mongooseReady = () => Boolean(Playlist.db?.readyState === 1);
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
}, playlistUpload.fields([{ name: 'cover', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const user = req.musicUser;
  const payload = { title: String(req.body.title || '').trim().slice(0, 120), description: String(req.body.description || '').trim().slice(0, 1000), cover: req.files?.cover?.[0] ? `/playlist-covers/${req.files.cover[0].filename}` : '', banner: req.files?.banner?.[0] ? `/playlist-banners/${req.files.banner[0].filename}` : '', ownerId: user._id, tracks: Array.isArray(req.body.tracks) ? req.body.tracks.map((track) => path.basename(String(track))).slice(0, 500) : [] };
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
}, playlistUpload.fields([{ name: 'cover', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res) => {
  const user = req.musicUser;
  const playlist = mongooseReady() ? await Playlist.findById(req.params.id) : memoryPlaylists.find((item) => String(item.id) === req.params.id);
  if (!playlist || String(playlist.ownerId?._id || playlist.ownerId) !== String(user._id)) return res.status(403).json({ message: 'Vous ne pouvez modifier que vos playlists.' });
  ['title', 'description', 'cover', 'banner'].forEach((field) => { if (req.body[field] !== undefined) playlist[field] = String(req.body[field]).trim(); });
  if (req.files?.cover?.[0]) playlist.cover = `/playlist-covers/${req.files.cover[0].filename}`;
  if (req.files?.banner?.[0]) playlist.banner = `/playlist-banners/${req.files.banner[0].filename}`;
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
