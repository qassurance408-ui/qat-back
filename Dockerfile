FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for bcrypt
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma/ ./prisma/
RUN npx prisma generate

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─────────────────────────────────────────────

FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY prisma/ ./prisma/

EXPOSE 3000

# Run migrations on startup, then start the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
