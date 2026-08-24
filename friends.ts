import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import rateLimit from "express-rate-limit";
import { getIO } from "../socket";

const router = Router();

const friendRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: { code: "RATE_LIMITED", message: "Too many friend requests sent." } },
});

// ─── GET /friends ─────────────────────────────────────────────────────────────

router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [{ userAId: req.user!.id }, { userBId: req.user!.id }],
    },
    include: {
      userA: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true, customStatus: true },
      },
      userB: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true, customStatus: true },
      },
    },
  });

  const friends = friendships.map((f) => {
    const friend = f.userAId === req.user!.id ? f.userB : f.userA;
    return { ...friend, friendshipId: f.id, since: f.createdAt };
  });

  res.json({ friends });
});

// ─── GET /friends/requests ────────────────────────────────────────────────────

router.get("/requests", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const [incoming, outgoing] = await Promise.all([
    prisma.friendRequest.findMany({
      where: { receiverId: req.user!.id, status: "PENDING" },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.friendRequest.findMany({
      where: { senderId: req.user!.id, status: "PENDING" },
      include: {
        receiver: {
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.json({ incoming, outgoing });
});

// ─── POST /friends/request ────────────────────────────────────────────────────

router.post("/request", requireAuth, friendRequestLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.body;

  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "userId is required." } });
    return;
  }

  if (userId === req.user!.id) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "You cannot send a friend request to yourself." } });
    return;
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: userId },
    include: { settings: true },
  });

  if (!targetUser) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  if (targetUser.settings?.allowFriendRequestsFrom === "none") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "This user is not accepting friend requests." } });
    return;
  }

  // Check block status
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: req.user!.id, blockedId: userId },
        { blockerId: userId, blockedId: req.user!.id },
      ],
    },
  });

  if (block) {
    res.status(403).json({ error: { code: "BLOCKED", message: "Unable to send friend request." } });
    return;
  }

  // Check existing friendship
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userAId: req.user!.id, userBId: userId },
        { userAId: userId, userBId: req.user!.id },
      ],
    },
  });

  if (existing) {
    res.status(409).json({ error: { code: "ALREADY_FRIENDS", message: "You are already friends with this user." } });
    return;
  }

  // Check for existing pending request in opposite direction
  const reverseRequest = await prisma.friendRequest.findUnique({
    where: { senderId_receiverId: { senderId: userId, receiverId: req.user!.id } },
  });

  if (reverseRequest?.status === "PENDING") {
    // Auto-accept since both parties want to be friends
    const friendship = await prisma.$transaction(async (tx) => {
      await tx.friendRequest.update({
        where: { id: reverseRequest.id },
        data: { status: "ACCEPTED" },
      });

      return tx.friendship.create({
        data: { userAId: userId, userBId: req.user!.id },
        include: {
          userA: { select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true } },
          userB: { select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true } },
        },
      });
    });

    const io = getIO();
    io?.to(`user:${userId}`).emit("friend:accepted", {
      friendship,
      friend: friendship.userB,
    });

    res.json({ friendship, autoAccepted: true });
    return;
  }

  const request = await prisma.friendRequest.upsert({
    where: { senderId_receiverId: { senderId: req.user!.id, receiverId: userId } },
    create: { senderId: req.user!.id, receiverId: userId, status: "PENDING" },
    update: { status: "PENDING", updatedAt: new Date() },
    include: {
      sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });

  // Notify recipient
  const io = getIO();
  io?.to(`user:${userId}`).emit("friend:request", { request });

  // Create notification
  await prisma.notification.create({
    data: {
      userId,
      type: "FRIEND_REQUEST",
      title: "New Friend Request",
      body: `${req.user!.displayName} sent you a friend request.`,
      actionUrl: `/app/friends`,
    },
  });

  res.status(201).json({ request });
});

// ─── POST /friends/:requestId/accept ─────────────────────────────────────────

router.post("/:requestId/accept", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const request = await prisma.friendRequest.findFirst({
    where: { id: req.params.requestId, receiverId: req.user!.id, status: "PENDING" },
    include: {
      sender: { select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true, customStatus: true } },
      receiver: { select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true, customStatus: true } },
    },
  });

  if (!request) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Friend request not found." } });
    return;
  }

  const friendship = await prisma.$transaction(async (tx) => {
    await tx.friendRequest.update({
      where: { id: request.id },
      data: { status: "ACCEPTED" },
    });

    return tx.friendship.create({
      data: { userAId: request.senderId, userBId: req.user!.id },
    });
  });

  const io = getIO();
  io?.to(`user:${request.senderId}`).emit("friend:accepted", {
    friendship,
    friend: request.receiver,
  });

  await prisma.notification.create({
    data: {
      userId: request.senderId,
      type: "FRIEND_ACCEPTED",
      title: "Friend Request Accepted",
      body: `${request.receiver.displayName} accepted your friend request.`,
      actionUrl: `/users/${request.receiver.username}`,
    },
  });

  res.json({ friendship, friend: request.sender });
});

// ─── POST /friends/:requestId/reject ─────────────────────────────────────────

router.post("/:requestId/reject", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const request = await prisma.friendRequest.findFirst({
    where: { id: req.params.requestId, receiverId: req.user!.id, status: "PENDING" },
  });

  if (!request) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Friend request not found." } });
    return;
  }

  await prisma.friendRequest.update({
    where: { id: request.id },
    data: { status: "REJECTED" },
  });

  res.json({ message: "Friend request rejected." });
});

// ─── DELETE /friends/:userId ──────────────────────────────────────────────────

router.delete("/:userId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;

  const friendship = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userAId: req.user!.id, userBId: userId },
        { userAId: userId, userBId: req.user!.id },
      ],
    },
  });

  if (!friendship) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Friendship not found." } });
    return;
  }

  await prisma.friendship.delete({ where: { id: friendship.id } });

  const io = getIO();
  io?.to(`user:${userId}`).emit("friend:removed", { userId: req.user!.id });

  res.json({ message: "Friend removed." });
});

// ─── POST /blocks/:userId ─────────────────────────────────────────────────────

router.post("/blocks/:userId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.params;

  if (userId === req.user!.id) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "You cannot block yourself." } });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Create block
    await tx.block.upsert({
      where: { blockerId_blockedId: { blockerId: req.user!.id, blockedId: userId } },
      create: { blockerId: req.user!.id, blockedId: userId },
      update: {},
    });

    // Remove existing friendship
    await tx.friendship.deleteMany({
      where: {
        OR: [
          { userAId: req.user!.id, userBId: userId },
          { userAId: userId, userBId: req.user!.id },
        ],
      },
    });

    // Cancel pending friend requests
    await tx.friendRequest.deleteMany({
      where: {
        OR: [
          { senderId: req.user!.id, receiverId: userId },
          { senderId: userId, receiverId: req.user!.id },
        ],
      },
    });
  });

  res.json({ message: "User blocked." });
});

// ─── DELETE /blocks/:userId ───────────────────────────────────────────────────

router.delete("/blocks/:userId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await prisma.block.deleteMany({
    where: { blockerId: req.user!.id, blockedId: req.params.userId },
  });

  res.json({ message: "User unblocked." });
});

// ─── GET /blocks ──────────────────────────────────────────────────────────────

router.get("/blocks", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const blocks = await prisma.block.findMany({
    where: { blockerId: req.user!.id },
    include: {
      blocked: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({ blocks: blocks.map((b) => ({ ...b.blocked, blockedAt: b.createdAt })) });
});

export default router;
