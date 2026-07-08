import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    host: requireEnv('DB_HOST'),
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    name: requireEnv('DB_NAME'),
    ssl: process.env.DB_SSL === 'true',
    get url(): string {
      return `mysql://${this.user}:${encodeURIComponent(this.password)}@${this.host}:${this.port}/${this.name}`;
    },
  },

  jwt: {
    secret: requireEnv('JWT_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  s3: {
    endpoint: process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || 'https://storage.aletcloud.com',
    region: process.env.S3_REGION || process.env.AWS_REGION || 'et-addis-1',
    accessKey: process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || '',
    secretKey: process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || '',
    bucket: process.env.S3_BUCKET || '',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  },
};
