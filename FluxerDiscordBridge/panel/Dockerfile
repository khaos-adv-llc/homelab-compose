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

# Needed for Pangolin/newt's Docker discovery to offer this container as a
# target at all -- it (like several similar Docker-aware UIs) reads a
# container's available ports off the image's EXPOSE metadata, not just
# whether it's running. panel publishes no host port (same as this repo's
# other Pangolin-routed services), so without this, there's nothing for
# that discovery to see.
EXPOSE 8080

CMD ["node", "server.js"]
