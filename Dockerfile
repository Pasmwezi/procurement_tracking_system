FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Copy package and lockfiles to leverage Docker layer caching
COPY package*.json ./

# Install the exact dependency graph captured by the lockfile
RUN npm ci

# Copy source code
COPY . .


FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS production

# Add dumb-init to properly handle signals for Node.js
RUN apk add --no-cache dumb-init=1.2.5-r3

WORKDIR /app

# Set production environment explicitly
ENV NODE_ENV=production

# Copy package files again since it's a new stage
COPY package*.json ./

# Only install production dependencies
RUN npm ci --only=production

# Copy application source without replacing production-only node_modules
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/config ./config
COPY --from=builder /app/db ./db
COPY --from=builder /app/middleware ./middleware
COPY --from=builder /app/public ./public
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/services ./services

# Keep code and dependencies root-owned/read-only while running the service unprivileged.
USER node

# Expose standard port
EXPOSE 3000

# Use dumb-init as the entrypoint to handle PID 1 effectively
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["node", "server.js"]
