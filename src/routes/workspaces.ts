import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMember } from '../middleware/workspace-member';
import { s3Client } from '../storage';
import { config } from '../config';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const router = Router();

// All workspace routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createWorkspaceSchema = z.object({
  id: z.string().min(1, 'Workspace ID is required'),
  name: z.string().min(1, 'Workspace name is required').max(255),
});

const renameWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(255),
});

const joinWorkspaceSchema = z.object({
  inviteCode: z.string().min(1, 'Invite code is required'),
});

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: {
      workspace: {
        include: {
          _count: { select: { members: true } },
        },
      },
    },
  });

  const workspaces = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    ownerId: m.workspace.ownerId,
    inviteCode: m.workspace.inviteCode,
    createdAt: m.workspace.createdAt,
    role: m.role,
    memberCount: m.workspace._count.members,
  }));

  res.status(200).json(workspaces);
});

// ---------------------------------------------------------------------------
// POST /api/workspaces
// ---------------------------------------------------------------------------

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = createWorkspaceSchema.safeParse(req.body);
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

  const { id, name } = parsed.data;
  const userId = req.user!.userId;

  // Check for duplicate workspace ID
  const existing = await prisma.workspace.findUnique({ where: { id } });
  if (existing) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'A workspace with this ID already exists',
      },
    });
    return;
  }

  const workspace = await prisma.workspace.create({
    data: {
      id,
      name,
      ownerId: userId,
      members: {
        create: {
          userId,
          role: 'OWNER',
        },
      },
    },
    include: {
      _count: { select: { members: true } },
    },
  });

  res.status(201).json({
    id: workspace.id,
    name: workspace.name,
    ownerId: workspace.ownerId,
    inviteCode: workspace.inviteCode,
    createdAt: workspace.createdAt,
    role: 'OWNER',
    memberCount: workspace._count.members,
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId
// ---------------------------------------------------------------------------

router.get(
  '/:workspaceId',
  requireWorkspaceMember,
  async (req: Request, res: Response): Promise<void> => {
    const workspaceId = req.params.workspaceId;

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, displayName: true, email: true },
            },
          },
        },
        _count: { select: { members: true } },
      },
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

    res.status(200).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      inviteCode: workspace.inviteCode,
      createdAt: workspace.createdAt,
      role: req.workspaceMember!.role,
      memberCount: workspace._count.members,
      members: workspace.members.map((m) => ({
        userId: m.user.id,
        displayName: m.user.displayName,
        email: m.user.email,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    });
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:workspaceId
// ---------------------------------------------------------------------------

router.patch(
  '/:workspaceId',
  requireWorkspaceMember,
  async (req: Request, res: Response): Promise<void> => {
    if (req.workspaceMember!.role !== 'OWNER') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Only the workspace owner can rename the workspace',
        },
      });
      return;
    }

    const parsed = renameWorkspaceSchema.safeParse(req.body);
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

    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId },
      data: { name: parsed.data.name },
      include: {
        _count: { select: { members: true } },
      },
    });

    res.status(200).json({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      inviteCode: workspace.inviteCode,
      createdAt: workspace.createdAt,
      role: 'OWNER',
      memberCount: workspace._count.members,
    });
  }
);

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId
// ---------------------------------------------------------------------------

router.delete(
  '/:workspaceId',
  requireWorkspaceMember,
  async (req: Request, res: Response): Promise<void> => {
    if (req.workspaceMember!.role !== 'OWNER') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Only the workspace owner can delete the workspace',
        },
      });
      return;
    }

    const workspaceId = req.params.workspaceId;

    // Fetch all attachments to delete from object storage
    const tickets = await prisma.ticket.findMany({
      where: { workspaceId },
      include: { attachments: true },
    });

    // Delete files from S3 (best-effort)
    for (const ticket of tickets) {
      for (const attachment of ticket.attachments) {
        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: config.s3.bucket,
              Key: attachment.storageKey,
            })
          );
        } catch {
          // Log failure but don't abort
          console.warn(
            `Failed to delete S3 object: ${attachment.storageKey}`
          );
        }
      }
    }

    // Prisma cascade deletes: WorkspaceMember → Ticket → Attachment
    await prisma.workspace.delete({ where: { id: workspaceId } });

    res.status(204).send();
  }
);

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/regenerate-invite
// ---------------------------------------------------------------------------

router.post(
  '/:workspaceId/regenerate-invite',
  requireWorkspaceMember,
  async (req: Request, res: Response): Promise<void> => {
    if (req.workspaceMember!.role !== 'OWNER') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Only the workspace owner can regenerate the invite code',
        },
      });
      return;
    }

    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId },
      data: { inviteCode: crypto.randomUUID() },
    });

    res.status(200).json({ inviteCode: workspace.inviteCode });
  }
);

// ---------------------------------------------------------------------------
// POST /api/workspaces/join
// ---------------------------------------------------------------------------

router.post('/join', async (req: Request, res: Response): Promise<void> => {
  const parsed = joinWorkspaceSchema.safeParse(req.body);
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

  const { inviteCode } = parsed.data;
  const userId = req.user!.userId;

  // Find workspace by invite code
  const workspace = await prisma.workspace.findUnique({
    where: { inviteCode },
  });

  if (!workspace) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Invalid invite code — workspace not found',
      },
    });
    return;
  }

  // Check if already a member
  const existingMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId,
      },
    },
  });

  if (existingMembership) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'You are already a member of this workspace',
      },
    });
    return;
  }

  // Add member
  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspace.id,
      userId,
      role: 'MEMBER',
    },
  });

  // Return workspace info
  const memberCount = await prisma.workspaceMember.count({
    where: { workspaceId: workspace.id },
  });

  res.status(200).json({
    id: workspace.id,
    name: workspace.name,
    ownerId: workspace.ownerId,
    inviteCode: workspace.inviteCode,
    createdAt: workspace.createdAt,
    role: 'MEMBER',
    memberCount,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/members/:userId
// ---------------------------------------------------------------------------

router.delete(
  '/:workspaceId/members/:userId',
  requireWorkspaceMember,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, userId: targetUserId } = req.params;
    const requesterId = req.user!.userId;
    const requesterRole = req.workspaceMember!.role;

    // Owner can remove any member. A member can remove themselves (leave).
    const isOwnerRemoving = requesterRole === 'OWNER' && targetUserId !== requesterId;
    const isSelfRemoving = targetUserId === requesterId;

    if (!isOwnerRemoving && !isSelfRemoving) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to remove this member',
        },
      });
      return;
    }

    // Cannot remove the workspace owner
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
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

    if (targetUserId === workspace.ownerId) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Cannot remove the workspace owner. Delete the workspace instead.',
        },
      });
      return;
    }

    await prisma.workspaceMember.deleteMany({
      where: {
        workspaceId,
        userId: targetUserId,
      },
    });

    res.status(204).send();
  }
);

export default router;
