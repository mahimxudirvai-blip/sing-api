# sing-api — production image (Railway / any container host).
# Node 20 + yt-dlp + deno. No ffmpeg needed (audio streams direct, no re-encode).
FROM node:20-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 python3-pip curl ca-certificates unzip \
	&& pip3 install --break-system-packages --no-cache-dir yt-dlp \
	&& DENO_INSTALL=/usr/local sh -c 'curl -fsSL https://deno.land/install.sh | sh' \
	&& apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Railway sets PORT at runtime; 3000 is the local default.
EXPOSE 3000

CMD ["node", "index.js"]
