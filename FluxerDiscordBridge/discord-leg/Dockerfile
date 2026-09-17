# Discord leg -- discord.js + @discordjs/voice need native build tools for
# @discordjs/opus (a libopus binding) and sodium (voice encryption), so this
# stays a full node:-slim image rather than -alpine, which lacks the glibc
# toolchain those prebuilt/native modules expect.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# No inbound ports: this container only makes outbound connections to
# Discord's gateway/voice servers, and talks to the fluxer-leg container
# over the stack's internal Docker network (see docker-compose.yml).
CMD ["node", "index.js"]
