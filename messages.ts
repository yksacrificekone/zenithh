import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { Permissions, hasPermission, DEFAULT_PERMISSIONS } from "../lib/permissions";
import { getIO } from "../socket";
import rateLimit from "express-rate-limit";

const router = Router();

const messageLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
  message: { error: { code: "RATE_LIMITED", message: "Sending messages too quickly." } },
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  content: z.string().min(1, "Message cannot be empty.").max(4000, "Message too long.").trim(),
  replyToId: z.string().optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(4000).trim(),
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(64),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  dmId: true,
  content: true,
  isEdited: true,
  isDeleted: true,
  replyToId: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: { id: true, username: true, displayName: true, avatarUrl: true },
  },
  replyTo: {
    select: {
      id: true,
      content: true,
      isDeleted: true,
      author: { select: { id: true, username: true, displayName: true } },
    },
  },
  reactions: {
    select: {
      emoji: true,
      userId: true,
      user: { select: { id: true, username: true } },
    },
  },
  attachments: {
    select: { id: true, url: true, filename: true, mimeType: true, size: true, width: true, height: true },
  },
} as const;

async function getChannelPerms(userId: string, channelId: string) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { community: { select: { ownerId: true } } },
  });
  if (!channel) return null;

  if (channel.community.ownerId === userId) {
    return { channel, perms: BigInt("0x7FFFFFFF") };
  }

  const membership = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId, communityId: channel.communityId } },
    include: { roles: { include: { role: { select: { permissions: true } } } } },
  });

  if (!membership) return null;

  const perms = membership.roles.reduce((acc, rm) => acc | BigInt(rm.role.permissions), DEFAULT_PERMISSIONS);
  return { channel, perms };
}

function serializeMessage(msg: any, requesterId: string) {
  if (msg.isDeleted) {
    return {
      id: msg.id,
      channelId: msg.channelId,
      dmId: msg.dmId,
      content: null,
      isDeleted: true,
      isEdited: false,
      createdAt: msg.createdAt,
      author: msg.author,
      reactions: [],
      attachments: [],
      replyToId: msg.replyToId,
      replyTo: null,
    };
  }

  // Group reactions
  const grouped: Record<string, { emoji: string; count: number; userIds: string[]; me: boolean }> = {};
  for (const r of msg.reactions) {
    if (!grouped[r.emoji]) {
      grouped[r.emoji] = { emoji: r.emoji, count: 0, userIds: [], me: false };
    }
    grouped[r.emoji].count++;
    grouped[r.emoji].userIds.push(r.userId);
    if (r.userId === requesterId) grouped[r.emoji].me = true;
  }

  return {
    ...msg,
    reactions: Object.values(grouped),
  };
}

// ─── GET /channels/:channelId/messages ───────────────────────────────────────

router.get("/:channelId/messages", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const result = await getChannelPerms(req.user!.id, req.params.channelId);
  if (!result || !hasPermission(result.perms, Permissions.VIEW_CHANNELS)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "No access to this channel." } });
    return;
  }

  if (!hasPermission(result.perms, Permissions.READ_MESSAGE_HISTORY)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Cannot read message history." } });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before as string | undefined;

  const messages = await prisma.message.findMany({
    where: {
      channelId: req.params.channelId,
      ...(before ? { createdAt: { lt: (await prisma.message.findUnique({ where: { id: before } }))?.createdAt } } : {}),
    },
    select: MESSAGE_SELECT,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const serialized = messages.reverse().map((m) => serializeMessage(m, req.user!.id));

  res.json({ messages: serialized, hasMore: messages.length === limit });
});

// ─── POST /channels/:channelId/messages ──────────────────────────────────────

router.post("/:channelId/messages", requireAuth, messageLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const result = await getChannelPerms(req.user!.id, req.params.channelId);
  if (!result || !hasPermission(result.perms, Permissions.VIEW_CHANNELS)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "No access to this channel." } });
    return;
  }

  if (!hasPermission(result.perms, Permissions.SEND_MESSAGES)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "You cannot send messages here." } });
    return;
  }

  // Announcement channel check
  if (result.channel.type === "ANNOUNCEMENT" && !hasPermission(result.perms, Permissions.MANAGE_MESSAGES)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Only moderators can post in announcement channels." } });
    return;
  }

  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  // Slow mode check
  if (result.channel.slowModeSeconds > 0) {
    const recentMessage = await prisma.message.findFirst({
      where: {
        channelId: req.params.channelId,
        authorId: req.user!.id,
        createdAt: { gte: new Date(Date.now() - result.channel.slowModeSeconds * 1000) },
      },
    });

    if (recentMessage && !hasPermission(result.perms, Permissions.MANAGE_MESSAGES)) {
      res.status(429).json({ error: { code: "SLOW_MODE", message: `Wait ${result.channel.slowModeSeconds} seconds before sending another message.` } });
      return;
    }
  }

  // Validate reply
  if (parsed.data.replyToId) {
    const replyTarget = await prisma.message.findUnique({
      where: { id: parsed.data.replyToId, channelId: req.params.channelId },
    });
    if (!replyTarget) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Reply target not found." } });
      return;
    }
  }

  const message = await prisma.message.create({
    data: {
      channelId: req.params.channelId,
      authorId: req.user!.id,
      content: parsed.data.content,
      replyToId: parsed.data.replyToId || null,
    },
    select: MESSAGE_SELECT,
  });

  const serialized = serializeMessage(message, req.user!.id);

  const io = getIO();
  io?.to(`channel:${req.params.channelId}`).emit("message:create", { message: serialized });

  res.status(201).json({ message: serialized });
});

// ─── PATCH /messages/:messageId ───────────────────────────────────────────────

router.patch("/:messageId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const message = await prisma.message.findUnique({ where: { id: req.params.messageId } });

  if (!message || message.isDeleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Message not found." } });
    return;
  }

  if (message.authorId !== req.user!.id) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "You can only edit your own messages." } });
    return;
  }

  const parsed = editMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { content: parsed.data.content, isEdited: true },
    select: MESSAGE_SELECT,
  });

  const serialized = serializeMessage(updated, req.user!.id);

  const io = getIO();
  const room = updated.channelId ? `channel:${updated.channelId}` : `dm:${updated.dmId}`;
  io?.to(room).emit("message:update", { message: serialized });

  res.json({ message: serialized });
});

// ─── DELETE /messages/:messageId ──────────────────────────────────────────────

router.delete("/:messageId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const message = await prisma.message.findUnique({
    where: { id: req.params.messageId },
    include: { channel: { select: { communityId: true } } },
  });

  if (!message || message.isDeleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Message not found." } });
    return;
  }

  const isAuthor = message.authorId === req.user!.id;

  if (!isAuthor && message.channelId) {
    const result = await getChannelPerms(req.user!.id, message.channelId);
    if (!result || !hasPermission(result.perms, Permissions.MANAGE_MESSAGES)) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Cannot delete this message." } });
      return;
    }
  } else if (!isAuthor) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Cannot delete this message." } });
    return;
  }

  await prisma.message.update({
    where: { id: message.id },
    data: { isDeleted: true, content: "" },
  });

  const io = getIO();
  const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmId}`;
  io?.to(room).emit("message:delete", { messageId: message.id });

  res.json({ message: "Message deleted." });
});

// ─── POST /messages/:messageId/reactions ──────────────────────────────────────

router.post("/:messageId/reactions", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = reactionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid emoji." } });
    return;
  }

  const message = await prisma.message.findUnique({
    where: { id: req.params.messageId },
  });

  if (!message || message.isDeleted) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Message not found." } });
    return;
  }

  // Verify access
  if (message.channelId) {
    const result = await getChannelPerms(req.user!.id, message.channelId);
    if (!result || !hasPermission(result.perms, Permissions.ADD_REACTIONS)) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Cannot add reactions here." } });
      return;
    }
  }

  const existing = await prisma.messageReaction.findUnique({
    where: {
      messageId_userId_emoji: {
        messageId: message.id,
        userId: req.user!.id,
        emoji: parsed.data.emoji,
      },
    },
  });

  if (existing) {
    // Toggle off
    await prisma.messageReaction.delete({ where: { id: existing.id } });

    const io = getIO();
    const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmId}`;
    io?.to(room).emit("message:reaction", {
      messageId: message.id,
      emoji: parsed.data.emoji,
      userId: req.user!.id,
      action: "remove",
    });

    res.json({ removed: true });
  } else {
    const reaction = await prisma.messageReaction.create({
      data: { messageId: message.id, userId: req.user!.id, emoji: parsed.data.emoji },
    });

    const io = getIO();
    const room = message.channelId ? `channel:${message.channelId}` : `dm:${message.dmId}`;
    io?.to(room).emit("message:reaction", {
      messageId: message.id,
      emoji: parsed.data.emoji,
      userId: req.user!.id,
      action: "add",
    });

    res.status(201).json({ reaction });
  }
});

export default router;
