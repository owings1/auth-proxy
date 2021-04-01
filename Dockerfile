FROM node:alpine

WORKDIR /var/lib/auth-proxy
RUN ["chown", "node:node", "/var/lib/auth-proxy"]
EXPOSE 8080
EXPOSE 8181

ENV CONFIG_DIR="/etc/auth-proxy"

COPY package.json .
COPY package-lock.json .

RUN npm install

COPY --chown=node:node . .

USER node

CMD ["node", "index.js"]