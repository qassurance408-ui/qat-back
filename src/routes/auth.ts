import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import multer from 'multer';
import { z } from 'zod';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../db';
import { s3Client } from '../storage';
import { config } from '../config';
import {
  signAccessToken,
  createRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
} from '../lib/token';
import { requireAuth } from '../middleware/auth';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(50, 'Display name must be 1–50 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

const REFRESH_TOKEN_COOKIE = 'refreshToken';

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------

router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
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

  const { email, password, displayName } = parsed.data;

  // Check for existing user
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'A user with this email already exists',
      },
    });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: { email, passwordHash, displayName },
  });

  const accessToken = signAccessToken({ userId: user.id, email: user.email });
  const refreshToken = await createRefreshToken(user.id);

  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
    },
    accessToken,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------

router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
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

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
      },
    });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid email or password',
      },
    });
    return;
  }

  const accessToken = signAccessToken({ userId: user.id, email: user.email });
  const refreshToken = await createRefreshToken(user.id);

  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
    },
    accessToken,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE];

  if (!token) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Refresh token not found',
      },
    });
    return;
  }

  try {
    const userId = await consumeRefreshToken(token);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'User not found',
        },
      });
      return;
    }

    const accessToken = signAccessToken({ userId: user.id, email: user.email });
    const newRefreshToken = await createRefreshToken(user.id);

    res.cookie(REFRESH_TOKEN_COOKIE, newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({ accessToken });
  } catch (err) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Refresh token is invalid or expired',
      },
    });
    return;
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.[REFRESH_TOKEN_COOKIE];

  if (token) {
    await revokeRefreshToken(token);
  }

  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  });

  res.status(204).send();
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------

router.get('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true, email: true, displayName: true, avatarUrl: true, createdAt: true },
  });

  if (!user) {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'User not found',
      },
    });
    return;
  }

  res.status(200).json(user);
});

// ---------------------------------------------------------------------------
// PUT /api/auth/me — update display name
// ---------------------------------------------------------------------------

router.put('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    displayName: z.string().min(1).max(50),
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid display name', details: parsed.error.flatten().fieldErrors },
    });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: { displayName: parsed.data.displayName },
    select: { id: true, email: true, displayName: true, avatarUrl: true },
  });

  res.status(200).json(user);
});

// ---------------------------------------------------------------------------
// PUT /api/auth/password — change password
// ---------------------------------------------------------------------------

router.put('/password', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = z.object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: parsed.error.flatten().fieldErrors },
    });
    return;
  }

  const { oldPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }

  const valid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Current password is incorrect' } });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });

  res.status(204).send();
});

// ---------------------------------------------------------------------------
// POST /api/auth/avatar — upload avatar
// ---------------------------------------------------------------------------

router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No file provided' } });
    return;
  }

  const ext = req.file.originalname.split('.').pop() || 'png';
  const key = `avatars/${req.user!.userId}.${ext}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  }));

  const avatarUrl = `s3://${config.s3.bucket}/${key}`;

  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { avatarUrl },
  });

  res.status(200).json({ avatarUrl });
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/avatar — remove avatar
// ---------------------------------------------------------------------------

router.delete('/avatar', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user || !user.avatarUrl) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No avatar to remove' } });
    return;
  }

  // Extract key from s3:// URL
  const key = user.avatarUrl.replace(`s3://${config.s3.bucket}/`, '');
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }));
  } catch {
    // Ignore S3 delete errors — the file may not exist
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { avatarUrl: null },
  });

  res.status(204).send();
});

export default router;
