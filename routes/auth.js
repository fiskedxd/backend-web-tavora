const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const User = require('../models/User');
const { ensureUserBadgesAndOfficialFriend } = require('../services/officialAccount');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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

module.exports = router;
