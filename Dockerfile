# Focus Desk — production image
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Non-root user + writable data directory (mount a volume here)
RUN groupadd -r appuser && useradd -r -g appuser appuser \
  && mkdir -p /data && chown -R appuser:appuser /app /data

USER appuser

ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
