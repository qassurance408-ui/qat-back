import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';

export const s3Client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretKey,
  },
  forcePathStyle: true, // Required for S3-compatible storage
});

export async function getPresignedUrl(storageKey: string): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: storageKey }),
    { expiresIn: 3600 }
  );
}
