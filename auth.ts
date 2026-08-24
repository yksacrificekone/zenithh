import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    displayName: string;
    email: string;
    role: string;
    avatarUrl: string | null;
    presence: string;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractToken(req);

    if (!token) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } });
      return;
    }

    const session = await prisma.session.findUnique({
      where: { token },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            email: true,
            role: true,
            avatarUrl: true,
            presence: true,
          },
        },
      },
    });

    if (!session || session.expiresAt < new Date()) {
      if (session && session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      }
      res.status(401).json({ error: { code: "SESSION_EXPIRED", message: "Session expired. Please log in again." } });
      return;
    }

    req.user = session.user;
    next();
  } catch (err) {
    logger.error("Auth middleware error", err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Authentication error." } });
  }
}

export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  await requireAuth(req, res, async () => {
    if (req.user?.role !== "ADMIN") {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Platform administrator access required." } });
      return;
    }
    next();
  });
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const cookieToken = (req as any).cookies?.zenith_session;
  if (cookieToken) return cookieToken;

  return null;
}

export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  requireAuth(req, res, next).catch(() => next());
}
