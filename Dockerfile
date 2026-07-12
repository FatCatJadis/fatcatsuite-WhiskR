FROM node:20-alpine

# Install FFmpeg and SSL root certificates so Fetch can make secure HTTPS calls
RUN apk add --no-cache ffmpeg ca-certificates

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js .
EXPOSE 3000
CMD ["npm", "start"]
