import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';

export interface WorkspaceMemberInfo {
  role: 'OWNER' | 'MEMBER';
  userId: string;
  workspaceId: string;
}

// Extend Express Request to include workspace member info
declare global {
  namespace Express {
    interface Request {
      workspaceMember?: WorkspaceMemberInfo;
    }
  }
}

/**
 * Workspace membership guard middleware.
 * Checks that req.user is a member of req.params.workspaceId.
 * Attaches req.workspaceMember = { role, userId, workspaceId } on success.
 * Returns 404 (not 403) if workspace not found or user not a member.
 * 404 is intentional — do not leak existence of workspaces to non-members.
 */
export async function requireWorkspaceMember(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const workspaceId = req.params.workspaceId;
  const userId = req.user?.userId;

  if (!workspaceId || !userId) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Workspace not found',
      },
    });
    return;
  }

  try {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });

    if (!membership) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Workspace not found',
        },
      });
      return;
    }

    req.workspaceMember = {
      role: membership.role as 'OWNER' | 'MEMBER',
      userId: membership.userId,
      workspaceId: membership.workspaceId,
    };

    next();
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
    return;
  }
}
