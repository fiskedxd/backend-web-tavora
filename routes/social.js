const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Server = require('../models/Server');
const Message = require('../models/Message');
const Conversation = require('../models/Conversation');
const Role = require('../models/Role');
const Announcement = require('../models/Announcement');
const Report = require('../models/Report');
const { BADGES, OFFICIAL_AVATAR_URL, OFFICIAL_USERNAME, ensureOfficialAccount, ensureUserBadgesAndOfficialFriend, serializeBadges } = require('../services/officialAccount');

const requireOfficialPermission = async (req, permission) => {
  const user = await getUserFromAuth(req);
  if (!user) return { user: null, error: 'Non autorisé.' };
  if (!user.isOfficial && !(user.systemPermissions || []).includes(permission)) return { user, error: 'Cette commande est réservée aux comptes autorisés.' };
  return { user, error: null };
};

const router = express.Router();
const ROLE_PERMISSIONS = ['ADMINISTRATOR', 'VIEW_CHANNELS', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_NICKNAMES', 'SEND_MESSAGES', 'MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY', 'MENTION_EVERYONE', 'ADD_REACTIONS', 'EMBED_LINKS', 'ATTACH_FILES', 'CONNECT', 'SPEAK', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'STREAM', 'USE_VIDEO'];
const DEFAULT_EVERYONE_PERMISSIONS = ['VIEW_CHANNELS', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS', 'CONNECT', 'SPEAK'];
const createDefaultStructure = (serverId) => ({
  categories: [
    { id: `${serverId}-general`, name: 'Général', channels: [{ id: `${serverId}-chat`, type: 'text', name: 'chat' }, { id: `${serverId}-media`, type: 'text', name: 'media' }] },
    { id: `${serverId}-voice`, name: 'Vocal', channels: [{ id: `${serverId}-voice-1`, type: 'voice', name: 'vocal' }] },
  ],
});

const getStructure = (server) => {
  if (server.structure?.categories?.length) return server.structure;
  return createDefaultStructure(String(server._id));
};

const ensureEveryoneRole = async (serverId) => {
  let role = await Role.findOne({ serverId, isEveryone: true });
  if (!role) {
    role = await Role.create({ serverId, name: '@everyone', position: 0, isEveryone: true, permissions: DEFAULT_EVERYONE_PERMISSIONS });
  } else if (!role.permissions?.length || role.permissions.includes('VIEW_CHANNEL')) {
    role.permissions = [...new Set((role.permissions || []).filter((permission) => permission !== 'VIEW_CHANNEL').concat(DEFAULT_EVERYONE_PERMISSIONS))];
    await role.save();
  }
  return role;
};

const getServerAccess = async (server, userId) => {
  if (String(server.owner) === String(userId)) return { isOwner: true, permissions: new Set(ROLE_PERMISSIONS), highestPosition: Number.MAX_SAFE_INTEGER };
  const everyone = await ensureEveryoneRole(server._id);
  const roleIds = (server.memberRoles || []).filter((entry) => String(entry.userId) === String(userId)).map((entry) => entry.roleId);
  const roles = await Role.find({ _id: { $in: [everyone._id, ...roleIds] }, serverId: server._id }).lean();
  const permissions = new Set(roles.flatMap((role) => role.permissions || []));
  if (permissions.has('ADMINISTRATOR')) ROLE_PERMISSIONS.forEach((permission) => permissions.add(permission));
  return { isOwner: false, permissions, highestPosition: Math.max(...roles.map((role) => role.position || 0), 0), roles };
};

const requireServerPermission = async (server, userId, permission) => {
  const access = await getServerAccess(server, userId);
  if (!access.isOwner && !access.permissions.has(permission)) return null;
  return access;
};

const serializeUserProfile = (user) => ({
  id: user._id,
  username: user.username,
  displayName: user.displayName,
  email: user.email,
  createdAt: user.createdAt || null,
  avatarUrl: user.avatarUrl || '',
  bannerUrl: user.bannerUrl || '',
  bio: user.bio || '',
  status: user.status || 'En ligne',
  customStatus: user.customStatus || '',
  customStatusExpiresAt: user.customStatusExpiresAt || null,
  privacy: user.privacy || undefined,
  notifications: user.notifications || undefined,
  appearance: user.appearance || 'dark',
  accessibility: user.accessibility || undefined,
  voiceVideo: user.voiceVideo || undefined,
  activity: null,
  badges: serializeBadges(user),
  isOfficial: Boolean(user.isOfficial),
  isSuspect: Boolean(user.isSuspect),
  canModerate: (user.systemPermissions || []).includes('OFFICIAL_MESSAGING'),
});

const serializeFriendSummary = (user) => ({
  id: user._id,
  username: user.username,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl || '',
  bannerUrl: user.bannerUrl || '',
  bio: user.bio || '',
  status: user.status || 'En ligne',
  customStatus: user.customStatus || '',
  activity: null,
  badges: serializeBadges(user),
  isOfficial: Boolean(user.isOfficial),
  isSuspect: Boolean(user.isSuspect),
});

const buildConversationId = (firstUserId, secondUserId) => [String(firstUserId), String(secondUserId)].sort().join(':');
const buildParticipantKey = (participantIds) => participantIds.map(String).sort().join(':');

const normalizeServerId = (value) => {
  if (!value) return null;

  const rawValue = String(value).trim();
  if (!rawValue) return null;

  const candidates = [rawValue, rawValue.split(':')[0], rawValue.split('|')[0]];

  for (const candidate of candidates) {
    if (mongoose.Types.ObjectId.isValid(candidate)) {
      return candidate;
    }
  }

  return null;
};

const getUserFromAuth = async (req) => {
  const authHeader = req.headers.authorization || '';
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const token = rawToken.trim();

  if (!token) return null;

  try {
    const decodedPayload = Buffer.from(token, 'base64').toString('utf8');
    const parts = decodedPayload.split('.');
    const encodedUserId = parts[0];

    if (!encodedUserId) return null;

    const userId = Buffer.from(encodedUserId, 'base64').toString('utf8');
    if (!userId) return null;

    return User.findById(userId);
  } catch (error) {
    console.error('Invalid auth token', error.message);
    return null;
  }
};

router.get('/me', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    await ensureUserBadgesAndOfficialFriend(user);
    const currentUser = await User.findById(user._id)
      .populate([
        { path: 'friends', select: '_id username displayName avatarUrl bannerUrl bio status customStatus activity badges isOfficial' },
        { path: 'incomingFriendRequests', select: '_id username displayName avatarUrl bannerUrl bio status customStatus activity badges isOfficial' },
        { path: 'outgoingFriendRequests', select: '_id username displayName avatarUrl bannerUrl bio status customStatus activity badges isOfficial' },
      ])
      .lean();

    if (!currentUser) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const servers = await Server.find({ members: user._id }).sort({ createdAt: -1 }).lean();
    const friends = Array.isArray(currentUser.friends) ? currentUser.friends : [];
    const incomingRequests = Array.isArray(currentUser.incomingFriendRequests) ? currentUser.incomingFriendRequests : [];
    const outgoingRequests = Array.isArray(currentUser.outgoingFriendRequests) ? currentUser.outgoingFriendRequests : [];

    res.json({
      user: serializeUserProfile(currentUser),
      servers: servers.map((server) => ({
        id: server._id,
        name: server.name,
        description: server.description,
        owner: server.owner.toString() === user._id.toString(),
        accent: server.accent,
        avatarUrl: server.avatarUrl || '',
        bannerUrl: server.bannerUrl || '',
        structure: getStructure(server),
      })),
      friends: friends.map(serializeFriendSummary),
      incomingRequests: incomingRequests.map(serializeFriendSummary),
      outgoingRequests: outgoingRequests.map(serializeFriendSummary),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger le profil social.' });
  }
});

router.post('/servers', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const { name, description, accent } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Le nom du serveur est requis.' });
    }

    const server = await Server.create({
      name: name.trim(),
      description: description?.trim() || '',
      owner: user._id,
      members: [user._id],
      accent: accent || 'from-indigo-500 to-violet-500',
    });
    server.structure = createDefaultStructure(String(server._id));
    await server.save();
    await ensureEveryoneRole(server._id);

    res.status(201).json({
      server: {
        id: server._id,
        name: server.name,
        description: server.description,
        owner: true,
        accent: server.accent,
        avatarUrl: server.avatarUrl || '',
        bannerUrl: server.bannerUrl || '',
        structure: getStructure(server),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de créer le serveur.' });
  }
});

router.get('/servers/:serverId/roles', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(server.members || []).some((id) => String(id) === String(user._id))) return res.status(403).json({ message: 'Accès refusé.' });
    await ensureEveryoneRole(server._id);
    const roles = await Role.find({ serverId: server._id }).sort({ position: -1, createdAt: 1 }).lean();
    const access = await getServerAccess(server, user._id);
    res.json({ roles, permissions: [...access.permissions], isOwner: access.isOwner, highestPosition: access.highestPosition });
  } catch (error) { res.status(500).json({ message: 'Impossible de charger les rôles.' }); }
});

router.post('/servers/:serverId/roles', async (req, res) => {
  try {
    const user = await getUserFromAuth(req); const server = await Server.findById(req.params.serverId);
    const access = user && server ? await requireServerPermission(server, user._id, 'MANAGE_ROLES') : null;
    if (!access) return res.status(403).json({ message: 'Permission Gérer les rôles requise.' });
    const role = await Role.create({ serverId: server._id, name: String(req.body?.name || 'Nouveau rôle').trim(), color: req.body?.color || '#99aab5', iconUrl: req.body?.iconUrl || '', position: (await Role.countDocuments({ serverId: server._id })) });
    res.status(201).json({ role });
  } catch (error) { res.status(500).json({ message: 'Impossible de créer le rôle.' }); }
});

router.put('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req); const server = await Server.findById(req.params.serverId); const role = await Role.findOne({ _id: req.params.roleId, serverId: req.params.serverId });
    const access = user && server ? await requireServerPermission(server, user._id, 'MANAGE_ROLES') : null;
    if (!access || !role) return res.status(403).json({ message: 'Accès refusé ou rôle introuvable.' });
    if (role.isEveryone || role.position >= access.highestPosition) return res.status(403).json({ message: 'Ce rôle est au-dessus de votre hiérarchie.' });
    ['name', 'color', 'iconUrl', 'hoist'].forEach((field) => { if (req.body[field] !== undefined) role[field] = field === 'name' ? String(req.body[field]).trim() : req.body[field]; });
    if (Array.isArray(req.body.permissions)) role.permissions = req.body.permissions.filter((permission) => ROLE_PERMISSIONS.includes(permission));
    await role.save(); res.json({ role });
  } catch (error) { res.status(500).json({ message: 'Impossible de modifier le rôle.' }); }
});

router.patch('/servers/:serverId/roles/:roleId/position', async (req, res) => {
  try {
    const user = await getUserFromAuth(req); const server = await Server.findById(req.params.serverId); const role = await Role.findOne({ _id: req.params.roleId, serverId: req.params.serverId });
    const access = user && server ? await requireServerPermission(server, user._id, 'MANAGE_ROLES') : null;
    if (!access || !role || role.isEveryone || role.position >= access.highestPosition) return res.status(403).json({ message: 'Ce rôle ne peut pas être déplacé.' });
    const direction = req.body?.direction === 'down' ? -1 : 1;
    const adjacent = await Role.findOne({ serverId: server._id, isEveryone: { $ne: true }, position: direction > 0 ? { $gt: role.position, $lt: access.highestPosition } : { $lt: role.position, $gte: 1 } }).sort({ position: direction > 0 ? 1 : -1 });
    if (!adjacent) return res.json({ roles: await Role.find({ serverId: server._id }).sort({ position: -1, createdAt: 1 }).lean() });
    const currentPosition = role.position;
    role.position = adjacent.position;
    adjacent.position = currentPosition;
    await Promise.all([role.save(), adjacent.save()]);
    res.json({ roles: await Role.find({ serverId: server._id }).sort({ position: -1, createdAt: 1 }).lean() });
  } catch (error) { res.status(500).json({ message: 'Impossible de déplacer le rôle.' }); }
});

router.delete('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req); const server = await Server.findById(req.params.serverId); const role = await Role.findOne({ _id: req.params.roleId, serverId: req.params.serverId });
    const access = user && server ? await requireServerPermission(server, user._id, 'MANAGE_ROLES') : null;
    if (!access || !role) return res.status(403).json({ message: 'Accès refusé ou rôle introuvable.' });
    if (role.isEveryone || role.position >= access.highestPosition) return res.status(403).json({ message: 'Ce rôle ne peut pas être supprimé.' });
    await Role.deleteOne({ _id: role._id }); await Server.updateOne({ _id: server._id }, { $pull: { memberRoles: { roleId: role._id } } });
    res.json({ message: 'Rôle supprimé.' });
  } catch (error) { res.status(500).json({ message: 'Impossible de supprimer le rôle.' }); }
});

router.post('/servers/:serverId/members/:userId/roles/:roleId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req); const server = await Server.findById(req.params.serverId); const role = await Role.findOne({ _id: req.params.roleId, serverId: req.params.serverId });
    const access = user && server ? await requireServerPermission(server, user._id, 'MANAGE_ROLES') : null;
    if (!access || !role || role.isEveryone || role.position >= access.highestPosition) return res.status(403).json({ message: 'Rôle non autorisé.' });
    if (!(server.members || []).some((id) => String(id) === String(req.params.userId))) return res.status(404).json({ message: 'Membre introuvable.' });
    const exists = (server.memberRoles || []).some((entry) => String(entry.userId) === String(req.params.userId) && String(entry.roleId) === String(role._id));
    if (!exists) server.memberRoles.push({ userId: req.params.userId, roleId: role._id }); await server.save();
    res.json({ message: 'Rôle attribué.', role });
  } catch (error) { res.status(500).json({ message: 'Impossible d’attribuer le rôle.' }); }
});

router.delete('/servers/:serverId/members/:userId/roles/:roleId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req); const server = await Server.findById(req.params.serverId); const role = await Role.findOne({ _id: req.params.roleId, serverId: req.params.serverId });
    const access = user && server ? await requireServerPermission(server, user._id, 'MANAGE_ROLES') : null;
    if (!access || !role || role.isEveryone || role.position >= access.highestPosition) return res.status(403).json({ message: 'Rôle non autorisé.' });
    server.memberRoles = (server.memberRoles || []).filter((entry) => !(String(entry.userId) === String(req.params.userId) && String(entry.roleId) === String(role._id))); await server.save();
    res.json({ message: 'Rôle retiré.' });
  } catch (error) { res.status(500).json({ message: 'Impossible de retirer le rôle.' }); }
});

router.get('/servers/:serverId/summary', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const server = await Server.findById(normalizedServerId).lean();
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });

    res.json({
      server: {
        id: server._id,
        name: server.name,
        description: server.description,
        accent: server.accent,
        avatarUrl: server.avatarUrl || '',
        bannerUrl: server.bannerUrl || '',
        memberCount: Array.isArray(server.members) ? server.members.length : 0,
        isMember: server.members?.some((memberId) => String(memberId) === String(user._id)) || false,
        bannedCount: Array.isArray(server.bannedMembers) ? server.bannedMembers.length : 0,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger le serveur.' });
  }
});

router.post('/servers/:serverId/invite', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const server = await Server.findById(normalizedServerId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });

    const duration = req.body?.duration || '1h';
    const customCode = typeof req.body?.customCode === 'string' ? req.body.customCode.trim() : '';
    const durations = { '5m': 5 * 60 * 1000, '10m': 10 * 60 * 1000, '30m': 30 * 60 * 1000, '1h': 60 * 60 * 1000, '8h': 8 * 60 * 60 * 1000, never: null };
    const expiresAt = durations[duration] ? Date.now() + durations[duration] : null;
    const inviteId = server._id.toString();
    const suffix = customCode ? `:${encodeURIComponent(customCode)}` : '';
    const link = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/invite/${inviteId}${suffix}`;

    res.json({
      invite: {
        id: inviteId,
        serverId: server._id,
        link,
        expiresAt,
        customCode: customCode || null,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de générer l’invitation.' });
  }
});

router.post('/servers/join', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const { serverId, expiresAt } = req.body;
    const normalizedServerId = normalizeServerId(serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur requis.' });

    if (expiresAt && Number(expiresAt) > 0 && Date.now() > Number(expiresAt)) {
      return res.status(410).json({ message: 'Lien d’invitation expiré.' });
    }

    const server = await Server.findById(normalizedServerId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });

    const isBanned = (server.bannedMembers || []).some((memberId) => memberId.toString() === user._id.toString());
    if (isBanned) {
      return res.status(403).json({ message: 'Utilisateur banni.' });
    }

    const isMember = (server.members || []).some((memberId) => memberId.toString() === user._id.toString());
    if (!isMember) {
      server.members.push(user._id);
      await server.save();
    }

    res.json({
      message: 'Serveur rejoint.',
      server: {
        id: server._id,
        name: server.name,
        description: server.description,
        accent: server.accent,
        owner: String(server.owner) === String(user._id),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de rejoindre le serveur.' });
  }
});

const saveServerStructure = async (server, structure) => {
  server.structure = structure;
  server.markModified('structure');
  await server.save();
  return getStructure(server);
};

router.post('/servers/:serverId/categories', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(await requireServerPermission(server, user._id, 'MANAGE_CHANNELS'))) return res.status(403).json({ message: 'Permission Gérer les salons requise.' });
    const name = String(req.body?.name || 'Nouvelle catégorie').trim().slice(0, 80);
    const structure = getStructure(server);
    structure.categories.push({ id: `${server._id}-${crypto.randomUUID()}`, name, channels: [] });
    res.status(201).json({ structure: await saveServerStructure(server, structure) });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible de créer la catégorie.' }); }
});

router.patch('/servers/:serverId/categories/:categoryId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(await requireServerPermission(server, user._id, 'MANAGE_CHANNELS'))) return res.status(403).json({ message: 'Permission Gérer les salons requise.' });
    const structure = getStructure(server);
    const category = structure.categories.find((item) => item.id === req.params.categoryId);
    if (!category) return res.status(404).json({ message: 'Catégorie introuvable.' });
    if (req.body?.name !== undefined) category.name = String(req.body.name).trim().slice(0, 80);
    res.json({ structure: await saveServerStructure(server, structure) });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible de modifier la catégorie.' }); }
});

router.delete('/servers/:serverId/categories/:categoryId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(await requireServerPermission(server, user._id, 'MANAGE_CHANNELS'))) return res.status(403).json({ message: 'Permission Gérer les salons requise.' });
    const structure = getStructure(server);
    if (!structure.categories.some((item) => item.id === req.params.categoryId)) return res.status(404).json({ message: 'Catégorie introuvable.' });
    structure.categories = structure.categories.filter((item) => item.id !== req.params.categoryId);
    res.json({ structure: await saveServerStructure(server, structure) });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible de supprimer la catégorie.' }); }
});

router.post('/servers/:serverId/categories/:categoryId/channels', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(await requireServerPermission(server, user._id, 'MANAGE_CHANNELS'))) return res.status(403).json({ message: 'Permission Gérer les salons requise.' });
    const structure = getStructure(server);
    const category = structure.categories.find((item) => item.id === req.params.categoryId);
    if (!category) return res.status(404).json({ message: 'Catégorie introuvable.' });
    const name = String(req.body?.name || 'nouveau-salon').trim().slice(0, 80);
    const type = req.body?.type === 'voice' ? 'voice' : 'text';
    category.channels = category.channels || [];
    category.channels.push({ id: `${server._id}-${crypto.randomUUID()}`, type, name });
    res.status(201).json({ structure: await saveServerStructure(server, structure) });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible de créer le salon.' }); }
});

router.patch('/servers/:serverId/channels/:channelId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(await requireServerPermission(server, user._id, 'MANAGE_CHANNELS'))) return res.status(403).json({ message: 'Permission Gérer les salons requise.' });
    const structure = getStructure(server);
    const channel = structure.categories.flatMap((category) => category.channels || []).find((item) => item.id === req.params.channelId);
    if (!channel) return res.status(404).json({ message: 'Salon introuvable.' });
    if (req.body?.name !== undefined) channel.name = String(req.body.name).trim().slice(0, 80);
    if (req.body?.type !== undefined) channel.type = req.body.type === 'voice' ? 'voice' : 'text';
    res.json({ structure: await saveServerStructure(server, structure) });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible de modifier le salon.' }); }
});

router.delete('/servers/:serverId/channels/:channelId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    const server = await Server.findById(req.params.serverId);
    if (!user || !server || !(await requireServerPermission(server, user._id, 'MANAGE_CHANNELS'))) return res.status(403).json({ message: 'Permission Gérer les salons requise.' });
    const structure = getStructure(server);
    let found = false;
    structure.categories.forEach((category) => {
      const before = (category.channels || []).length;
      category.channels = (category.channels || []).filter((item) => item.id !== req.params.channelId);
      found = found || before !== category.channels.length;
    });
    if (!found) return res.status(404).json({ message: 'Salon introuvable.' });
    res.json({ structure: await saveServerStructure(server, structure) });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible de supprimer le salon.' }); }
});

router.put('/servers/:serverId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const server = await Server.findById(normalizedServerId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });
    if (!(await requireServerPermission(server, user._id, 'MANAGE_SERVER'))) return res.status(403).json({ message: 'Permission Gérer le serveur requise.' });

    ['name', 'accent', 'avatarUrl', 'bannerUrl'].forEach((field) => {
      if (req.body[field] !== undefined) server[field] = req.body[field];
    });
    if (req.body.description !== undefined) server.description = String(req.body.description).trim().slice(0, 280);

    await server.save();

    res.json({
      server: {
        id: server._id,
        name: server.name,
        description: server.description,
        accent: server.accent,
        avatarUrl: server.avatarUrl || '',
        bannerUrl: server.bannerUrl || '',
        owner: true,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de mettre à jour le serveur.' });
  }
});

router.post('/servers/:serverId/kick/:userId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const server = await Server.findById(normalizedServerId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });
    if (!(await requireServerPermission(server, user._id, 'KICK_MEMBERS'))) return res.status(403).json({ message: 'Permission Expulser des membres requise.' });
    if (String(targetUser._id) === String(user._id)) return res.status(400).json({ message: 'Impossible de se retirer soi-même.' });

    server.members = (server.members || []).filter((memberId) => memberId.toString() !== targetUser._id.toString());
    await server.save();

    res.json({ message: 'Membre expulsé.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’expulser le membre.' });
  }
});

router.post('/servers/:serverId/ban/:userId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const server = await Server.findById(normalizedServerId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });
    if (!(await requireServerPermission(server, user._id, 'BAN_MEMBERS'))) return res.status(403).json({ message: 'Permission Bannir des membres requise.' });
    if (String(targetUser._id) === String(user._id)) return res.status(400).json({ message: 'Impossible de se bannir soi-même.' });

    server.members = (server.members || []).filter((memberId) => memberId.toString() !== targetUser._id.toString());
    server.bannedMembers = server.bannedMembers || [];
    if (!server.bannedMembers.some((memberId) => memberId.toString() === targetUser._id.toString())) {
      server.bannedMembers.push(targetUser._id);
    }

    await server.save();

    res.json({ message: 'Membre banni.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de bannir le membre.' });
  }
});

router.post('/servers/:serverId/unban/:userId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    const server = await Server.findById(normalizedServerId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });
    if (String(server.owner) !== String(user._id)) return res.status(403).json({ message: 'Accès refusé.' });

    server.bannedMembers = (server.bannedMembers || []).filter((memberId) => memberId.toString() !== targetUser._id.toString());
    await server.save();

    res.json({ message: 'Utilisateur débanni.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de débannir le membre.' });
  }
});

router.get('/servers/:serverId/bans', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const server = await Server.findById(normalizedServerId).populate('bannedMembers', '_id username displayName avatarUrl').lean();
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });

    res.json({
      banned: (Array.isArray(server.bannedMembers) ? server.bannedMembers : []).map((member) => ({
        id: member._id,
        username: member.username,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl || '',
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger la liste des bannis.' });
  }
});

router.get('/servers/:serverId/members', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const normalizedServerId = normalizeServerId(req.params.serverId);
    if (!normalizedServerId) return res.status(400).json({ message: 'Identifiant du serveur invalide.' });

    const server = await Server.findById(normalizedServerId).populate('members', '_id username displayName avatarUrl bannerUrl bio status customStatus activity badges isOfficial').lean();
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });

    await ensureEveryoneRole(server._id);
    const roles = await Role.find({ serverId: server._id }).sort({ position: -1 }).lean();
    const roleMap = new Map(roles.map((role) => [String(role._id), role]));
    const viewerAccess = await getServerAccess(server, user._id);
    const members = Array.isArray(server.members) ? server.members : [];
    res.json({
      roles,
      members: members.map((member) => {
        const memberRoleIds = (server.memberRoles || []).filter((entry) => String(entry.userId) === String(member._id)).map((entry) => String(entry.roleId));
        const memberRoles = memberRoleIds.map((roleId) => roleMap.get(roleId)).filter(Boolean);
        const primaryRole = memberRoles.filter((role) => !role.isEveryone).sort((left, right) => right.position - left.position).find((role) => role.color) || null;
        return {
        id: member._id,
        username: member.username,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl || '',
        bannerUrl: member.bannerUrl || '',
        bio: member.bio || '',
        status: member.status || 'En ligne',
        customStatus: member.customStatus || '',
        badges: serializeBadges(member),
        isOfficial: Boolean(member.isOfficial),
        roles: memberRoles,
        roleColor: primaryRole?.color || '',
        roleIconUrl: primaryRole?.iconUrl || '',
        canManageRoles: viewerAccess.isOwner || (viewerAccess.permissions.has('MANAGE_ROLES') && String(member._id) !== String(user._id)),
        activity: null,
        isOwner: String(server.owner) === String(member._id),
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger les membres du serveur.' });
  }
});

router.get('/servers/:serverId/messages/:channelId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const { serverId, channelId } = req.params;
    const server = await Server.findById(serverId);
    if (!server || !(server.members || []).some((id) => String(id) === String(user._id)) || !(await requireServerPermission(server, user._id, 'VIEW_CHANNELS'))) return res.status(403).json({ message: 'Vous ne pouvez pas voir ce salon.' });
    const messages = await Message.find({ serverId, channelId }).sort({ createdAt: -1 }).limit(200).populate('authorId', '_id username displayName avatarUrl bannerUrl bio status customStatus badges isOfficial').lean();
    const enrichedMessages = messages.reverse().map((message) => {
      const author = message.authorId && typeof message.authorId === 'object' ? message.authorId : null;
      return {
        ...message,
        authorId: author?._id || message.authorId,
        authorDisplayName: message.authorDisplayName || author?.displayName || author?.username || 'Utilisateur',
        authorUsername: message.authorUsername || author?.username || 'user',
        authorAvatarUrl: message.authorAvatarUrl || author?.avatarUrl || '',
        authorBannerUrl: author?.bannerUrl || '',
        authorBio: author?.bio || '',
        authorActivity: null,
        authorStatus: author?.status || 'En ligne',
        authorBadges: serializeBadges(author || {}),
        isOfficialMessage: Boolean(message.isOfficialMessage),
      };
    });

    res.json({ messages: enrichedMessages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger les messages.' });
  }
});

router.post('/servers/:serverId/messages/:channelId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const { serverId, channelId } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Le message est vide.' });
    }
    const server = await Server.findById(serverId);
    if (!server || !(server.members || []).some((id) => String(id) === String(user._id)) || !(await requireServerPermission(server, user._id, 'SEND_MESSAGES'))) return res.status(403).json({ message: 'Permission Envoyer des messages requise.' });

    const message = await Message.create({
      serverId: new mongoose.Types.ObjectId(serverId),
      channelId,
      authorId: user._id,
      authorName: user.displayName || user.username,
      authorUsername: user.username,
      authorDisplayName: user.displayName || user.username,
      content: content.trim(),
    });

    res.status(201).json({
      message: {
        ...message.toObject(),
        authorDisplayName: user.displayName || user.username,
        authorUsername: user.username,
        authorAvatarUrl: user.avatarUrl || '',
        authorBannerUrl: user.bannerUrl || '',
        authorBio: user.bio || '',
        authorActivity: null,
        authorStatus: user.status || 'En ligne',
        authorBadges: serializeBadges(user),
        isOfficialMessage: false,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’envoyer le message.' });
  }
});

router.put('/messages/:messageId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ message: 'Message introuvable.' });
    if (String(message.authorId) !== String(user._id)) return res.status(403).json({ message: 'Seul l’auteur peut modifier ce message.' });
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Le message ne peut pas être vide.' });
    message.content = content;
    await message.save();
    res.json({ message });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de modifier le message.' });
  }
});

router.delete('/messages/:messageId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ message: 'Message introuvable.' });
    let allowed = String(message.authorId) === String(user._id);
    if (!allowed && message.serverId) {
      const server = await Server.findById(message.serverId);
      allowed = Boolean(server && await requireServerPermission(server, user._id, 'MANAGE_MESSAGES'));
    }
    if (!allowed) return res.status(403).json({ message: 'Permission Gérer les messages requise.' });
    await Message.deleteOne({ _id: message._id });
    res.json({ messageId: message._id });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de supprimer le message.' });
  }
});

router.post('/friends', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const { username } = req.body;
    if (!username) return res.status(400).json({ message: 'Le nom d’utilisateur est requis.' });

    const targetUser = await User.findOne({ username: username.trim().toLowerCase() });
    if (!targetUser || targetUser._id.toString() === user._id.toString()) {
      return res.status(404).json({ message: 'Ami introuvable.' });
    }

    const currentUser = await User.findById(user._id);
    if ((currentUser.blockedUsers || []).some((id) => String(id) === String(targetUser._id)) || (targetUser.blockedUsers || []).some((id) => String(id) === String(currentUser._id))) {
      return res.status(403).json({ message: 'Cette interaction est bloquée.' });
    }
    const alreadyFriend = (currentUser.friends || []).some((friendId) => friendId.toString() === targetUser._id.toString());
    if (alreadyFriend) {
      return res.status(409).json({ message: 'Vous êtes déjà amis.' });
    }

    const alreadySent = (currentUser.outgoingFriendRequests || []).some((friendId) => friendId.toString() === targetUser._id.toString());
    if (alreadySent) {
      return res.status(409).json({ message: 'La demande a déjà été envoyée.' });
    }

    await Promise.all([
      User.findByIdAndUpdate(currentUser._id, { $addToSet: { outgoingFriendRequests: targetUser._id } }),
      User.findByIdAndUpdate(targetUser._id, { $addToSet: { incomingFriendRequests: currentUser._id } }),
    ]);

    res.json({
      message: 'Demande d’amis envoyée.',
      friend: serializeFriendSummary(targetUser),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’ajouter l’ami.' });
  }
});

router.post('/reports/:userId', async (req, res) => {
  try {
    const reporter = await getUserFromAuth(req);
    if (!reporter) return res.status(401).json({ message: 'Non autorisé.' });
    if (String(reporter._id) === String(req.params.userId)) return res.status(400).json({ message: 'Vous ne pouvez pas vous signaler vous-même.' });
    const target = await User.findById(req.params.userId);
    if (!target || target.isOfficial) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    const reason = String(req.body?.reason || '').trim();
    const allowedReasons = ['harassment', 'threats', 'impersonation', 'spam', 'scam', 'dangerous', 'hate', 'abuse', 'other'];
    if (!allowedReasons.includes(reason)) return res.status(400).json({ message: 'Une raison valide est obligatoire.' });
    const details = String(req.body?.details || '').trim();
    if (reason === 'other' && !details) return res.status(400).json({ message: 'Décrivez la raison du signalement.' });
    let report;
    try { report = await Report.create({ reporterId: reporter._id, targetId: target._id, reason, details }); } catch (error) {
      if (error.code === 11000) return res.status(409).json({ message: 'Vous avez déjà signalé ce compte.' });
      throw error;
    }
    const distinctCount = await Report.countDocuments({ targetId: target._id, status: { $in: ['pending', 'to_review'] } });
    if (distinctCount >= 2) {
      await Report.updateMany({ targetId: target._id, status: 'pending' }, { $set: { status: 'to_review' } });
      const official = await ensureOfficialAccount();
      const admin = await User.findOne({ systemPermissions: 'SYSTEM_OWNER' });
      if (official && admin) {
        const conversationId = buildConversationId(official._id, admin._id);
        const alreadyAlerted = await Message.exists({ conversationId, isOfficialMessage: true, content: { $regex: `@${target.username}` } });
        if (!alreadyAlerted) { const firstReport = await Report.findOne({ targetId: target._id }).sort({ createdAt: 1 }).select('_id').lean(); await Message.create({ isPrivate: true, conversationId, channelId: conversationId, recipientId: admin._id, authorId: official._id, authorName: 'Tevora', authorUsername: OFFICIAL_USERNAME, authorDisplayName: 'Tevora', authorAvatarUrl: OFFICIAL_AVATAR_URL, isOfficialMessage: true, moderationAlert: true, moderationTargetId: target._id, moderationReportId: firstReport?._id || null, content: `Vérification de signalements requise\n\nLe compte @${target.username} a reçu ${distinctCount} signalements distincts. Consultez la fiche de modération pour décider d’un avertissement.` }); }
      }
    }
    res.status(201).json({ report: { id: report._id, status: distinctCount >= 2 ? 'to_review' : report.status } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’enregistrer le signalement.' });
  }
});

router.get('/moderation/reports', async (req, res) => {
  const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
  if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
  const reports = await Report.find().sort({ createdAt: -1 }).populate('reporterId', '_id username displayName').populate('targetId', '_id username displayName avatarUrl isSuspect').lean();
  res.json({ reports });
});

router.post('/moderation/reports/:reportId/review-link', async (req, res) => {
  const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
  if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
  const report = await Report.findById(req.params.reportId);
  if (!report) return res.status(404).json({ message: 'Dossier introuvable.' });
  const token = crypto.randomBytes(24).toString('hex');
  report.reviewTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  report.reviewTokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await report.save();
  res.json({ link: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/moderation/review/${report._id}?token=${token}`, expiresAt: report.reviewTokenExpiresAt });
});

router.get('/moderation/reports/:reportId/review', async (req, res) => {
  const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
  if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
  const token = String(req.query.token || '');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const report = await Report.findOne({ _id: req.params.reportId, reviewTokenHash: tokenHash, reviewTokenExpiresAt: { $gt: new Date() } }).populate('targetId', '_id username displayName avatarUrl bannerUrl bio createdAt isSuspect').populate('reporterId', '_id username displayName').lean();
  if (!report) return res.status(404).json({ message: 'Lien de vérification invalide ou expiré.' });
  const reports = await Report.find({ targetId: report.targetId._id }).sort({ createdAt: 1 }).populate('reporterId', '_id username displayName').lean();
  res.json({ report, reports });
});

router.post('/moderation/reports/:targetId/warn', async (req, res) => {
  try {
    const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
    if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
    const target = await User.findById(req.params.targetId);
    const official = await ensureOfficialAccount();
    const reports = await Report.find({ targetId: req.params.targetId, status: { $in: ['to_review', 'pending'] } }).sort({ createdAt: 1 }).limit(10).lean();
    if (!target || !official || reports.length < 2) return res.status(404).json({ message: 'Dossier de signalement introuvable.' });
    const reasons = [...new Set(reports.map((report) => report.reason))].join(', ');
    const conversationId = buildConversationId(official._id, target._id);
    const message = await Message.create({ isPrivate: true, conversationId, channelId: conversationId, recipientId: target._id, authorId: official._id, authorName: 'Tevora', authorUsername: OFFICIAL_USERNAME, authorDisplayName: 'Tevora', authorAvatarUrl: OFFICIAL_AVATAR_URL, isOfficialMessage: true, content: `Message officiel de Tevora\n\nVotre compte a reçu plusieurs signalements (${reasons}).\n\nPour des raisons de sécurité, votre compte est actuellement marqué comme suspect. Ce statut peut être retiré après vérification.` });
    target.isSuspect = true; await target.save();
    await Report.updateMany({ _id: { $in: reports.map((report) => report._id) } }, { $set: { status: 'suspect', reviewedBy: access.user._id, reviewedAt: new Date(), warningMessageId: message._id } });
    res.status(201).json({ message: { ...message.toObject(), isOfficialMessage: true }, status: 'suspect' });
  } catch (error) { console.error(error); res.status(500).json({ message: 'Impossible d’envoyer l’avertissement.' }); }
});

router.post('/moderation/reports/:targetId/ignore', async (req, res) => {
  const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
  if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
  await Report.updateMany({ targetId: req.params.targetId, status: { $in: ['pending', 'to_review'] } }, { $set: { status: 'closed', reviewedBy: access.user._id, reviewedAt: new Date() } });
  res.json({ status: 'closed' });
});

router.delete('/moderation/users/:userId/suspect', async (req, res) => {
  const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
  if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
  const target = await User.findByIdAndUpdate(req.params.userId, { isSuspect: false }, { new: true });
  if (!target) return res.status(404).json({ message: 'Utilisateur introuvable.' });
  await Report.updateMany({ targetId: target._id, status: 'suspect' }, { $set: { status: 'closed', reviewedBy: access.user._id, reviewedAt: new Date() } });
  res.json({ status: 'closed' });
});

router.post('/users/:userId/block', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    if (String(user._id) === String(req.params.userId)) return res.status(400).json({ message: 'Impossible de se bloquer soi-même.' });
    const target = await User.findById(req.params.userId);
    if (!target) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    if (target.isOfficial) return res.status(403).json({ message: 'Le compte officiel Tevora ne peut pas être bloqué.' });
    await Promise.all([
      User.findByIdAndUpdate(user._id, { $addToSet: { blockedUsers: target._id }, $pull: { friends: target._id, outgoingFriendRequests: target._id, incomingFriendRequests: target._id } }),
      User.findByIdAndUpdate(target._id, { $pull: { friends: user._id, outgoingFriendRequests: user._id, incomingFriendRequests: user._id } }),
    ]);
    res.json({ message: 'Utilisateur bloqué.', userId: target._id });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de bloquer cet utilisateur.' });
  }
});

router.post('/users/:userId/unblock', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const target = await User.findById(req.params.userId).select('isOfficial');
    if (target?.isOfficial) return res.status(403).json({ message: 'Le compte officiel Tevora ne peut pas être bloqué.' });
    await User.findByIdAndUpdate(user._id, { $pull: { blockedUsers: req.params.userId } });
    res.json({ message: 'Utilisateur débloqué.', userId: req.params.userId });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de débloquer cet utilisateur.' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const receipts = user.readReceipts || {};
    const messages = await Message.find({ isPrivate: true, recipientId: user._id }).sort({ createdAt: -1 }).limit(500).lean();
    const grouped = new Map();
    messages.forEach((message) => {
      const key = String(message.authorId);
      const readAt = receipts[`dm:${key}`] ? new Date(receipts[`dm:${key}`]).getTime() : 0;
      if (new Date(message.createdAt).getTime() <= readAt) return;
      const current = grouped.get(key) || { userId: message.authorId, count: 0, lastMessageAt: message.createdAt, lastMessage: message.content };
      current.count += 1; current.lastMessageAt = message.createdAt; current.lastMessage = message.content;
      grouped.set(key, current);
    });
    const userIds = [...grouped.keys()];
    const authors = await User.find({ _id: { $in: userIds } }).select('_id username displayName avatarUrl status customStatus').lean();
    const authorMap = new Map(authors.map((author) => [String(author._id), author]));
    const memberships = await Server.find({ members: user._id }).select('_id name avatarUrl').lean();
    const serverIds = memberships.map((server) => server._id);
    const serverMessages = await Message.find({ isPrivate: false, serverId: { $in: serverIds } }).sort({ createdAt: -1 }).limit(1000).lean();
    const serverGrouped = new Map();
    serverMessages.forEach((message) => {
      const key = String(message.serverId);
      const receiptKey = `server:${key}`;
      const readAt = receipts[receiptKey] ? new Date(receipts[receiptKey]).getTime() : 0;
      if (String(message.authorId) === String(user._id) || new Date(message.createdAt).getTime() <= readAt) return;
      const current = serverGrouped.get(key) || { serverId: message.serverId, count: 0, lastMessageAt: message.createdAt };
      current.count += 1; current.lastMessageAt = message.createdAt;
      serverGrouped.set(key, current);
    });
    const serverMap = new Map(memberships.map((server) => [String(server._id), server]));
    res.json({ directMessages: [...grouped.values()].map((item) => ({ ...item, user: authorMap.get(String(item.userId)) || null })), servers: [...serverGrouped.values()].map((item) => ({ ...item, server: serverMap.get(String(item.serverId)) || null })) });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de charger les notifications.' });
  }
});

router.post('/notifications/read', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const { type, userId, serverId, channelId } = req.body || {};
    const key = type === 'dm' ? `dm:${userId}` : type === 'server' ? `server:${serverId}` : `channel:${serverId}:${channelId}`;
    user.readReceipts = { ...(user.readReceipts || {}), [key]: new Date().toISOString() };
    user.markModified('readReceipts');
    await user.save();
    res.json({ message: 'Notification lue.' });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de marquer la notification.' });
  }
});

router.post('/friends/accept/:userId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Demande introuvable.' });

    const currentUser = await User.findById(user._id);
    const hasRequest = (currentUser.incomingFriendRequests || []).some((friendId) => friendId.toString() === targetUser._id.toString());
    if (!hasRequest) return res.status(404).json({ message: 'Demande introuvable.' });

    await Promise.all([
      User.findByIdAndUpdate(currentUser._id, {
        $pull: { incomingFriendRequests: targetUser._id },
        $addToSet: { friends: targetUser._id },
      }),
      User.findByIdAndUpdate(targetUser._id, {
        $pull: { outgoingFriendRequests: currentUser._id },
        $addToSet: { friends: currentUser._id },
      }),
    ]);

    res.json({ message: 'Ami ajouté.', friend: serializeFriendSummary(targetUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’accepter la demande.' });
  }
});

router.post('/friends/decline/:userId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Demande introuvable.' });

    const currentUser = await User.findById(user._id);
    const hasRequest = (currentUser.incomingFriendRequests || []).some((friendId) => friendId.toString() === targetUser._id.toString());
    if (!hasRequest) return res.status(404).json({ message: 'Demande introuvable.' });

    await Promise.all([
      User.findByIdAndUpdate(currentUser._id, { $pull: { incomingFriendRequests: targetUser._id } }),
      User.findByIdAndUpdate(targetUser._id, { $pull: { outgoingFriendRequests: currentUser._id } }),
    ]);

    res.json({ message: 'Demande refusée.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de refuser la demande.' });
  }
});

router.post('/friends/remove/:userId', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    await Promise.all([
      User.findByIdAndUpdate(user._id, { $pull: { friends: req.params.userId } }),
      User.findByIdAndUpdate(req.params.userId, { $pull: { friends: user._id } }),
    ]);
    res.json({ message: 'Ami supprimé.' });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de supprimer cet ami.' });
  }
});

router.get('/messages/private/:userId', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    if ((authUser.blockedUsers || []).some((id) => String(id) === String(targetUser._id)) || (targetUser.blockedUsers || []).some((id) => String(id) === String(authUser._id))) return res.status(403).json({ message: 'Cette conversation est bloquée.' });

    const conversationId = buildConversationId(authUser._id, targetUser._id);
    const privateMessages = await Message.find({ isPrivate: true, conversationId }).sort({ createdAt: -1 }).limit(200).populate('authorId', '_id username displayName avatarUrl bannerUrl bio status customStatus badges isOfficial').lean();
    const enrichedMessages = privateMessages.reverse().map((message) => {
      const author = message.authorId && typeof message.authorId === 'object' ? message.authorId : null;
      return {
        ...message,
        authorId: author?._id || message.authorId,
        authorDisplayName: message.authorDisplayName || author?.displayName || author?.username || 'Utilisateur',
        authorUsername: message.authorUsername || author?.username || 'user',
        authorAvatarUrl: message.authorAvatarUrl || author?.avatarUrl || '',
        authorBannerUrl: author?.bannerUrl || '',
        authorBio: author?.bio || '',
        authorActivity: null,
        authorStatus: author?.status || 'En ligne',
        authorBadges: serializeBadges(author || {}),
        isOfficialMessage: Boolean(message.isOfficialMessage),
      };
    });

    res.json({ messages: enrichedMessages, friend: serializeFriendSummary(targetUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger les messages privés.' });
  }
});

router.get('/users/search', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });

    const query = String(req.query.q || '').trim().toLowerCase();
    if (query.length < 2) return res.status(400).json({ message: 'Saisissez au moins 2 caractères.' });

    const users = await User.find({ username: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })
      .select('_id username displayName avatarUrl bannerUrl bio status customStatus createdAt updatedAt')
      .sort({ username: 1 })
      .limit(10)
      .lean();

    res.json({ users });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de rechercher les utilisateurs.' });
  }
});

router.post('/messages/private/:userId', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });

    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ message: 'Utilisateur introuvable.' });
    if ((authUser.blockedUsers || []).some((id) => String(id) === String(targetUser._id)) || (targetUser.blockedUsers || []).some((id) => String(id) === String(authUser._id))) return res.status(403).json({ message: 'Cette conversation est bloquée.' });

    const content = req.body?.content?.trim();
    if (!content) return res.status(400).json({ message: 'Le message est vide.' });

    const conversationId = buildConversationId(authUser._id, targetUser._id);
    const message = await Message.create({
      serverId: null,
      channelId: conversationId,
      isPrivate: true,
      conversationId,
      recipientId: targetUser._id,
      authorId: authUser._id,
      authorName: authUser.displayName || authUser.username,
      authorUsername: authUser.username,
      authorDisplayName: authUser.displayName || authUser.username,
      authorAvatarUrl: authUser.avatarUrl || '',
      content,
    });

    res.status(201).json({
      message: {
        ...message.toObject(),
        authorDisplayName: authUser.displayName || authUser.username,
        authorUsername: authUser.username,
        authorAvatarUrl: authUser.avatarUrl || '',
        authorBannerUrl: authUser.bannerUrl || '',
        authorBio: authUser.bio || '',
        authorBadges: serializeBadges(authUser),
        isOfficialMessage: false,
        authorActivity: null,
        authorStatus: authUser.status || 'En ligne',
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’envoyer le message privé.' });
  }
});

router.post('/conversations/group', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });
    const requestedIds = Array.isArray(req.body?.participantIds) ? req.body.participantIds : [];
    const participantIds = [...new Set([String(authUser._id), ...requestedIds.map(String)])].filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (participantIds.length < 2) return res.status(400).json({ message: 'Sélectionnez au moins un ami.' });
    const friends = await User.find({ _id: { $in: participantIds }, friends: authUser._id }).select('_id').lean();
    const allowedIds = new Set(friends.map((friend) => String(friend._id)));
    const unauthorized = participantIds.some((id) => id !== String(authUser._id) && !allowedIds.has(id));
    if (unauthorized) return res.status(403).json({ message: 'Tous les participants doivent être vos amis.' });
    const participantKey = buildParticipantKey(participantIds);
    let conversation = await Conversation.findOne({ participantKey }).populate('participants', '_id username displayName avatarUrl').lean();
    if (!conversation) {
      conversation = await Conversation.create({ type: 'group', name: req.body?.name?.trim() || '', participants: participantIds, participantKey, ownerId: authUser._id });
      conversation = await Conversation.findById(conversation._id).populate('participants', '_id username displayName avatarUrl').lean();
    }
    res.status(201).json({ conversation });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de créer la conversation de groupe.' });
  }
});

router.get('/conversations/group/:conversationId/messages', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });
    const conversation = await Conversation.findById(req.params.conversationId).lean();
    if (!conversation || !conversation.participants.some((id) => String(id) === String(authUser._id))) return res.status(404).json({ message: 'Conversation introuvable.' });
    const messages = await Message.find({ isPrivate: true, conversationId: String(conversation._id) }).sort({ createdAt: 1 }).lean();
    const enrichedMessages = await Promise.all(messages.map(async (message) => {
      const author = await User.findById(message.authorId).lean();
      return { ...message, authorDisplayName: author?.displayName || message.authorDisplayName, authorUsername: author?.username || message.authorUsername, authorAvatarUrl: author?.avatarUrl || message.authorAvatarUrl || '' };
    }));
    res.json({ conversation, messages: enrichedMessages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger la conversation.' });
  }
});

router.post('/conversations/group/:conversationId/messages', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });
    const content = req.body?.content?.trim();
    const conversation = await Conversation.findById(req.params.conversationId).lean();
    if (!conversation || !conversation.participants.some((id) => String(id) === String(authUser._id))) return res.status(404).json({ message: 'Conversation introuvable.' });
    if (!content) return res.status(400).json({ message: 'Le message est vide.' });
    const message = await Message.create({ isPrivate: true, conversationId: String(conversation._id), channelId: String(conversation._id), authorId: authUser._id, recipientId: null, authorName: authUser.displayName || authUser.username, authorUsername: authUser.username, authorDisplayName: authUser.displayName || authUser.username, authorAvatarUrl: authUser.avatarUrl || '', content });
    res.status(201).json({ message: { ...message.toObject(), authorDisplayName: authUser.displayName || authUser.username, authorUsername: authUser.username, authorAvatarUrl: authUser.avatarUrl || '' } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’envoyer le message.' });
  }
});

router.get('/profile/:userId', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });

    const { userId } = req.params;
    let targetUser = null;

    if (userId === 'me') {
      await ensureUserBadgesAndOfficialFriend(authUser);
      targetUser = authUser;
    } else if (mongoose.Types.ObjectId.isValid(userId)) {
      const targetUserDocument = await User.findById(userId);
      if (targetUserDocument) await ensureUserBadgesAndOfficialFriend(targetUserDocument);
      targetUser = targetUserDocument?.toObject ? targetUserDocument.toObject() : targetUserDocument;
    }

    if (!targetUser) {
      const targetUserDocument = await User.findOne({ username: String(userId).trim().toLowerCase() });
      if (targetUserDocument) await ensureUserBadgesAndOfficialFriend(targetUserDocument);
      targetUser = targetUserDocument?.toObject ? targetUserDocument.toObject() : targetUserDocument;
    }

    if (!targetUser) return res.status(404).json({ message: 'Profil introuvable.' });

    res.json({ user: serializeUserProfile(targetUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger le profil.' });
  }
});

router.get('/profile/:userId/common', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ message: 'Identifiant invalide.' });
    const targetUser = await User.findById(req.params.userId).select('friends').lean();
    if (!targetUser) return res.status(404).json({ message: 'Profil introuvable.' });

    const getReferenceId = (value) => String(value?._id || value?.id || value);
    const ownFriendIds = (authUser.friends || []).map(getReferenceId).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const targetFriendIds = new Set((targetUser.friends || []).map(getReferenceId));
    const commonFriendIds = ownFriendIds.filter((friendId) => targetFriendIds.has(friendId));
    const [commonFriends, commonServers] = await Promise.all([
      User.find({ _id: { $in: commonFriendIds } }).select('_id username displayName avatarUrl status customStatus').lean(),
      Server.find({ members: { $all: [authUser._id, targetUser._id] } }).select('_id name description avatarUrl members').lean(),
    ]);
    res.json({
      friends: commonFriends.map(serializeFriendSummary),
      servers: commonServers.map((server) => ({ id: server._id, name: server.name, description: server.description || '', avatarUrl: server.avatarUrl || '', memberCount: server.members?.length || 0 })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de charger les relations communes.' });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const authUser = await getUserFromAuth(req);
    if (!authUser) return res.status(401).json({ message: 'Non autorisé.' });
    if (authUser.isOfficial) return res.status(403).json({ message: 'L’identité du compte officiel ne peut pas être modifiée.' });

    const { displayName, username, bio, avatarUrl, bannerUrl, activity, status, customStatus, customStatusExpiresAt } = req.body;
    const updates = {};

    if (displayName !== undefined) updates.displayName = displayName.trim();
    if (username !== undefined) updates.username = username.trim().toLowerCase();
    if (bio !== undefined) updates.bio = bio.trim();
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
    if (bannerUrl !== undefined) updates.bannerUrl = bannerUrl;
    if (activity !== undefined) updates.activity = activity;
    if (status !== undefined) updates.status = status;
    if (customStatus !== undefined) updates.customStatus = String(customStatus).trim().slice(0, 128);
    if (customStatusExpiresAt !== undefined) updates.customStatusExpiresAt = customStatusExpiresAt || null;

    const updatedUser = await User.findByIdAndUpdate(authUser._id, updates, { new: true }).lean();
    if (!updatedUser) return res.status(404).json({ message: 'Profil introuvable.' });

    res.json({ user: serializeUserProfile(updatedUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de mettre à jour le profil.' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const updates = {};
    ['privacy', 'notifications', 'accessibility', 'voiceVideo'].forEach((key) => { if (req.body[key]) updates[key] = req.body[key]; });
    if (req.body.appearance === 'dark') updates.appearance = 'dark';
    if (req.body.status && ['En ligne', 'Absent', 'Ne pas déranger', 'Invisible'].includes(req.body.status)) updates.status = req.body.status;
    if (req.body.customStatus !== undefined) updates.customStatus = String(req.body.customStatus).trim().slice(0, 128);
    if (req.body.customStatusExpiresAt !== undefined) updates.customStatusExpiresAt = req.body.customStatusExpiresAt || null;
    const updatedUser = await User.findByIdAndUpdate(user._id, updates, { new: true }).lean();
    res.json({ user: serializeUserProfile(updatedUser) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de sauvegarder les paramètres.' });
  }
});

router.post('/servers/:serverId/leave', async (req, res) => {
  try {
    const user = await getUserFromAuth(req);
    if (!user) return res.status(401).json({ message: 'Non autorisé.' });
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ message: 'Serveur introuvable.' });
    if (String(server.owner) === String(user._id)) return res.status(400).json({ message: 'Le propriétaire ne peut pas quitter son serveur.' });
    server.members = (server.members || []).filter((memberId) => String(memberId) !== String(user._id));
    await server.save();
    res.json({ message: 'Serveur quitté.' });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de quitter le serveur.' });
  }
});

router.post('/official/send', async (req, res) => {
  try {
    const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
    if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
    const official = await ensureOfficialAccount();
    const { username, userId, content } = req.body || {};
    const target = userId && mongoose.Types.ObjectId.isValid(userId)
      ? await User.findById(userId)
      : await User.findOne({ username: String(username || '').trim().toLowerCase() });
    if (!target || target.isOfficial) return res.status(404).json({ message: 'Utilisateur destinataire introuvable.' });
    if (!String(content || '').trim()) return res.status(400).json({ message: 'Le message est vide.' });
    const conversationId = buildConversationId(official._id, target._id);
    const message = await Message.create({ isPrivate: true, conversationId, channelId: conversationId, recipientId: target._id, authorId: official._id, authorName: 'Tevora', authorUsername: OFFICIAL_USERNAME, authorDisplayName: 'Tevora', authorAvatarUrl: '', isOfficialMessage: true, content: String(content).trim() });
    console.info(JSON.stringify({ type: 'official_command', command: 'send', actorId: String(access.user._id), targetId: String(target._id), messageId: String(message._id), at: new Date().toISOString() }));
    res.status(201).json({ message: { ...message.toObject(), authorBadges: serializeBadges(official), isOfficialMessage: true } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible d’envoyer le message officiel.' });
  }
});

router.post('/official/actus/prepare', async (req, res) => {
  try {
    const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
    if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Le message est vide.' });
    const recipients = await User.find({ isOfficial: { $ne: true }, _id: { $ne: access.user._id } }).select('_id').lean();
    const announcement = await Announcement.create({ authorId: access.user._id, content, recipientCount: recipients.length, status: 'preparing' });
    res.status(201).json({ announcement: { id: announcement._id, content, recipientCount: recipients.length, status: announcement.status } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de préparer l’annonce.' });
  }
});

router.post('/official/actus/:announcementId/send', async (req, res) => {
  try {
    const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
    if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
    const announcement = await Announcement.findById(req.params.announcementId);
    const official = await ensureOfficialAccount();
    if (!announcement || announcement.status !== 'preparing') return res.status(404).json({ message: 'Annonce introuvable ou déjà traitée.' });
    const recipients = await User.find({ isOfficial: { $ne: true }, _id: { $ne: access.user._id } }).select('_id').lean();
    announcement.status = 'processing'; announcement.startedAt = new Date(); await announcement.save();
    setImmediate(async () => {
      let deliveredCount = 0; const failureIds = [];
      for (const recipient of recipients) {
        try {
          const conversationId = buildConversationId(official._id, recipient._id);
          await Message.create({ isPrivate: true, conversationId, channelId: conversationId, recipientId: recipient._id, authorId: official._id, authorName: 'Tevora', authorUsername: OFFICIAL_USERNAME, authorDisplayName: 'Tevora', authorAvatarUrl: '', isOfficialMessage: true, content: announcement.content });
          deliveredCount += 1;
        } catch { failureIds.push(recipient._id); }
      }
      announcement.deliveredCount = deliveredCount; announcement.failedCount = failureIds.length; announcement.failureIds = failureIds; announcement.status = failureIds.length ? 'partial_failure' : 'sent'; announcement.completedAt = new Date(); await announcement.save();
      console.info(JSON.stringify({ type: 'official_command', command: 'actus', actorId: String(access.user._id), announcementId: String(announcement._id), status: announcement.status, at: new Date().toISOString() }));
    });
    res.status(202).json({ announcement: { id: announcement._id, content: announcement.content, recipientCount: recipients.length, status: announcement.status } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Impossible de lancer l’annonce.' });
  }
});

router.get('/official/actus', async (req, res) => {
  const access = await requireOfficialPermission(req, 'OFFICIAL_MESSAGING');
  if (access.error) return res.status(access.user ? 403 : 401).json({ message: access.error });
  const announcements = await Announcement.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json({ announcements });
});

module.exports = router;
