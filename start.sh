#!/bin/sh
# Construct DATABASE_URL from individual env vars so Prisma CLI (migrate, etc.) works.
# The app's own code uses config.database.url (built from DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME),
# but `prisma migrate deploy` needs the DATABASE_URL environment variable.

if [ -n "$DB_HOST" ] && [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD" ] && [ -n "$DB_NAME" ]; then
  DB_PORT="${DB_PORT:-3306}"
  export DATABASE_URL="mysql://${DB_USER}:$(printf '%s' "$DB_PASSWORD" | sed 's/@/%40/g;s/:/%3A/g;s/\//%2F/g;s/?/%3F/g;s/#/%23/g;s/ /%20/g')@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

# Sync database schema (creates tables if they don't exist)
npx prisma db push --accept-data-loss --skip-generate
exec node dist/index.js
