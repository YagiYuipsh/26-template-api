FROM oven/bun:1.4.2

WORKDIR /app

# Install only runtime dependencies so the production image stays small.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV NODE_ENV=production \
    FASTIFY_ADDRESS=0.0.0.0 \
    FASTIFY_PORT=3000

EXPOSE 3000

CMD ["bun", "--bun", "fastify", "start", "--log-level=info", "--options", "src/app.ts"]
