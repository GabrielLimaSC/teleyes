# Production image for the frontend: static Vite build served by nginx, which
# also reverse-proxies the real API prefixes so the browser sees everything as
# same-origin — same reason apps/web/vite.config.ts proxies these in dev: the
# session cookie is Secure/SameSite=strict (S3-02).
FROM node:22-slim AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web .
RUN npm run build

# S23-01: the unprivileged build runs nginx as uid 101 and listens on 8080 (no root, no
# privileged port). 1.30 is the current stable line; 1.27 was end-of-life with open CVEs.
FROM nginxinc/nginx-unprivileged:1.30-alpine
# Alpine security fixes published after the base image was built.
USER root
RUN apk upgrade --no-cache
USER 101
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
