import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../db';
import { s3Client } from '../storage';
import { config } from '../config';
import { requireWorkspaceMember } from '../middleware/workspace-member';

const router = Router({ mergeParams: true });

// All attachment routes require workspace membership
router.use(requireWorkspaceMember);

// ---------------------------------------------------------------------------
// Multer configuration — memory storage
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/json',
  'application/pdf',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
    files: 10,                   // max 10 files per request
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  },
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/tickets/:ticketId/attachments
// ---------------------------------------------------------------------------

router.post(
  '/',
  upload.array('files', 10),
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, ticketId } = req.params;

    // Verify ticket exists and belongs to this workspace
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
    });

    if (!ticket) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
        },
      });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'No files uploaded. Use field name "files".',
        },
      });
      return;
    }

    const createdAttachments = [];

    for (const file of files) {
      const timestamp = Date.now();
      const storageKey = `attachments/${workspaceId}/${ticketId}/${timestamp}-${file.originalname}`;
      const url = `${config.s3.endpoint}/${config.s3.bucket}/${storageKey}`;

      // Upload to S3
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: storageKey,
            Body: file.buffer,
            ContentType: file.mimetype,
          })
        );
      } catch (err) {
        console.error(`Failed to upload to S3: ${storageKey}`, err);
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message: `Failed to upload file: ${file.originalname}`,
          },
        });
        return;
      }

      // Record in database
      const attachment = await prisma.attachment.create({
        data: {
          ticketId,
          name: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          storageKey,
          url,
        },
      });

      createdAttachments.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        url: attachment.url,
      });
    }

    res.status(201).json(createdAttachments);
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/tickets/:ticketId/attachments/:attachmentId
// ---------------------------------------------------------------------------

router.delete(
  '/:attachmentId',
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, ticketId, attachmentId } = req.params;

    // Verify the attachment exists and belongs to this workspace's ticket
    const attachment = await prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        ticketId,
        ticket: { workspaceId },
      },
    });

    if (!attachment) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Attachment not found',
        },
      });
      return;
    }

    // Delete from S3 (best-effort)
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: config.s3.bucket,
          Key: attachment.storageKey,
        })
      );
    } catch {
      console.warn(`Failed to delete S3 object: ${attachment.storageKey}`);
    }

    // Delete from database
    await prisma.attachment.delete({ where: { id: attachmentId } });

    res.status(204).send();
  }
);

export default router;
