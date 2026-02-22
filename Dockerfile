FROM node:22-alpine

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY app ./app
COPY db ./db
COPY docs/api/openapi.yaml ./docs/api/openapi.yaml

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
