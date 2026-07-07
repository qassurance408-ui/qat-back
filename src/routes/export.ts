import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMember } from '../middleware/workspace-member';

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/export
// ---------------------------------------------------------------------------

router.get(
  '/',
  requireAuth,
  requireWorkspaceMember,
  async (req: Request, res: Response): Promise<void> => {
    const workspaceId = req.params.workspaceId;

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Workspace not found',
        },
      });
      return;
    }

    const tickets = await prisma.ticket.findMany({
      where: { workspaceId },
      include: {
        attachments: {
          select: {
            name: true,
            mimeType: true,
            size: true,
            url: true,
          },
        },
      },
      orderBy: { dateReported: 'desc' },
    });

    const exportData = {
      exportMetadata: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        exportedAt: new Date().toISOString(),
        exportedBy: req.user!.email,
        ticketCount: tickets.length,
      },
      tickets: tickets.map((t) => ({
        id: t.id,
        title: t.title,
        service: t.service,
        subCategory: t.subCategory,
        status: t.status,
        severity: t.severity,
        dateReported: t.dateReported.toISOString(),
        description: t.description,
        observed: t.observed,
        stepsToReproduce: t.stepsToReproduce,
        expectedOutcome: t.expectedOutcome,
        actualOutcome: t.actualOutcome,
        rootCause: t.rootCause,
        environment: t.environment,
        attachments: t.attachments.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
          url: a.url,
        })),
      })),
    };

    // Sanitize workspace name for filename
    const safeName = workspace.name
      .replace(/[^a-zA-Z0-9\-_ ]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase();
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `qa-export-${safeName}-${dateStr}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    res.status(200).json(exportData);
  }
);

export default router;
