import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const unreadCount = await prisma.notification.count({
    where: { userId: req.user!.id, isRead: false },
  });

  res.json({ notifications, unreadCount });
});

router.post("/:id/read", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { isRead: true },
  });
  res.json({ message: "Marked as read." });
});

router.post("/read-all", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true },
  });
  res.json({ message: "All notifications marked as read." });
});

router.delete("/:id", requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  await prisma.notification.deleteMany({
    where: { id: req.params.id, userId: req.user!.id },
  });
  res.json({ message: "Notification deleted." });
});

export default router;
