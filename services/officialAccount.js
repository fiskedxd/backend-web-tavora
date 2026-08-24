const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');

const OFFICIAL_USERNAME = 'tevora';
const OFFICIAL_AVATAR_URL = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/favicon.png`;
const OFFICIAL_EMAIL = process.env.TEVORA_OFFICIAL_EMAIL || 'system@tevora.local';
const SYSTEM_PERMISSIONS = ['SYSTEM_OWNER', 'OFFICIAL_MESSAGING'];
const SYSTEM_OWNER_EMAIL = 'slyre6w@gmail.com';
const BADGES = {
  FIRST_HOUR: { id: 'first-hour', name: 'Depuis la première heure', description: 'Membre de Tevora depuis juillet 2026', icon: '✦', order: 10, visibleOnProfile: true, visibleInMessages: true },
  OFFICIAL: { id: 'official', name: 'Compte officiel Tevora', description: 'Compte officiel de la plateforme', icon: '✓', order: 1, visibleOnProfile: true, visibleInMessages: true },
  ADMIN: { id: 'admin', name: 'Administrateur', description: 'Administrateur de Tevora', icon: '◆', order: 3, visibleOnProfile: true, visibleInMessages: true },
  DEVELOPER: { id: 'developer', name: 'Développeur', description: 'Développeur de Tevora', icon: '◇', order: 4, visibleOnProfile: true, visibleInMessages: true },
  CREATOR: { id: 'creator', name: 'Créateur du site', description: 'Créateur de Tevora', icon: '★', order: 2, visibleOnProfile: true, visibleInMessages: true },
};

const badgeForUser = (user) => {
  const createdAt = new Date(user.createdAt);
  const firstHourStart = new Date('2026-07-01T00:00:00.000Z');
  const firstHourEnd = new Date('2026-08-01T00:00:00.000Z');
  const badges = Array.isArray(user.badges) ? [...user.badges] : [];
  if (createdAt >= firstHourStart && createdAt < firstHourEnd && !badges.includes(BADGES.FIRST_HOUR.id)) badges.push(BADGES.FIRST_HOUR.id);
  if (user.isOfficial && !badges.includes(BADGES.OFFICIAL.id)) badges.push(BADGES.OFFICIAL.id);
  return [...new Set(badges)];
};

const ensureOfficialAccount = async () => {
  if (mongoose.connection.readyState !== 1) return null;
  let official = await User.findOne({ $or: [{ isOfficial: true }, { username: OFFICIAL_USERNAME }, { email: OFFICIAL_EMAIL }] });
  if (!official) {
    official = await User.create({
      username: OFFICIAL_USERNAME,
      displayName: 'Tevora',
      email: OFFICIAL_EMAIL,
      phone: `system-${crypto.randomBytes(8).toString('hex')}`,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
      acceptTerms: true,
      avatarUrl: OFFICIAL_AVATAR_URL,
      bannerUrl: '',
      bio: '',
      status: 'Compte officiel',
      isOfficial: true,
      systemPermissions: SYSTEM_PERMISSIONS,
      badges: [BADGES.OFFICIAL.id],
    });
  } else if (!official.isOfficial || official.username !== OFFICIAL_USERNAME || official.displayName !== 'Tevora' || official.avatarUrl !== OFFICIAL_AVATAR_URL || official.bannerUrl || official.bio || official.status !== 'Compte officiel' || JSON.stringify(official.badges || []) !== JSON.stringify([BADGES.OFFICIAL.id])) {
    official.isOfficial = true;
    official.username = OFFICIAL_USERNAME;
    official.displayName = 'Tevora';
    official.avatarUrl = OFFICIAL_AVATAR_URL;
    official.bannerUrl = '';
    official.bio = '';
    official.status = 'Compte officiel';
    official.systemPermissions = SYSTEM_PERMISSIONS;
    official.badges = [BADGES.OFFICIAL.id];
    await official.save();
  }
  const systemOwner = await User.findOne({ email: SYSTEM_OWNER_EMAIL });
  if (systemOwner) {
    const ownerBadges = [BADGES.FIRST_HOUR.id, BADGES.ADMIN.id, BADGES.DEVELOPER.id, BADGES.CREATOR.id];
    const nextPermissions = [...new Set([...(systemOwner.systemPermissions || []), ...SYSTEM_PERMISSIONS])];
    const nextBadges = [...new Set([...(systemOwner.badges || []), ...ownerBadges])];
    if (JSON.stringify(nextPermissions) !== JSON.stringify(systemOwner.systemPermissions || []) || JSON.stringify(nextBadges) !== JSON.stringify(systemOwner.badges || [])) {
      systemOwner.systemPermissions = nextPermissions;
      systemOwner.badges = nextBadges;
      await systemOwner.save();
    }
  }
  return official;
};

const ensureUserBadgesAndOfficialFriend = async (user) => {
  if (!user || mongoose.connection.readyState !== 1) return user;
  const official = await ensureOfficialAccount();
  const badges = badgeForUser(user);
  const officialId = official?._id;
  const hasOfficialFriend = officialId && (user.friends || []).some((id) => String(id) === String(officialId));
  if (badges.join(',') !== (user.badges || []).join(',') || (officialId && String(officialId) !== String(user._id) && !hasOfficialFriend)) {
    user.badges = badges;
    if (officialId && String(officialId) !== String(user._id) && !hasOfficialFriend) user.friends = [...(user.friends || []), officialId];
    await user.save();
  }
  if (officialId && String(officialId) !== String(user._id) && !(official.friends || []).some((id) => String(id) === String(user._id))) {
    official.friends = [...(official.friends || []), user._id];
    await official.save();
  }
  return user;
};

const reconcileOfficialFriends = async () => {
  const official = await ensureOfficialAccount();
  if (!official) return null;
  await User.updateMany({ _id: { $ne: official._id } }, { $pull: { blockedUsers: official._id }, $addToSet: { friends: official._id } });
  const users = await User.find({ _id: { $ne: official._id } }).select('_id').lean();
  if (users.length) await User.updateOne({ _id: official._id }, { $pull: { blockedUsers: { $in: users.map((user) => user._id) } }, $addToSet: { friends: { $each: users.map((user) => user._id) } } });
  return official;
};

const serializeBadges = (user) => (user.badges || []).map((id) => Object.values(BADGES).find((badge) => badge.id === id)).filter(Boolean).sort((left, right) => left.order - right.order);

module.exports = { BADGES, OFFICIAL_USERNAME, OFFICIAL_AVATAR_URL, SYSTEM_PERMISSIONS, ensureOfficialAccount, ensureUserBadgesAndOfficialFriend, reconcileOfficialFriends, serializeBadges };
