const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', maxlength: 280, trim: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    memberRoles: {
      type: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' } }],
      default: [],
    },
    bannedMembers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    structure: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ categories: [] }),
    },
    avatarUrl: { type: String, default: '' },
    bannerUrl: { type: String, default: '' },
    accent: { type: String, default: 'from-indigo-500 to-violet-500' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Server || mongoose.model('Server', serverSchema);
