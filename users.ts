import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import rateLimit from "express-rate-limit";

const router = Router();

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: { code: "RATE_LIMITED", message: "Too many search requests." } },
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(64).trim().optional(),
  bio: z.string().max(500).optional().nullable(),
  pronouns: z.string().max(32).optional().nullable(),
  customStatus: z.string().max(128).optional().nullable(),
  presence: z.enum(["ONLINE", "IDLE", "DO_NOT_DISTURB", "INVISIBLE"]).optional(),
});

const updateSettingsSchema = z.object({
  theme: z.enum(["dark", "light", "system"]).optional(),
  reducedMotion: z.boolean().optional(),
  messageDisplayCompact: z.boolean().optional(),
  notifyDMs: z.boolean().optional(),
  notifyMentions: z.boolean().optional(),
  notifyFriendRequests: z.boolean().optional(),
  allowDMsFrom: z.enum(["everyone", "friends", "none"]).optional(),
  allowFriendRequestsFrom: z.enum(["everyone", "none"]).optional(),
  showPresence: z.boolean().optional(),
});

function publicUser(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    bio: user.bio,
    pronouns: user.pronouns,
    customStatus: user.customStatus,
    presence: user.presence,
    createdAt: user.createdAt,
  };
}

// ─── GET /users/me ────────────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { settings: true },
  });

  if (!user) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    bio: user.bio,
    pronouns: user.pronouns,
    customStatus: user.customStatus,
    presence: user.presence,
    role: user.role,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    settings: user.settings,
  });
});

// ─── PATCH /users/me ──────────────────────────────────────────────────────────

router.patch("/me", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { ...parsed.data, updatedAt: new Date() },
  });

  res.json(publicUser(user));
});

// ─── PATCH /users/me/settings ─────────────────────────────────────────────────

router.patch("/me/settings", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const settings = await prisma.userSettings.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id, ...parsed.data },
    update: { ...parsed.data },
  });

  res.json(settings);
});

// ─── GET /users/search ────────────────────────────────────────────────────────

router.get("/search", requireAuth, searchLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const query = String(req.query.q || "").trim().toLowerCase();
  if (!query || query.length < 2) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Search query must be at least 2 characters." } });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 20, 50);

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { displayName: { contains: query, mode: "insensitive" } },
      ],
      // Don't return the searching user
      NOT: { id: req.user!.id },
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatarUrl: true,
      presence: true,
      customStatus: true,
    },
    take: limit,
  });

  res.json({ users });
});

// ─── GET /users/:username ─────────────────────────────────────────────────────

router.get("/:username", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { username: req.params.username.toLowerCase() },
  });

  if (!user) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  // Check if requesting user is blocked
  const blocked = await prisma.block.findUnique({
    where: {
      blockerId_blockedId: {
        blockerId: user.id,
        blockedId: req.user!.id,
      },
    },
  });

  if (blocked) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  // Compute mutual context
  const [mutualFriends, mutualCommunities, friendStatus] = await Promise.all([
    prisma.friendship.count({
      where: {
        OR: [
          { userAId: req.user!.id, userBId: user.id },
          { userAId: user.id, userBId: req.user!.id },
        ],
      },
    }),
    prisma.communityMember.count({
      where: {
        communityId: {
          in: (
            await prisma.communityMember.findMany({
              where: { userId: req.user!.id },
              select: { communityId: true },
            })
          ).map((m) => m.communityId),
        },
        userId: user.id,
      },
    }),
    prisma.friendship.findFirst({
      where: {
        OR: [
          { userAId: req.user!.id, userBId: user.id },
          { userAId: user.id, userBId: req.user!.id },
        ],
      },
    }),
  ]);

  const isFriend = !!friendStatus;
  const presence = user.settings?.showPresence === false && !isFriend ? "OFFLINE" : user.presence;

  res.json({
    ...publicUser(user),
    presence,
    isFriend,
    mutualFriendCount: mutualFriends,
    mutualCommunityCount: mutualCommunities,
    createdAt: user.createdAt,
  });
});

// ─── DELETE /users/me ─────────────────────────────────────────────────────────

router.delete("/me", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const { confirmation } = req.body;

  if (confirmation !== req.user!.username) {
    res.status(400).json({
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: `Type your username "${req.user!.username}" to confirm account deletion.`,
      },
    });
    return;
  }

  // Anonymize user data rather than hard delete to preserve message context
  await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      username: `deleted_${Date.now()}`,
      displayName: "Deleted User",
      email: `deleted_${Date.now()}@zenith.deleted`,
      passwordHash: "DELETED",
      avatarUrl: null,
      bannerUrl: null,
      bio: null,
      pronouns: null,
      customStatus: null,
      presence: "OFFLINE",
    },
  });

  await prisma.session.deleteMany({ where: { userId: req.user!.id } });

  res.json({ message: "Account deleted." });
});

export default router;
