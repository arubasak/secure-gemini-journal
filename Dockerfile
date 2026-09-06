# ---- Secure Personal Gemini Journal ---------------------------------------
# Small, non-root, production-only image for Cloud Run.
FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies (uses the lockfile for reproducible builds)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy application code
COPY server ./server
COPY public ./public

# Run as the unprivileged `node` user
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
