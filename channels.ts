import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { Permissions, hasPermission, DEFAULT_PERMISSIONS } from "../lib/permissions";

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-_]+$/, "Channel name may only contain lowercase letters, numbers, hyphens, and underscores."),
  type: z.enum(["TEXT", "VOICE", "ANNOUNCEMENT"]).default("TEXT"),
  topic: z.string().max(1024).optional(),
  category: z.string().max(100).optional(),
  isPrivate: z.boolean().default(false),
  slowModeSeconds: z.number().int().min(0).max(21600).default(0),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).max(100).trim().toLowerCase().optional(),
  topic: z.string().max(1024).optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  position: z.number().int().optional(),
  isPrivate: z.boolean().optional(),
  slowModeSeconds: z.number().int().min(0).max(21600).optional(),
  nsfw: z.boolean().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getMemberPerms(userId: string, communityId: string): Promise<{ perms: bigint; isOwner: boolean } | null> {
  const community = await prisma.community.findUnique({ where: { id: communityId } });
  if (!community) return null;

  if (community.ownerId === userId) {
    return { perms: BigInt("0x7FFFFFFF"), isOwner: true };
  }

  const membership = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId, communityId } },
    include: { roles: { include: { role: { select: { permissions: true } } } } },
  });

  if (!membership) return null;

  const perms = membership.roles.reduce((acc, rm) => acc | BigInt(rm.role.permissions), DEFAULT_PERMISSIONS);
  return { perms, isOwner: false };
}

// ─── POST /communities/:communityId/channels ──────────────────────────────────

router.post("/communities/:communityId/channels", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const permsResult = await getMemberPerms(req.user!.id, req.params.communityId);

  if (!permsResult || !hasPermission(permsResult.perms, Permissions.MANAGE_CHANNELS)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Insufficient permissions." } });
    return;
  }

  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  // Get next position in category
  const lastChannel = await prisma.channel.findFirst({
    where: { communityId: req.params.communityId, category: parsed.data.category || null },
    orderBy: { position: "desc" },
  });

  const channel = await prisma.channel.create({
    data: {
      ...parsed.data,
      communityId: req.params.communityId,
      position: (lastChannel?.position ?? -1) + 1,
    },
  });

  res.status(201).json({ channel });
});

// ─── PATCH /channels/:channelId ───────────────────────────────────────────────

router.patch("/:channelId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
  if (!channel) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Channel not found." } });
    return;
  }

  const permsResult = await getMemberPerms(req.user!.id, channel.communityId);
  if (!permsResult || !hasPermission(permsResult.perms, Permissions.MANAGE_CHANNELS)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Insufficient permissions." } });
    return;
  }

  const parsed = updateChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const updated = await prisma.channel.update({
    where: { id: channel.id },
    data: parsed.data,
  });

  res.json({ channel: updated });
});

// ─── DELETE /channels/:channelId ──────────────────────────────────────────────

router.delete("/:channelId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
  if (!channel) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Channel not found." } });
    return;
  }

  const permsResult = await getMemberPerms(req.user!.id, channel.communityId);
  if (!permsResult || !hasPermission(permsResult.perms, Permissions.MANAGE_CHANNELS)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Insufficient permissions." } });
    return;
  }

  // Ensure at least one text channel remains
  const textChannelCount = await prisma.channel.count({
    where: { communityId: channel.communityId, type: "TEXT" },
  });

  if (channel.type === "TEXT" && textChannelCount <= 1) {
    res.status(400).json({ error: { code: "LAST_CHANNEL", message: "Cannot delete the last text channel." } });
    return;
  }

  await prisma.channel.delete({ where: { id: channel.id } });

  res.json({ message: "Channel deleted." });
});

// ─── GET /channels/:channelId ─────────────────────────────────────────────────

router.get("/:channelId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const channel = await prisma.channel.findUnique({
    where: { id: req.params.channelId },
    include: { community: { select: { id: true, name: true, ownerId: true } } },
  });

  if (!channel) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Channel not found." } });
    return;
  }

  const permsResult = await getMemberPerms(req.user!.id, channel.communityId);
  if (!permsResult || !hasPermission(permsResult.perms, Permissions.VIEW_CHANNELS)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have access to this channel." } });
    return;
  }

  res.json({ channel });
});

export default router;
