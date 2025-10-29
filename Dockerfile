# Multi-stage Dockerfile for aio-abs-providers
FROM node:24-bullseye-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

FROM node:24-bullseye-slim AS runner
WORKDIR /app
# Create non-root user
RUN groupadd -r app && useradd -r -g app app || true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chown -R app:app /app
USER app
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "run", "start:backbone"]
