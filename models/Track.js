const mongoose = require('mongoose');

const trackSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, unique: true, trim: true },
    title: { type: String, default: '', trim: true },
    artist: { type: String, default: '', trim: true },
    cover: { type: String, default: '' },
    url: { type: String, default: '' },
    storageKey: { type: String, default: '' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Track || mongoose.model('Track', trackSchema);
