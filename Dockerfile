FROM node:20-alpine

WORKDIR /app

# Install git (needed for pushing to HuggingFace)
RUN apt-get update && apt-get install -y git git-lfs


COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
