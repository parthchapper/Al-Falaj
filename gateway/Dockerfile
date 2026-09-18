FROM node:22-slim
WORKDIR /srv

# The gateway serves the 3D module and three.js, so both come along.
COPY gateway/package*.json ./gateway/
RUN cd gateway && npm install --omit=dev --no-audit --no-fund

COPY map3d/package.json ./map3d/
RUN cd map3d && npm install three@^0.170.0 --no-audit --no-fund

COPY gateway ./gateway
COPY map3d/src ./map3d/src

WORKDIR /srv/gateway
EXPOSE 8800
CMD ["node", "src/index.js"]
