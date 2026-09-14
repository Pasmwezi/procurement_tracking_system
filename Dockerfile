FROM node:20-alpine AS builder

WORKDIR /app

# Copy package and lockfiles to leverage Docker layer caching
COPY package*.json ./

# Install all dependencies
RUN npm install

# Copy source code
COPY . .


FROM node:20-alpine AS production

# Add dumb-init to properly handle signals for Node.js
RUN apk add --no-cache dumb-init

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

# Change ownership to the non-root node user
RUN chown -R node:node /app

# Switch to the non-root user for security
USER node

# Expose standard port
EXPOSE 3000

# Use dumb-init as the entrypoint to handle PID 1 effectively
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["node", "server.js"]
