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

# Copy package files AND patch script before npm install
# (postinstall script needs patch-voice.js to exist during npm install)
COPY package*.json ./
COPY patch-voice.js ./

# Install dependencies (postinstall will apply TCP voice patch)
RUN npm install --build-from-source

# Copy rest of source code
COPY . .

# Start the bot
CMD ["node", "index.js"]
