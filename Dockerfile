FROM node:20-alpine

WORKDIR /app

RUN apk update && apk add --no-cache git git-lfs
RUN apk add --no-cache git

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
