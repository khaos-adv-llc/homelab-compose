FROM node:22-slim

# db.js uses node:sqlite, which needs Node >= 22.5 (unflagged). node:22-slim
# tracks the latest 22.x, which should already clear that -- if this image
# fails at boot with "no such built-in module: node:sqlite", pin a newer
# base tag explicitly.

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js db.js ./
COPY public ./public

CMD ["node", "server.js"]
