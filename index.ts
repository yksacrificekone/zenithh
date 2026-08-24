import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

let io: SocketServer | null = null;

const typingTimers: Map<string, NodeJS.Timeout> = new Map();

export function getIO(): SocketServer | null {
  return io;
}

export function initSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // ─── Authentication middleware ────────────────────────────────────────────

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace("Bearer ", "");

    if (!token) {
      return next(new Error("UNAUTHORIZED"));
    }

    const session = await prisma.session.findUnique({
      where: { token },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            presence: true,
          },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      return next(new Error("SESSION_EXPIRED"));
    }

    (socket as any).user = session.user;
    next();
  });

  // ─── Connection ───────────────────────────────────────────────────────────

  io.on("connection", async (socket: Socket) => {
    const user = (socket as any).user as {
      id: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
      presence: string;
    };

    logger.info(`Socket connected: ${user.username} (${socket.id})`);

    // Join personal room for notifications/friend events
    socket.join(`user:${user.id}`);

    // Update presence to ONLINE
    await prisma.user.update({
      where: { id: user.id },
      data: { presence: "ONLINE", lastSeenAt: new Date() },
    }).catch(() => {});

    // Broadcast presence to friends
    await broadcastPresence(user.id, "ONLINE");

    // ─── Join rooms ─────────────────────────────────────────────────────

    socket.on("join:channel", async (data: { channelId: string }) => {
      try {
        const channel = await prisma.channel.findUnique({ where: { id: data.channelId } });
        if (!channel) return;

        const membership = await prisma.communityMember.findUnique({
          where: { userId_communityId: { userId: user.id, communityId: channel.communityId } },
        });

        if (!membership && channel.communityId) return;
        socket.join(`channel:${data.channelId}`);
      } catch (e) {
        logger.error("join:channel error", e);
      }
    });

    socket.on("leave:channel", (data: { channelId: string }) => {
      socket.leave(`channel:${data.channelId}`);
    });

    socket.on("join:community", async (data: { communityId: string }) => {
      try {
        const membership = await prisma.communityMember.findUnique({
          where: { userId_communityId: { userId: user.id, communityId: data.communityId } },
        });
        if (!membership) return;
        socket.join(`community:${data.communityId}`);
      } catch (e) {
        logger.error("join:community error", e);
      }
    });

    socket.on("join:dm", async (data: { conversationId: string }) => {
      try {
        const member = await prisma.directConversationMember.findUnique({
          where: { conversationId_userId: { conversationId: data.conversationId, userId: user.id } },
        });
        if (!member) return;
        socket.join(`dm:${data.conversationId}`);
      } catch (e) {
        logger.error("join:dm error", e);
      }
    });

    // ─── Typing indicators ──────────────────────────────────────────────

    socket.on("typing:start", async (data: { channelId?: string; dmId?: string }) => {
      const room = data.channelId ? `channel:${data.channelId}` : data.dmId ? `dm:${data.dmId}` : null;
      if (!room) return;

      const timerKey = `${user.id}:${room}`;

      socket.to(room).emit("typing:start", {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        channelId: data.channelId,
        dmId: data.dmId,
      });

      // Auto-clear typing after 5s
      const existing = typingTimers.get(timerKey);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        socket.to(room).emit("typing:stop", { userId: user.id, channelId: data.channelId, dmId: data.dmId });
        typingTimers.delete(timerKey);
      }, 5000);

      typingTimers.set(timerKey, timer);
    });

    socket.on("typing:stop", (data: { channelId?: string; dmId?: string }) => {
      const room = data.channelId ? `channel:${data.channelId}` : data.dmId ? `dm:${data.dmId}` : null;
      if (!room) return;

      const timerKey = `${user.id}:${room}`;
      const existing = typingTimers.get(timerKey);
      if (existing) {
        clearTimeout(existing);
        typingTimers.delete(timerKey);
      }

      socket.to(room).emit("typing:stop", { userId: user.id, channelId: data.channelId, dmId: data.dmId });
    });

    // ─── Presence ───────────────────────────────────────────────────────

    socket.on("presence:update", async (data: { presence: string }) => {
      const validPresence = ["ONLINE", "IDLE", "DO_NOT_DISTURB", "INVISIBLE"];
      if (!validPresence.includes(data.presence)) return;

      await prisma.user.update({
        where: { id: user.id },
        data: { presence: data.presence as any },
      }).catch(() => {});

      const effectivePresence = data.presence === "INVISIBLE" ? "OFFLINE" : data.presence;
      await broadcastPresence(user.id, effectivePresence);
    });

    // ─── Voice signaling ─────────────────────────────────────────────────

    socket.on("voice:join", async (data: { channelId: string }) => {
      try {
        const channel = await prisma.channel.findUnique({
          where: { id: data.channelId, type: "VOICE" },
        });
        if (!channel) return;

        const membership = await prisma.communityMember.findUnique({
          where: { userId_communityId: { userId: user.id, communityId: channel.communityId } },
        });
        if (!membership) return;

        socket.join(`voice:${data.channelId}`);

        // Record voice session
        await prisma.voiceSession.upsert({
          where: { id: `${user.id}:${data.channelId}` },
          create: { id: `${user.id}:${data.channelId}`, userId: user.id, channelId: data.channelId },
          update: { leftAt: null },
        }).catch(() => {
          prisma.voiceSession.create({
            data: { userId: user.id, channelId: data.channelId },
          }).catch(() => {});
        });

        io?.to(`community:${channel.communityId}`).emit("voice:join", {
          channelId: data.channelId,
          user: { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl },
        });
      } catch (e) {
        logger.error("voice:join error", e);
      }
    });

    socket.on("voice:leave", async (data: { channelId: string }) => {
      try {
        socket.leave(`voice:${data.channelId}`);

        const channel = await prisma.channel.findUnique({ where: { id: data.channelId } });
        if (channel) {
          await prisma.voiceSession.updateMany({
            where: { userId: user.id, channelId: data.channelId, leftAt: null },
            data: { leftAt: new Date() },
          }).catch(() => {});

          io?.to(`community:${channel.communityId}`).emit("voice:leave", {
            channelId: data.channelId,
            userId: user.id,
          });
        }
      } catch (e) {
        logger.error("voice:leave error", e);
      }
    });

    // WebRTC signaling relay
    socket.on("webrtc:offer", (data: { to: string; offer: RTCSessionDescriptionInit }) => {
      io?.to(`user:${data.to}`).emit("webrtc:offer", {
        from: user.id,
        offer: data.offer,
      });
    });

    socket.on("webrtc:answer", (data: { to: string; answer: RTCSessionDescriptionInit }) => {
      io?.to(`user:${data.to}`).emit("webrtc:answer", {
        from: user.id,
        answer: data.answer,
      });
    });

    socket.on("webrtc:ice-candidate", (data: { to: string; candidate: RTCIceCandidateInit }) => {
      io?.to(`user:${data.to}`).emit("webrtc:ice-candidate", {
        from: user.id,
        candidate: data.candidate,
      });
    });

    // ─── Disconnect ────────────────────────────────────────────────────────

    socket.on("disconnect", async () => {
      logger.info(`Socket disconnected: ${user.username} (${socket.id})`);

      // Check if user has other active sockets
      const userSockets = await io?.in(`user:${user.id}`).fetchSockets();
      const otherSockets = userSockets?.filter((s) => s.id !== socket.id) || [];

      if (otherSockets.length === 0) {
        // Last connection — go offline
        await prisma.user.update({
          where: { id: user.id },
          data: { presence: "OFFLINE", lastSeenAt: new Date() },
        }).catch(() => {});

        await broadcastPresence(user.id, "OFFLINE");

        // Clean up voice sessions
        await prisma.voiceSession.updateMany({
          where: { userId: user.id, leftAt: null },
          data: { leftAt: new Date() },
        }).catch(() => {});
      }
    });
  });

  return io;
}

async function broadcastPresence(userId: string, presence: string): Promise<void> {
  if (!io) return;

  try {
    // Get all friends to notify
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
    });

    const friendIds = friendships.map((f) => (f.userAId === userId ? f.userBId : f.userAId));

    for (const friendId of friendIds) {
      io.to(`user:${friendId}`).emit("presence:update", { userId, presence });
    }

    // Also broadcast to community members
    const memberships = await prisma.communityMember.findMany({
      where: { userId },
      select: { communityId: true },
    });

    for (const m of memberships) {
      io.to(`community:${m.communityId}`).emit("presence:update", { userId, presence });
    }
  } catch (e) {
    logger.error("broadcastPresence error", e);
  }
}
