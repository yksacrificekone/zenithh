import { Router, Request, Response } from "express";
import { z } from "zod";
import argon2 from "argon2";
import crypto from "crypto";
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../lib/logger";
import rateLimit from "express-rate-limit";

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." } },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: { code: "RATE_LIMITED", message: "Too many registration attempts." } },
});

// ─── Schemas ──────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters.")
    .max(32, "Username cannot exceed 32 characters.")
    .regex(/^[a-zA-Z0-9_-]+$/, "Username may only contain letters, numbers, underscores, and hyphens."),
  displayName: z
    .string()
    .min(1, "Display name is required.")
    .max(64, "Display name cannot exceed 64 characters.")
    .trim(),
  email: z.string().email("Invalid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(128, "Password cannot exceed 128 characters.")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter.")
    .regex(/[0-9]/, "Password must contain at least one number."),
});

const loginSchema = z.object({
  login: z.string().min(1, "Username or email is required."),
  password: z.string().min(1, "Password is required."),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Z]/)
    .regex(/[0-9]/),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SESSION_EXPIRY_DAYS = 30;

async function createSession(userId: string, req: Request): Promise<string> {
  const token = crypto.randomBytes(48).toString("hex");
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_EXPIRY_DAYS);

  await prisma.session.create({
    data: {
      userId,
      token,
      userAgent: req.headers["user-agent"] || null,
      ipAddress: req.ip || null,
      expiresAt,
    },
  });

  return token;
}

function sanitizeUser(user: {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  pronouns: string | null;
  customStatus: string | null;
  presence: string;
  role: string;
  createdAt: Date;
}) {
  return {
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
  };
}

// ─── POST /auth/register ─────────────────────────────────────────────────────

router.post("/register", registerLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const { username, displayName, email, password } = parsed.data;

  const [existingUsername, existingEmail] = await Promise.all([
    prisma.user.findUnique({ where: { username: username.toLowerCase() } }),
    prisma.user.findUnique({ where: { email: email.toLowerCase() } }),
  ]);

  if (existingUsername) {
    res.status(409).json({ error: { code: "USERNAME_TAKEN", message: "Username is already taken." } });
    return;
  }

  if (existingEmail) {
    res.status(409).json({ error: { code: "EMAIL_TAKEN", message: "Email is already registered." } });
    return;
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1,
  });

  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        username: username.toLowerCase(),
        displayName,
        email: email.toLowerCase(),
        passwordHash,
        presence: "OFFLINE",
      },
    });

    // Create default settings
    await tx.userSettings.create({
      data: { userId: newUser.id },
    });

    return newUser;
  });

  const token = await createSession(user.id, req);

  logger.info(`New user registered: ${user.username}`);

  res.status(201).json({
    token,
    user: sanitizeUser(user),
  });
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

router.post("/login", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid credentials." } });
    return;
  }

  const { login, password } = parsed.data;
  const identifier = login.toLowerCase();

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { username: identifier },
        { email: identifier },
      ],
    },
  });

  if (!user) {
    // Constant-time response to prevent user enumeration
    await argon2.hash("dummy_password_to_prevent_timing_attacks");
    res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials." } });
    return;
  }

  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials." } });
    return;
  }

  const [token] = await Promise.all([
    createSession(user.id, req),
    prisma.user.update({
      where: { id: user.id },
      data: { presence: "ONLINE", lastSeenAt: new Date() },
    }),
  ]);

  logger.info(`User logged in: ${user.username}`);

  res.json({ token, user: sanitizeUser(user) });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

router.post("/logout", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const token = req.headers.authorization?.slice(7) ||
    (req as any).cookies?.zenith_session;

  if (token) {
    await prisma.session.deleteMany({ where: { token } });
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { presence: "OFFLINE", lastSeenAt: new Date() },
    });
  }

  res.json({ message: "Logged out successfully." });
});

// ─── POST /auth/logout-all ────────────────────────────────────────────────────

router.post("/logout-all", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await prisma.session.deleteMany({ where: { userId: req.user!.id } });
  res.json({ message: "All sessions terminated." });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: { settings: true },
  });

  if (!user) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  res.json({ user: sanitizeUser(user), settings: user.settings });
});

// ─── POST /auth/change-password ───────────────────────────────────────────────

router.post("/change-password", requireAuth, authLimiter, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message } });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "User not found." } });
    return;
  }

  const valid = await argon2.verify(user.passwordHash, parsed.data.currentPassword);
  if (!valid) {
    res.status(401).json({ error: { code: "INVALID_PASSWORD", message: "Current password is incorrect." } });
    return;
  }

  const newHash = await argon2.hash(parsed.data.newPassword, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1,
  });

  // Invalidate all other sessions
  const currentToken = req.headers.authorization?.slice(7);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } }),
    prisma.session.deleteMany({
      where: { userId: user.id, NOT: { token: currentToken } },
    }),
  ]);

  logger.info(`Password changed for user: ${user.username}`);
  res.json({ message: "Password changed successfully." });
});

// ─── POST /auth/forgot-password ───────────────────────────────────────────────

router.post("/forgot-password", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ message: "If that email exists, a reset link has been sent." });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
  });

  // Always respond the same to prevent email enumeration
  if (!user) {
    res.json({ message: "If that email exists, a reset link has been sent." });
    return;
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.passwordReset.create({
    data: { userId: user.id, tokenHash, expiresAt },
  });

  // TODO: Send email with rawToken
  // For development, return the token in the response
  const isDev = process.env.NODE_ENV === "development";
  logger.info(`Password reset token generated for ${user.email}${isDev ? `: ${rawToken}` : ""}`);

  res.json({
    message: "If that email exists, a reset link has been sent.",
    ...(isDev && { devToken: rawToken }),
  });
});

// ─── POST /auth/reset-password ────────────────────────────────────────────────

router.post("/reset-password", authLimiter, async (req: Request, res: Response): Promise<void> => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid request." } });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");

  const resetRecord = await prisma.passwordReset.findUnique({
    where: { tokenHash },
  });

  if (!resetRecord || resetRecord.usedAt || resetRecord.expiresAt < new Date()) {
    res.status(400).json({ error: { code: "INVALID_TOKEN", message: "Reset token is invalid or expired." } });
    return;
  }

  const newHash = await argon2.hash(parsed.data.newPassword, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1,
  });

  await prisma.$transaction([
    prisma.user.update({ where: { id: resetRecord.userId }, data: { passwordHash: newHash } }),
    prisma.passwordReset.update({ where: { id: resetRecord.id }, data: { usedAt: new Date() } }),
    prisma.session.deleteMany({ where: { userId: resetRecord.userId } }),
  ]);

  res.json({ message: "Password reset successfully. Please log in with your new password." });
});

// ─── GET /auth/sessions ───────────────────────────────────────────────────────

router.get("/sessions", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const currentToken = req.headers.authorization?.slice(7);

  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, expiresAt: { gte: new Date() } },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      createdAt: true,
      expiresAt: true,
      token: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({
    sessions: sessions.map((s) => ({
      ...s,
      token: undefined,
      isCurrent: s.token === currentToken,
    })),
  });
});

// ─── DELETE /auth/sessions/:sessionId ─────────────────────────────────────────

router.delete("/sessions/:sessionId", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const session = await prisma.session.findFirst({
    where: { id: req.params.sessionId, userId: req.user!.id },
  });

  if (!session) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found." } });
    return;
  }

  await prisma.session.delete({ where: { id: session.id } });
  res.json({ message: "Session terminated." });
});

export default router;
