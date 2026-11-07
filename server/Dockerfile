FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
RUN addgroup -g 10001 ficino && adduser -D -u 10001 -G ficino ficino \
 && mkdir -p /app/uploads /app/figures /app/media \
 && chown -R ficino:ficino /app/uploads /app/figures /app/media
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
# mupdf loads its .wasm at runtime; fail the build if pruning ever drops it.
RUN test -f node_modules/mupdf/dist/mupdf-wasm.wasm
COPY migrations ./migrations
ENV NODE_ENV=production
# Fail closed: a bare `docker run` is production (dev CORS off, SIGNED_URL_KEY required).
ENV ENVIRONMENT=production
# Loopback is the default; inside the container we listen on its own interface.
ENV API_HOST=0.0.0.0
USER ficino
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 CMD wget -qO- http://127.0.0.1:8000/health || exit 1
# The API is the default. The worker runs from the same image: override with `node dist/worker/main.js`.
CMD ["node","dist/api/main.js"]
