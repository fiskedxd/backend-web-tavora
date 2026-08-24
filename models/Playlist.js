const mongoose = require('mongoose');

const playlistSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    cover: { type: String, default: '' },
    banner: { type: String, default: '' },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tracks: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Playlist || mongoose.model('Playlist', playlistSchema);
