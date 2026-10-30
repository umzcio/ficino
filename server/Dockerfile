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
COPY migrations ./migrations
ENV NODE_ENV=production
USER ficino
EXPOSE 8000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8000/health || exit 1
CMD ["node","dist/api/main.js"]
