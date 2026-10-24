# The HyperPlayer server, built by the installer from the release bundle's `server/`
# (already bundled, with its own Node.js), so the host needs nothing but Docker.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY server/ /opt/hyperplayer/server/
WORKDIR /opt/hyperplayer/server

ENV NODE_ENV=production \
    HP_HOST=0.0.0.0 \
    HP_DATA_DIR=/data
VOLUME /data
EXPOSE 4533

CMD ["/opt/hyperplayer/server/node", "dist/main.mjs"]
