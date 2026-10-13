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

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
