FROM node:22-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy dependency manifest first for layer caching
COPY package.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy application code
COPY agents/ ./agents/
COPY scripts/ ./scripts/

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p agents/outputs agents/results \
    && chown -R appuser:appgroup /app
USER appuser

CMD ["node", "agents/daemon.mjs"]
