FROM node:20-alpine

# Install FFmpeg utilities
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js .

# =========================================================
# CRITICAL FIX: Forces Render's Dashboard variables 
# to bind into Docker's background system layer
# =========================================================
ARG HF_TOKEN
ARG HF_REPO
ENV HF_TOKEN=$HF_TOKEN
ENV HF_REPO=$HF_REPO
# =========================================================

EXPOSE 3000
CMD ["npm", "start"]
