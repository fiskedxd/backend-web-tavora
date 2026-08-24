const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['harassment', 'threats', 'impersonation', 'spam', 'scam', 'dangerous', 'hate', 'abuse', 'other'], required: true },
    details: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: ['pending', 'to_review', 'warned', 'suspect', 'closed'], default: 'pending' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    warningMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    reviewTokenHash: { type: String, default: '' },
    reviewTokenExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);
reportSchema.index({ reporterId: 1, targetId: 1 }, { unique: true });
module.exports = mongoose.models.Report || mongoose.model('Report', reportSchema);
