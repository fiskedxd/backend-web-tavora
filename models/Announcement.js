const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, trim: true },
    status: { type: String, enum: ['preparing', 'processing', 'sent', 'partial_failure', 'cancelled'], default: 'preparing' },
    recipientCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    failureIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);
