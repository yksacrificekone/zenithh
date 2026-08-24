import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { getIO } from "../socket";
import rateLimit from "express-rate-limit";

const router = Router();

const messageLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
  message: { error: { code: "RATE_LIMITED", message: "Sending messages too quickly." } },
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(4000).trim(),
  replyToId: z.string().optional(),
});

const createGroupSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  memberIds: z.array(z.string()).min(1).max(9),
});

const DM_MESSAGE_SELECT = {
  id: true,
  dmId: true,
  channelId: true,
  content: true,
  isEdited: true,
  isDeleted: true,
  replyToId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  replyTo: {
    select: {
      id: true,
      content: true,
      isDeleted: true,
      author: { select: { id: true, username: true, displayName: true } },
    },
  },
  reactions: {
    select: { emoji: true, userId: true },
  },
  attachments: {
    select: { id: true, url: true, filename: true, mimeType: true, size: true, width: true, height: true },
  },
} as const;

async function verifyDmAccess(userId: string, conversationId: string) {
  return prisma.directConversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

function serializeDmMessage(msg: any, requesterId: string) {
  const grouped: Record<string, { emoji: string; count: number; me: boolean }> = {};
  for (const r of msg.reactions) {
    if (!grouped[r.emoji]) grouped[r.emoji] = { emoji: r.emoji, count: 0, me: false };
    grouped[r.emoji].count++;
    if (r.userId === requesterId) grouped[r.emoji].me = true;
  }
  return { ...msg, reactions: Object.values(grouped) };
}

// ─── GET /dm ──────────────────────────────────────────────────────────────────

router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const memberships = await prisma.directConversationMember.findMany({
    where: { userId: req.user!.id },
    include: {
      conversation: {
        include: {
          members: {
            include: {
              user: { select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true } },
            },
          },
        },
      },
    },
    orderBy: { conversation: { updatedAt: "desc" } },
  });

  const conversations = memberships.map((m) => {
    const conv = m.conversation;
    const otherMembers = conv.members.filter((cm) => cm.userId !== req.user!.id);
    return {
      id: conv.id,
      isGroup: conv.isGroup,
      name: conv.isGroup ? conv.name : otherMembers[0]?.user.displayName,
      iconUrl: conv.isGroup ? conv.iconUrl : otherMembers[0]?.user.avatarUrl,
      members: conv.members.map((cm) => cm.user),
      updatedAt: conv.updatedAt,
      lastReadAt: m.lastReadAt,
    };
  });

  res.json({ conversations });
});

// ─── POST /dm ─────────────────────────────────────────────────────────────────

router.post("/", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { userId } = req.body;

  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "userId is required." } });
    return;
  }

  if (userId === req.user!.id) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Cannot DM yourself." } });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: userId }, include: { settings: true } });
  if (!target) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  // Check block
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: req.user!.id, blockedId: userId },
        { blockerId: userId, blockedId: req.user!.id },
      ],
    },
  });

  if (block) {
    res.status(403).json({ error: { code: "BLOCKED", message: "Cannot send a message to this user." } });
    return;
  }

  // DM privacy check
  if (target.settings?.allowDMsFrom === "none") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "This user is not accepting direct messages." } });
    return;
  }

  if (target.settings?.allowDMsFrom === "friends") {
    const isFriend = await prisma.friendship.findFirst({
      where: {
        OR: [
          { userAId: req.user!.id, userBId: userId },
          { userAId: userId, userBId: req.user!.id },
        ],
      },
    });

    if (!isFriend) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "This user only accepts DMs from friends." } });
      return;
    }
  }

  // Find or create conversation
  const existing = await prisma.directConversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { members: { some: { userId: req.user!.id } } },
        { members: { some: { userId } } },
      ],
    },
  });

  if (existing) {
    res.json({ conversation: existing });
    return;
  }

  const conversation = await prisma.$transaction(async (tx) => {
    const conv = await tx.directConversation.create({
      data: { isGroup: false },
    });

    await tx.directConversationMember.createMany({
      data: [
        { conversationId: conv.id, userId: req.user!.id },
        { conversationId: conv.id, userId },
      ],
    });

    return conv;
  });

  res.status(201).json({ conversation });
});

// ─── POST /dm/group ───────────────────────────────────────────────────────────

router.post("/group", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const memberIds = [...new Set([req.user!.id, ...parsed.data.memberIds])];

  const conversation = await prisma.$transaction(async (tx) => {
    const conv = await tx.directConversation.create({
      data: {
        isGroup: true,
        name: parsed.data.name,
        ownerId: req.user!.id,
      },
    });

    await tx.directConversationMember.createMany({
      data: memberIds.map((userId) => ({ conversationId: conv.id, userId })),
    });

    return conv;
  });

  res.status(201).json({ conversation });
});

// ─── GET /dm/:conversationId/messages ─────────────────────────────────────────

router.get("/:conversationId/messages", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const access = await verifyDmAccess(req.user!.id, req.params.conversationId);
  if (!access) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "No access to this conversation." } });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before as string | undefined;

  const messages = await prisma.message.findMany({
    where: {
      dmId: req.params.conversationId,
      ...(before ? { createdAt: { lt: (await prisma.message.findUnique({ where: { id: before } }))?.createdAt } } : {}),
    },
    select: DM_MESSAGE_SELECT,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const serialized = messages.reverse().map((m) => serializeDmMessage(m, req.user!.id));
  res.json({ messages: serialized, hasMore: messages.length === limit });
});

// ─── POST /dm/:conversationId/messages ────────────────────────────────────────

router.post("/:conversationId/messages", requireAuth, messageLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const access = await verifyDmAccess(req.user!.id, req.params.conversationId);
  if (!access) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "No access to this conversation." } });
    return;
  }

  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const message = await prisma.message.create({
    data: {
      dmId: req.params.conversationId,
      authorId: req.user!.id,
      content: parsed.data.content,
      replyToId: parsed.data.replyToId || null,
    },
    select: DM_MESSAGE_SELECT,
  });

  await prisma.directConversation.update({
    where: { id: req.params.conversationId },
    data: { updatedAt: new Date() },
  });

  const serialized = serializeDmMessage(message, req.user!.id);

  const io = getIO();
  io?.to(`dm:${req.params.conversationId}`).emit("message:create", { message: serialized });

  res.status(201).json({ message: serialized });
});

export default router;
