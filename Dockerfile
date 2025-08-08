# syntax=docker.io/docker/dockerfile:1.7-labs
FROM node:slim

USER node

WORKDIR /app/backend

COPY --exclude=node_packages --exclude=frontend --chown=node:node . .

RUN npm i

WORKDIR /app/frontend

COPY --exclude=frontend/node_packages --chown=node:node frontend .

RUN npm i

WORKDIR /app

RUN cat <<EOF > start_server.sh
#!/bin/sh
cd /app/backend
npm run dev -- --host 0.0.0.0 &
cd /app/frontend
npm run dev -- --host 0.0.0.0
EOF

EXPOSE 3000
EXPOSE 5173

CMD ["sh", "start_server.sh"]

