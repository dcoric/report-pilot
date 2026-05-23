FROM node:22-alpine AS frontend-builder

WORKDIR /usr/src/app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend ./
RUN npm run build

FROM node:22-alpine AS backend-builder

WORKDIR /usr/src/app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY app ./app
RUN npm run build:be

FROM node:22-alpine AS backend-deps

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
COPY --from=backend-deps /usr/src/app/node_modules ./node_modules
COPY --from=backend-builder /usr/src/app/dist ./dist

COPY db ./db
COPY docs/api/openapi.yaml ./docs/api/openapi.yaml
COPY --from=frontend-builder /usr/src/app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/src/start.js"]
