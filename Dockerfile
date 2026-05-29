# Use Node 20 slim image
FROM node:20-slim

# Install system dependencies needed for @discordjs/opus and audio processing
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    libtool \
    autoconf \
    automake \
    libopus-dev \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including native addons)
RUN npm install --build-from-source

# Copy source code
COPY . .

# Railway doesn't need EXPOSE for bots (no HTTP server)
# Start the bot
CMD ["node", "index.js"]
