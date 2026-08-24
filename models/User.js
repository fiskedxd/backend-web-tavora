const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, unique: true },
    displayName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: { type: String, required: true, trim: true, unique: true },
    password: { type: String, required: true },
    acceptTerms: { type: Boolean, required: true, default: false },
    avatarUrl: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },
    bio: { type: String, default: '' },
    status: { type: String, default: 'En ligne' },
    customStatus: { type: String, default: '', maxlength: 128 },
    customStatusExpiresAt: { type: Date, default: null },
    privacy: {
      friendRequests: { type: String, enum: ['everyone', 'friendsOfFriends', 'nobody'], default: 'everyone' },
      directMessages: { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'everyone' },
      groupInvites: { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'everyone' },
    },
    notifications: {
      messages: { type: Boolean, default: true },
      mentions: { type: Boolean, default: true },
      friendRequests: { type: Boolean, default: true },
      directMessages: { type: Boolean, default: true },
      servers: { type: Boolean, default: true },
    },
    appearance: { type: String, enum: ['dark'], default: 'dark' },
    accessibility: {
      textSize: { type: String, enum: ['small', 'normal', 'large'], default: 'normal' },
      reduceMotion: { type: Boolean, default: false },
      highContrast: { type: Boolean, default: false },
    },
    voiceVideo: {
      inputDeviceId: { type: String, default: '' },
      outputDeviceId: { type: String, default: '' },
      inputVolume: { type: Number, min: 0, max: 100, default: 100 },
      outputVolume: { type: Number, min: 0, max: 100, default: 100 },
      noiseSuppression: { type: Boolean, default: true },
      echoCancellation: { type: Boolean, default: true },
      autoGainControl: { type: Boolean, default: true },
      cameraEnabled: { type: Boolean, default: false },
    },
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
    readReceipts: { type: mongoose.Schema.Types.Mixed, default: {} },
    incomingFriendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
    outgoingFriendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
    activity: { type: mongoose.Schema.Types.Mixed, default: null },
    tokenVersion: { type: Number, default: 1 },
    tokenSeed: { type: String, default: '' },
      badges: [{ type: String, trim: true, default: [] }],
      isOfficial: { type: Boolean, default: false, index: true },
      systemPermissions: [{ type: String, trim: true, default: [] }],
      isSuspect: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
