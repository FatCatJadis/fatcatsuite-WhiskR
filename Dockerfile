FROM node:20-alpine

WORKDIR /app

# Installs git, git-lfs, and pre-compiles the system ffmpeg binary pack
RUN apk update && apk add --no-cache git git-lfs ffmpeg

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
