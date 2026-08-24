const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', default: null, index: true },
    channelId: { type: String, default: '', index: true },
    isPrivate: { type: Boolean, default: false, index: true },
    conversationId: { type: String, default: '', index: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorName: { type: String, required: true, trim: true },
    authorUsername: { type: String, required: true, trim: true, lowercase: true, index: true },
    authorDisplayName: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
      isOfficialMessage: { type: Boolean, default: false, index: true },
      moderationTargetId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      moderationAlert: { type: Boolean, default: false },
      moderationReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report', default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Message || mongoose.model('Message', messageSchema);
