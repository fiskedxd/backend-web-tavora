const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const authRoutes = require('./routes/auth');
const socialRoutes = require('./routes/social');
const musicRoutes = require('./routes/music');
const { Server: SocketServer } = require('socket.io');
const { reconcileOfficialFriends } = require('./services/officialAccount');
const audioPresence = new Map();

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
const corsOptions = {
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
};
const io = new SocketServer(httpServer, { cors: corsOptions });
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use('/api/auth', authRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/music', musicRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

app.get('/', (req, res) => {
  res.json({ message: 'Tavora API is live' });
});

const voiceRoom = (serverId, channelId) => `voice:${serverId}:${channelId}`;
const broadcastVoiceParticipants = async (room) => {
  const sockets = await io.in(room).fetchSockets();
  const uniqueParticipants = new Map();
  sockets.forEach((socket) => {
    if (socket.data.voice?.room === room) uniqueParticipants.set(String(socket.data.voice.userId), socket.data.voice);
  });
  io.to(room).emit('voice:participants', [...uniqueParticipants.values()]);
};

io.on('connection', (socket) => {
  socket.on('audio:activity', (activity) => {
    const userId = String(activity?.userId || '');
    if (!userId) return;
    if (activity.isPlaying && activity.title) {
      audioPresence.set(userId, { userId, title: String(activity.title), isPlaying: true, updatedAt: new Date().toISOString(), socketId: socket.id });
    } else {
      audioPresence.delete(userId);
    }
  });

  socket.on('voice:join', async ({ serverId, channelId, user }) => {
    if (!serverId || !channelId || !user?.id) return;
    const previousRoom = socket.data.voice?.room;
    if (previousRoom) {
      socket.leave(previousRoom);
      socket.to(previousRoom).emit('voice:peer-left', { userId: user.id });
      await broadcastVoiceParticipants(previousRoom);
    }
    const room = voiceRoom(serverId, channelId);
    socket.join(room);
    socket.data.voice = { room, userId: String(user.id), username: user.username || 'user', displayName: user.displayName || user.username || 'Utilisateur', avatarUrl: user.avatarUrl || '', micOn: true, cameraOn: false, streaming: false, socketId: socket.id };
    socket.to(room).emit('voice:peer-joined', socket.data.voice);
    await broadcastVoiceParticipants(room);
  });

  socket.on('voice:state', async (state) => {
    if (!socket.data.voice) return;
    socket.data.voice = { ...socket.data.voice, ...state };
    await broadcastVoiceParticipants(socket.data.voice.room);
  });

  socket.on('voice:signal', ({ targetSocketId, signal }) => {
    if (targetSocketId && signal) io.to(targetSocketId).emit('voice:signal', { fromSocketId: socket.id, signal });
  });

  socket.on('voice:leave', async () => {
    const room = socket.data.voice?.room;
    if (!room) return;
    socket.leave(room);
    socket.to(room).emit('voice:peer-left', { userId: socket.data.voice.userId, socketId: socket.id });
    socket.data.voice = null;
    await broadcastVoiceParticipants(room);
  });

  socket.on('disconnect', async () => {
    for (const [userId, activity] of audioPresence.entries()) {
      if (activity.socketId === socket.id) audioPresence.delete(userId);
    }
    const room = socket.data.voice?.room;
    if (!room) return;
    socket.to(room).emit('voice:peer-left', { userId: socket.data.voice.userId, socketId: socket.id });
    await broadcastVoiceParticipants(room);
  });
});

app.get('/api/social/users/:userId/audio-activity', (req, res) => {
  const activity = audioPresence.get(String(req.params.userId));
  res.json({ activity: activity ? { userId: activity.userId, title: activity.title, isPlaying: activity.isPlaying, updatedAt: activity.updatedAt } : null });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Payload too large.' });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: 'Invalid JSON payload.' });
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error.' });
});

const connectDB = async () => {
  if (!MONGO_URI) {
    console.error('MONGO_URI is not configured. Database features are unavailable.');
    return;
  }
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected');
    await reconcileOfficialFriends();
    console.log('Official Tevora account ready');
  } catch (error) {
    console.warn('MongoDB connection failed, continuing without DB:', error.message);
  }
};

connectDB();

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
