const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const User = require('../models/User');
const Server = require('../models/Server');
const { ensureUserBadgesAndOfficialFriend } = require('../services/officialAccount');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Spotify constants
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'ce04ed229b4a4731baae7a3d3f334994';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '144117687cfc4467a49a2e2293be9c11';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://tavora-xi.vercel.app/auth/spotify/callback';
const BACKEND_URL = process.env.BACKEND_URL || 'https://backend-web-tavora.fly.dev';

const memoryUsers = [];

const toBase64 = (value) => Buffer.from(String(value)).toString('base64');

const generateTokenSeed = () => {
  const randomToken = crypto.randomInt(10000000, 99999999).toString();
  return randomToken.padStart(8, '0');
};

const buildAccountToken = (user) => {
  const createdAt = new Date(user.createdAt || Date.now()).toISOString();
  const userIdBase64 = toBase64(user._id || user.id);
  const emailBase64 = toBase64(user.email);
  const randomCode = user.tokenSeed || generateTokenSeed();
  const tokenPayload = `${userIdBase64}.${emailBase64}.${createdAt}.${randomCode}`;
  return Buffer.from(tokenPayload).toString('base64');
};

const rotateTokenSeed = async (user) => {
  const newSeed = generateTokenSeed();
  user.tokenSeed = newSeed;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.updatedAt = new Date();
  if (mongoose.connection.readyState === 1) {
    await user.save();
  }
  return user;
};

const getUserFromAuth = async (req) => {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : header).trim();
  if (!token) return null;
  try {
    const parts = Buffer.from(token, 'base64').toString('utf8').split('.');
    const userId = Buffer.from(parts[0] || '', 'base64').toString('utf8');
    return userId ? User.findById(userId) : null;
  } catch (error) {
    return null;
  }
};

const findUser = async ({ email, phone }) => {
  if (mongoose.connection.readyState === 1) {
    return User.findOne({ $or: [{ email }, { phone }] });
  }

  return memoryUsers.find((user) => user.email === email || user.phone === phone) || null;
};

const createUser = async (payload) => {
  if (mongoose.connection.readyState === 1) {
    return User.create(payload);
  }

  const user = {
    _id: new mongoose.Types.ObjectId().toString(),
    ...payload,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  memoryUsers.push(user);
  return user;
};

router.post('/register', async (req, res) => {
  try {
    const { username, displayName, email, phone, password, confirmPassword, acceptTerms } = req.body;

    if (!username || !displayName || !email || !phone || !password || !confirmPassword) {
      return res.status(400).json({ message: 'Veuillez remplir tous les champs requis.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Les mots de passe ne correspondent pas.' });
    }

    if (!acceptTerms) {
      return res.status(400).json({ message: 'Vous devez accepter les conditions d’utilisation.' });
    }

    const normalizedEmail = email.toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();
    const existingUser = await findUser({ email: normalizedEmail, phone });

    if (existingUser || (await User.findOne({ username: normalizedUsername }))) {
      return res.status(409).json({ message: 'Un compte existe déjà avec cet email, ce numéro ou ce nom d’utilisateur.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await createUser({
      username: normalizedUsername,
      displayName: displayName.trim(),
      email: normalizedEmail,
      phone,
      password: hashedPassword,
      acceptTerms,
      tokenSeed: generateTokenSeed(),
      tokenVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await ensureUserBadgesAndOfficialFriend(user);

    // Ajouter le nouvel utilisateur au serveur principal si ce n'est pas le compte officiel
    if (!user.isOfficial && mongoose.connection.readyState === 1) {
      try {
        const mainServer = await Server.findById('6a92e66c940745da8a000cc6');
        if (mainServer && !mainServer.members.some((memberId) => String(memberId) === String(user._id))) {
          mainServer.members.push(user._id);
          await mainServer.save();
        }
      } catch (error) {
        console.error('Erreur lors de l\'ajout au serveur principal:', error);
      }
    }

    const token = buildAccountToken(user);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone,
        acceptTerms: user.acceptTerms,
        badges: user.badges || [],
        isOfficial: Boolean(user.isOfficial),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de créer le compte pour le moment.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Veuillez fournir votre email et votre mot de passe.' });
    }

    const normalizedEmail = email.toLowerCase();
    const user = mongoose.connection.readyState === 1
      ? await User.findOne({ email: normalizedEmail })
      : memoryUsers.find((item) => item.email === normalizedEmail);

    if (!user) {
      return res.status(401).json({ message: 'Identifiants invalides.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Identifiants invalides.' });
    }

    const token = buildAccountToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone,
        acceptTerms: user.acceptTerms,
        badges: user.badges || [],
        isOfficial: Boolean(user.isOfficial),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de connecter le compte pour le moment.' });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword, confirmPassword } = req.body;

    if (!email || !currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Veuillez fournir les informations requises.' });
    }

    const authenticatedUser = await getUserFromAuth(req);
    const normalizedEmail = email.toLowerCase();
    const user = authenticatedUser || (mongoose.connection.readyState === 1
      ? await User.findOne({ email: normalizedEmail })
      : memoryUsers.find((item) => item.email === normalizedEmail));

    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Mot de passe actuel incorrect.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'Les nouveaux mots de passe ne correspondent pas.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);
    user.password = hashedPassword;
    const rotatedUser = await rotateTokenSeed(user);

    res.json({
      token: buildAccountToken(rotatedUser),
      user: {
        id: rotatedUser._id,
        username: rotatedUser.username,
        displayName: rotatedUser.displayName,
        email: rotatedUser.email,
        phone: rotatedUser.phone,
        acceptTerms: rotatedUser.acceptTerms,
        tokenVersion: rotatedUser.tokenVersion,
        avatarUrl: rotatedUser.avatarUrl || '',
        bannerUrl: rotatedUser.bannerUrl || '',
        bio: rotatedUser.bio || '',
        status: rotatedUser.status || 'En ligne',
        activity: null,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de changer le mot de passe.' });
  }
});

router.patch('/email', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const { newEmail, confirmEmail, currentPassword } = req.body;
    const normalizedEmail = String(newEmail || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ message: 'Adresse e-mail invalide.' });
    if (normalizedEmail !== String(confirmEmail || '').trim().toLowerCase()) return res.status(400).json({ message: 'Les adresses e-mail ne correspondent pas.' });
    if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ message: 'Mot de passe actuel incorrect.' });
    const existing = mongoose.connection.readyState === 1 ? await User.findOne({ email: normalizedEmail }) : memoryUsers.find((item) => item.email === normalizedEmail);
    if (existing && String(existing._id) !== String(user._id)) return res.status(409).json({ message: 'Cette adresse e-mail est déjà utilisée.' });
    user.email = normalizedEmail;
    const rotatedUser = await rotateTokenSeed(user);
    res.json({ token: buildAccountToken(rotatedUser), user: { id: rotatedUser._id, username: rotatedUser.username, displayName: rotatedUser.displayName, email: rotatedUser.email, phone: rotatedUser.phone, acceptTerms: rotatedUser.acceptTerms, avatarUrl: rotatedUser.avatarUrl || '', bannerUrl: rotatedUser.bannerUrl || '', bio: rotatedUser.bio || '', status: rotatedUser.status || 'En ligne', createdAt: rotatedUser.createdAt || null } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de modifier l’adresse e-mail.' });
  }
});

// Spotify Auth Routes
router.get('/spotify/login', (req, res) => {
  const scopes = 'user-read-currently-playing user-read-playback-state';
  const redirectUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}&state=${crypto.randomBytes(16).toString('hex')}`;
  res.json({ url: redirectUrl });
});

router.post('/spotify/callback', async (req, res) => {
  try {
    const { code, userId } = req.body;
    if (!code || !userId) return res.status(400).json({ message: 'Code et userId requis.' });

    // Échange du code pour un token Spotify
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        client_id: SPOTIFY_CLIENT_ID,
        client_secret: SPOTIFY_CLIENT_SECRET,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return res.status(400).json({ message: 'Impossible de récupérer le token Spotify.' });

    // Sauvegarde du token Spotify dans la BD
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé.' });

    user.spotifyToken = tokenData.access_token;
    user.spotifyRefreshToken = tokenData.refresh_token;
    user.spotifyTokenExpiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
    await user.save();

    res.json({ success: true, message: 'Spotify connecté avec succès!' });
  } catch (error) {
    console.error('Spotify callback error:', error);
    res.status(500).json({ message: 'Erreur lors de la connexion Spotify.' });
  }
});

router.get('/spotify/activity/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user || !user.spotifyToken) return res.json({ activity: null });

    // Rafraîchir le token si expiré
    if (user.spotifyTokenExpiresAt && new Date() >= user.spotifyTokenExpiresAt) {
      const refreshResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: user.spotifyRefreshToken,
          client_id: SPOTIFY_CLIENT_ID,
          client_secret: SPOTIFY_CLIENT_SECRET,
        }),
      });

      const refreshData = await refreshResponse.json();
      if (refreshData.access_token) {
        user.spotifyToken = refreshData.access_token;
        user.spotifyTokenExpiresAt = new Date(Date.now() + (refreshData.expires_in || 3600) * 1000);
        await user.save();
      }
    }

    // Récupérer la musique en cours
    const currentResponse = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': `Bearer ${user.spotifyToken}` },
    });

    if (!currentResponse.ok) return res.json({ activity: null });

    const currentData = await currentResponse.json();
    if (!currentData.item) return res.json({ activity: null });

    const track = currentData.item;
    res.json({
      activity: {
        type: 'spotify',
        track: track.name,
        artist: track.artists[0]?.name || 'Artiste inconnu',
        imageUrl: track.album?.images?.[0]?.url || '',
        progress: currentData.progress_ms || 0,
        duration: track.duration_ms || 0,
        isPlaying: currentData.is_playing || false,
        spotifyUrl: track.external_urls?.spotify || '',
      },
    });
  } catch (error) {
    console.error('Spotify activity error:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération de l\'activité Spotify.' });
  }
});

module.exports = router;
