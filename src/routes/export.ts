import { Router, Request, Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMember } from '../middleware/workspace-member';
import { s3Client } from '../storage';
import { config } from '../config';

const router = Router({ mergeParams: true });

/**
 * Fetch an attachment from S3 and return it as a base64 data URI.
 * Returns null if the fetch fails (e.g. object deleted, network error).
 */
async function attachmentToDataUri(
  storageKey: string,
  mimeType: string
): Promise<string | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: storageKey,
    });
    const response = await s3Client.send(command);
    const stream = response.Body;
    if (!stream) return null;

    // Collect all chunks into a buffer
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.warn(`Failed to fetch attachment from S3 (key: ${storageKey}):`, err);
    return null;
  }
}

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
            storageKey: true,
          },
        },
      },
      orderBy: { dateReported: 'desc' },
    });

    // Fetch attachment data in parallel
    const ticketsWithAttachments = await Promise.all(
      tickets.map(async (t) => {
        const attachments = await Promise.all(
          t.attachments.map(async (a) => {
            const dataUri = await attachmentToDataUri(a.storageKey, a.mimeType);
            return {
              name: a.name,
              mimeType: a.mimeType,
              size: a.size,
              data: dataUri,
            };
          })
        );
        return {
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
          attachments,
        };
      })
    );

    const exportData = {
      exportMetadata: {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        exportedAt: new Date().toISOString(),
        exportedBy: req.user!.email,
        ticketCount: tickets.length,
      },
      tickets: ticketsWithAttachments,
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
