FROM node:22-alpine

WORKDIR /app

# iputils provides a real ping binary (rather than relying on
# busybox's, which needs extra host sysctl config to work
# unprivileged) - used by the wifi status check.
RUN apk add --no-cache iputils

COPY package*.json ./

RUN npm install --omit=dev

COPY server.js ./
COPY status.js ./
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]