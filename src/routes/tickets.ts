import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireWorkspaceMember } from '../middleware/workspace-member';
import { s3Client, getPresignedUrl } from '../storage';
import { config } from '../config';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

async function mapAttachments(
  attachments: { id: string; name: string; mimeType: string; size: number; storageKey: string }[]
) {
  return Promise.all(
    attachments.map(async (a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      url: await getPresignedUrl(a.storageKey),
    }))
  );
}

const router = Router({ mergeParams: true });

// All ticket routes require workspace membership
router.use(requireWorkspaceMember);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['Open', 'Resolved', 'Closed'] as const;
const VALID_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
const VALID_SERVICES = [
  'VPS',
  'App Deployment',
  'VPN Access',
  'Object Storage',
  'Databases',
  'Domains',
  'AI/MCP',
  'Other/Platform',
] as const;

const createTicketSchema = z.object({
  id: z.string().regex(/^TK-[A-Z0-9]+-[A-Z0-9]+$/, 'Invalid ticket ID format'),
  title: z.string().min(1, 'Title is required').max(255),
  service: z.enum(VALID_SERVICES),
  subCategory: z.string().default(''),
  status: z.enum(VALID_STATUSES).default('Open'),
  severity: z.enum(VALID_SEVERITIES).default('Medium'),
  dateReported: z.string().datetime({ message: 'Invalid ISO 8601 datetime' }),
  description: z.string().default(''),
  observed: z.string().default(''),
  stepsToReproduce: z.string().default(''),
  expectedOutcome: z.string().default(''),
  actualOutcome: z.string().default(''),
  rootCause: z.string().default(''),
  environment: z.string().default(''),
});

const updateTicketSchema = z.object({
  id: z.string().regex(/^TK-[A-Z0-9]+-[A-Z0-9]+$/, 'Invalid ticket ID format'),
  title: z.string().min(1, 'Title is required').max(255),
  service: z.enum(VALID_SERVICES),
  subCategory: z.string().default(''),
  status: z.enum(VALID_STATUSES).default('Open'),
  severity: z.enum(VALID_SEVERITIES).default('Medium'),
  dateReported: z.string().datetime({ message: 'Invalid ISO 8601 datetime' }),
  description: z.string().default(''),
  observed: z.string().default(''),
  stepsToReproduce: z.string().default(''),
  expectedOutcome: z.string().default(''),
  actualOutcome: z.string().default(''),
  rootCause: z.string().default(''),
  environment: z.string().default(''),
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/tickets
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = req.params.workspaceId;

  const {
    status,
    severity,
    service,
    search,
  } = req.query as Record<string, string | undefined>;

  // Build Prisma where clause dynamically
  const where: any = { workspaceId };

  if (status) where.status = status;
  if (severity) where.severity = severity;
  if (service) where.service = service;

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { description: { contains: search } },
      { observed: { contains: search } },
    ];
  }

  const tickets = await prisma.ticket.findMany({
    where,
    include: {
      attachments: {
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          storageKey: true,
        },
      },
    },
    orderBy: { dateReported: 'desc' },
  });

  const ticketsWithUrls = await Promise.all(
    tickets.map(async (t) => ({
      ...t,
      attachments: await mapAttachments(t.attachments),
    }))
  );

  res.status(200).json(ticketsWithUrls);
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/tickets/:ticketId
// ---------------------------------------------------------------------------

router.get('/:ticketId', async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, ticketId } = req.params;

  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
    include: {
      attachments: {
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          storageKey: true,
        },
      },
    },
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

  res.status(200).json({
    ...ticket,
    attachments: await mapAttachments(ticket.attachments),
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/tickets
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const workspaceId = req.params.workspaceId;

  const parsed = createTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      },
    });
    return;
  }

  const data = parsed.data;

  // Check for duplicate ticket ID
  const existing = await prisma.ticket.findUnique({
    where: { id: data.id },
  });

  if (existing) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'A ticket with this ID already exists in this workspace',
      },
    });
    return;
  }

  const ticket = await prisma.ticket.create({
    data: {
      id: data.id,
      workspaceId,
      title: data.title,
      service: data.service,
      subCategory: data.subCategory,
      status: data.status,
      severity: data.severity,
      dateReported: new Date(data.dateReported),
      description: data.description,
      observed: data.observed,
      stepsToReproduce: data.stepsToReproduce,
      expectedOutcome: data.expectedOutcome,
      actualOutcome: data.actualOutcome,
      rootCause: data.rootCause,
      environment: data.environment,
    },
    include: {
      attachments: {
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          storageKey: true,
        },
      },
    },
  });

  res.status(201).json({
    ...ticket,
    attachments: await mapAttachments(ticket.attachments),
  });
});

// ---------------------------------------------------------------------------
// PUT /api/workspaces/:workspaceId/tickets/:ticketId
// ---------------------------------------------------------------------------

router.put('/:ticketId', async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, ticketId } = req.params;

  const parsed = updateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      },
    });
    return;
  }

  // Verify ticket exists and belongs to this workspace
  const existing = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId },
  });

  if (!existing) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Ticket not found',
      },
    });
    return;
  }

  const data = parsed.data;

  const ticket = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      title: data.title,
      service: data.service,
      subCategory: data.subCategory,
      status: data.status,
      severity: data.severity,
      dateReported: new Date(data.dateReported),
      description: data.description,
      observed: data.observed,
      stepsToReproduce: data.stepsToReproduce,
      expectedOutcome: data.expectedOutcome,
      actualOutcome: data.actualOutcome,
      rootCause: data.rootCause,
      environment: data.environment,
    },
    include: {
      attachments: {
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          storageKey: true,
        },
      },
    },
  });

  res.status(200).json({
    ...ticket,
    attachments: await mapAttachments(ticket.attachments),
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/tickets/:ticketId
// ---------------------------------------------------------------------------

router.delete('/:ticketId', async (req: Request, res: Response): Promise<void> => {
  const { workspaceId, ticketId } = req.params;

  // Fetch all attachments for the ticket to delete from object storage
  const attachments = await prisma.attachment.findMany({
    where: { ticketId },
  });

  // Delete files from S3 (best-effort)
  for (const attachment of attachments) {
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
  }

  // Delete ticket (Prisma cascade deletes attachment rows)
  try {
    await prisma.ticket.delete({
      where: { id: ticketId },
    });
  } catch {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Ticket not found',
      },
    });
    return;
  }

  res.status(204).send();
});

export default router;
