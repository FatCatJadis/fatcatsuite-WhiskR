FROM node:20-alpine

# Install FFmpeg and system security roots
RUN apk add --no-cache ffmpeg ca-certificates

WORKDIR /app

# =========================================================
# CRITICAL LAYER IMPORTATION BRIDGE
# Grab variables from Render Dashboard at build time (ARG) 
# and lock them into the active running container environment (ENV)
# =========================================================
ARG HF_TOKEN
ARG HF_REPO

ENV HF_TOKEN=$HF_TOKEN
ENV HF_REPO=$HF_REPO
# =========================================================

# Copy dependency structures and install packages
COPY package*.json ./
RUN npm install

# Copy the server script code layers
COPY server.js .

EXPOSE 3000
CMD ["npm", "start"]
