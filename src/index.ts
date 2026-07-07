import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { prisma } from './db';
import authRoutes from './routes/auth';
import workspaceRoutes from './routes/workspaces';
import ticketRoutes from './routes/tickets';
import attachmentRoutes from './routes/attachments';
import exportRoutes from './routes/export';

const app = express();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

app.use(cors({
  origin: config.cors.origin,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces/:workspaceId/tickets', ticketRoutes);
app.use(
  '/api/workspaces/:workspaceId/tickets/:ticketId/attachments',
  attachmentRoutes
);
app.use('/api/workspaces/:workspaceId/export', exportRoutes);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Environment check (for debugging AletCloud deployments)
// ---------------------------------------------------------------------------

app.get('/env-check', (_req, res) => {
  const mask = (value: string | undefined, showLast = 4): string => {
    if (!value) return '(not set)';
    if (value.length <= showLast) return '***';
    return value.slice(0, value.length - showLast) + value.slice(-showLast);
  };

  res.json({
    S3_ENDPOINT: config.s3.endpoint,
    S3_REGION: config.s3.region,
    S3_BUCKET: config.s3.bucket || '(not set)',
    S3_ACCESS_KEY: mask(config.s3.accessKey),
    DATABASE_URL: config.database.url
      ? config.database.url.replace(/\/\/.*@/, '//user:***@')
      : '(not set)',
    NODE_ENV: config.nodeEnv,
    PORT: config.port,
    CORS_ORIGIN: config.cors.origin,
  });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled error:', err);

    // Handle Multer errors
    if (err.name === 'MulterError') {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.message,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main() {
  try {
    // Verify database connection
    await prisma.$connect();
    console.log('Database connected');

    app.listen(config.port, () => {
      console.log(
        `QA Tracker API running on http://localhost:${config.port} (${config.nodeEnv})`
      );
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

export default app;
