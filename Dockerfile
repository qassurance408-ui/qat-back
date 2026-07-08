FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for bcrypt
RUN apt-get update -y && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma/ ./prisma/
RUN npx prisma generate

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─────────────────────────────────────────────

FROM node:20-bullseye-slim AS runner

WORKDIR /app

# Bullseye (Debian 11) ships OpenSSL 1.1.x — what AletCloud's cluster expects
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY prisma/ ./prisma/

# Also copy the Prisma CLI so migrations work at startup
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 3000

# Run migrations on startup, then start the server
CMD ["./start.sh"]
