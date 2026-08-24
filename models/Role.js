const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema(
  {
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 64 },
    color: { type: String, default: '#99aab5' },
    iconUrl: { type: String, default: '' },
    position: { type: Number, default: 0 },
    hoist: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
    isEveryone: { type: Boolean, default: false },
  },
  { timestamps: true }
);

roleSchema.index({ serverId: 1, name: 1 }, { unique: true });
module.exports = mongoose.models.Role || mongoose.model('Role', roleSchema);
