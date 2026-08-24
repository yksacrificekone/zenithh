import { Router, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { DEFAULT_PERMISSIONS, Permissions, hasPermission } from "../lib/permissions";
import rateLimit from "express-rate-limit";
import { getIO } from "../socket";

const router = Router();

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: { code: "RATE_LIMITED", message: "Too many communities created." } },
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createCommunitySchema = z.object({
  name: z.string().min(2).max(100).trim(),
  description: z.string().max(1000).optional(),
  isDiscoverable: z.boolean().default(true),
});

const updateCommunitySchema = z.object({
  name: z.string().min(2).max(100).trim().optional(),
  description: z.string().max(1000).optional().nullable(),
  isDiscoverable: z.boolean().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function getMemberPermissions(userId: string, communityId: string): Promise<bigint | null> {
  const membership = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId, communityId } },
    include: {
      roles: {
        include: { role: { select: { permissions: true } } },
      },
      community: { select: { ownerId: true } },
    },
  });

  if (!membership) return null;
  if (membership.community.ownerId === userId) return BigInt("0x7FFFFFFF"); // full perms for owner

  const perms = membership.roles.reduce((acc, rm) => acc | BigInt(rm.role.permissions), 0n);
  return perms || DEFAULT_PERMISSIONS;
}

async function requireCommunityPermission(
  userId: string,
  communityId: string,
  permission: bigint,
  res: Response
): Promise<bigint | null> {
  const perms = await getMemberPermissions(userId, communityId);

  if (perms === null) {
    res.status(403).json({ error: { code: "NOT_MEMBER", message: "You are not a member of this community." } });
    return null;
  }

  if (!hasPermission(perms, permission)) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission to perform this action." } });
    return null;
  }

  return perms;
}

// ─── POST /communities ────────────────────────────────────────────────────────

router.post("/", requireAuth, createLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = createCommunitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const { name, description, isDiscoverable } = parsed.data;
  let slug = slugify(name);

  // Ensure unique slug
  const existing = await prisma.community.findUnique({ where: { slug } });
  if (existing) {
    slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  }

  const community = await prisma.$transaction(async (tx) => {
    const newCommunity = await tx.community.create({
      data: {
        name,
        slug,
        description: description || null,
        isDiscoverable,
        ownerId: req.user!.id,
      },
    });

    // Create default @everyone role
    const everyoneRole = await tx.role.create({
      data: {
        communityId: newCommunity.id,
        name: "@everyone",
        position: 0,
        permissions: DEFAULT_PERMISSIONS,
        isDefault: true,
      },
    });

    // Create default channels
    const generalChannel = await tx.channel.create({
      data: {
        communityId: newCommunity.id,
        name: "general",
        type: "TEXT",
        position: 0,
        category: "Text Channels",
      },
    });

    await tx.channel.create({
      data: {
        communityId: newCommunity.id,
        name: "voice-general",
        type: "VOICE",
        position: 1,
        category: "Voice Channels",
      },
    });

    // Add owner as member
    await tx.communityMember.create({
      data: { userId: req.user!.id, communityId: newCommunity.id },
    });

    return { ...newCommunity, channels: [generalChannel], defaultChannelId: generalChannel.id };
  });

  res.status(201).json({ community });
});

// ─── GET /communities/discover ────────────────────────────────────────────────

router.get("/discover", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const query = String(req.query.q || "").trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const skip = (page - 1) * limit;

  const where: any = { isDiscoverable: true };
  if (query) {
    where.OR = [
      { name: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
    ];
  }

  const [communities, total] = await Promise.all([
    prisma.community.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        iconUrl: true,
        bannerUrl: true,
        memberCount: true,
        createdAt: true,
        _count: { select: { members: true } },
      },
      orderBy: { memberCount: "desc" },
      skip,
      take: limit,
    }),
    prisma.community.count({ where }),
  ]);

  res.json({ communities, total, page, pages: Math.ceil(total / limit) });
});

// ─── GET /communities/:id ─────────────────────────────────────────────────────

router.get("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const community = await prisma.community.findFirst({
    where: {
      OR: [{ id: req.params.id }, { slug: req.params.id }],
    },
    include: {
      owner: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      channels: { orderBy: [{ category: "asc" }, { position: "asc" }] },
      roles: { orderBy: { position: "desc" } },
      _count: { select: { members: true } },
    },
  });

  if (!community) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Community not found." } });
    return;
  }

  // Verify membership for private communities
  const membership = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId: req.user!.id, communityId: community.id } },
    include: { roles: { include: { role: true } } },
  });

  if (!community.isDiscoverable && !membership) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Community not found." } });
    return;
  }

  res.json({ community, membership });
});

// ─── PATCH /communities/:id ───────────────────────────────────────────────────

router.patch("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = updateCommunitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const perms = await requireCommunityPermission(req.user!.id, req.params.id, Permissions.MANAGE_COMMUNITY, res);
  if (!perms) return;

  const community = await prisma.community.update({
    where: { id: req.params.id },
    data: { ...parsed.data },
  });

  const io = getIO();
  io?.to(`community:${community.id}`).emit("community:update", { community });

  res.json({ community });
});

// ─── DELETE /communities/:id ──────────────────────────────────────────────────

router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const community = await prisma.community.findUnique({
    where: { id: req.params.id },
  });

  if (!community) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Community not found." } });
    return;
  }

  if (community.ownerId !== req.user!.id && req.user!.role !== "ADMIN") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Only the community owner can delete this community." } });
    return;
  }

  const { confirmation } = req.body;
  if (confirmation !== community.name) {
    res.status(400).json({ error: { code: "CONFIRMATION_REQUIRED", message: `Type "${community.name}" to confirm.` } });
    return;
  }

  await prisma.community.delete({ where: { id: community.id } });

  const io = getIO();
  io?.to(`community:${community.id}`).emit("community:delete", { communityId: community.id });

  res.json({ message: "Community deleted." });
});

// ─── POST /communities/:id/join ───────────────────────────────────────────────

router.post("/:id/join", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const community = await prisma.community.findUnique({
    where: { id: req.params.id },
    include: { roles: { where: { isDefault: true } } },
  });

  if (!community || !community.isDiscoverable) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Community not found." } });
    return;
  }

  const existing = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId: req.user!.id, communityId: community.id } },
  });

  if (existing) {
    res.status(409).json({ error: { code: "ALREADY_MEMBER", message: "You are already a member of this community." } });
    return;
  }

  const membership = await prisma.$transaction(async (tx) => {
    const member = await tx.communityMember.create({
      data: { userId: req.user!.id, communityId: community.id },
    });

    // Assign default role if exists
    const defaultRole = community.roles[0];
    if (defaultRole) {
      await tx.roleMember.create({
        data: { roleId: defaultRole.id, memberId: member.id },
      });
    }

    await tx.community.update({
      where: { id: community.id },
      data: { memberCount: { increment: 1 } },
    });

    return member;
  });

  const io = getIO();
  io?.to(`community:${community.id}`).emit("member:join", {
    communityId: community.id,
    user: { id: req.user!.id, username: req.user!.username, displayName: req.user!.displayName, avatarUrl: req.user!.avatarUrl },
  });

  res.status(201).json({ membership });
});

// ─── POST /communities/:id/leave ──────────────────────────────────────────────

router.post("/:id/leave", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const community = await prisma.community.findUnique({ where: { id: req.params.id } });

  if (!community) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Community not found." } });
    return;
  }

  if (community.ownerId === req.user!.id) {
    res.status(400).json({ error: { code: "OWNER_CANNOT_LEAVE", message: "Transfer ownership before leaving." } });
    return;
  }

  const membership = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId: req.user!.id, communityId: community.id } },
  });

  if (!membership) {
    res.status(404).json({ error: { code: "NOT_MEMBER", message: "You are not a member of this community." } });
    return;
  }

  await prisma.$transaction([
    prisma.communityMember.delete({ where: { id: membership.id } }),
    prisma.community.update({
      where: { id: community.id },
      data: { memberCount: { decrement: 1 } },
    }),
  ]);

  const io = getIO();
  io?.to(`community:${community.id}`).emit("member:leave", {
    communityId: community.id,
    userId: req.user!.id,
  });

  res.json({ message: "Left community." });
});

// ─── GET /communities/:id/members ─────────────────────────────────────────────

router.get("/:id/members", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const membership = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId: req.user!.id, communityId: req.params.id } },
  });

  if (!membership) {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Not a member." } });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const members = await prisma.communityMember.findMany({
    where: { communityId: req.params.id },
    include: {
      user: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, presence: true, customStatus: true },
      },
      roles: { include: { role: { select: { id: true, name: true, color: true, position: true } } } },
    },
    take: limit,
    orderBy: { joinedAt: "asc" },
  });

  res.json({ members });
});

// ─── POST /communities/invite/:code/join ──────────────────────────────────────

router.post("/invite/:code/join", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const invite = await prisma.invite.findUnique({
    where: { code: req.params.code },
    include: {
      community: { include: { roles: { where: { isDefault: true } } } },
    },
  });

  if (!invite || invite.isRevoked) {
    res.status(404).json({ error: { code: "INVALID_INVITE", message: "Invite link is invalid or revoked." } });
    return;
  }

  if (invite.expiresAt && invite.expiresAt < new Date()) {
    res.status(410).json({ error: { code: "INVITE_EXPIRED", message: "This invite link has expired." } });
    return;
  }

  if (invite.maxUses && invite.useCount >= invite.maxUses) {
    res.status(410).json({ error: { code: "INVITE_MAXED", message: "This invite link has reached its maximum uses." } });
    return;
  }

  const existing = await prisma.communityMember.findUnique({
    where: { userId_communityId: { userId: req.user!.id, communityId: invite.communityId } },
  });

  if (existing) {
    res.json({ community: invite.community, alreadyMember: true });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const member = await tx.communityMember.create({
      data: { userId: req.user!.id, communityId: invite.communityId },
    });

    const defaultRole = invite.community.roles[0];
    if (defaultRole) {
      await tx.roleMember.create({ data: { roleId: defaultRole.id, memberId: member.id } });
    }

    await tx.invite.update({
      where: { id: invite.id },
      data: { useCount: { increment: 1 } },
    });

    await tx.community.update({
      where: { id: invite.communityId },
      data: { memberCount: { increment: 1 } },
    });
  });

  res.json({ community: invite.community });
});

// ─── POST /communities/:id/invites ────────────────────────────────────────────

router.post("/:id/invites", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const perms = await requireCommunityPermission(req.user!.id, req.params.id, Permissions.MANAGE_INVITES, res);
  if (!perms) return;

  const { maxUses, expiresIn } = req.body;
  const code = crypto.randomBytes(6).toString("base64url");

  const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000) : null;

  const invite = await prisma.invite.create({
    data: {
      code,
      communityId: req.params.id,
      creatorId: req.user!.id,
      maxUses: maxUses || null,
      expiresAt,
    },
  });

  res.status(201).json({ invite });
});

export default router;
