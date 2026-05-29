/**
 * patch-voice.js
 * Run via postinstall: patches @discordjs/voice to use TCP instead of UDP
 * This allows the bot to work on Railway (which blocks outbound UDP)
 */

const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'node_modules/@discordjs/voice/dist/index.js');

if (!fs.existsSync(targetFile)) {
  console.log('⚠️  patch-voice.js: @discordjs/voice not found, skipping patch');
  process.exit(0);
}

let src = fs.readFileSync(targetFile, 'utf8');

// Check if already patched
if (src.includes('TCP MODE')) {
  console.log('✅ patch-voice.js: already patched, skipping');
  process.exit(0);
}

let patched = 0;

// 1. Patch constructor: replace UDP socket with TCP socket
const oldConstructor = '    this.socket = (0, import_node_dgram.createSocket)("udp4");\n    this.socket.on("error", (error) => this.emit("error", error));\n    this.socket.on("message", (buffer) => this.onMessage(buffer));\n    this.socket.on("close", () => this.emit("close"));\n    this.remote = remote;';
const newConstructor = '    this.remote = remote;\n    // TCP MODE: Railway blocks UDP, connect via TCP port 443 instead\n    this.socket = (0, import_node_net.createConnection)({ host: remote.ip, port: 443 });\n    this.socket.on("error", (error) => this.emit("error", error));\n    this.socket.on("data", (buffer) => this.onMessage(buffer));\n    this.socket.on("close", () => this.emit("close"));';
if (src.includes(oldConstructor)) { src = src.replace(oldConstructor, newConstructor); patched++; }

// 2. Patch keepAlive init: only start after TCP connects
const oldKeepAlive = '    this.keepAliveBuffer = import_node_buffer4.Buffer.alloc(8);\n    this.keepAliveInterval = setInterval(() => this.keepAlive(), KEEP_ALIVE_INTERVAL);\n    setImmediate(() => this.keepAlive());';
const newKeepAlive = '    this.keepAliveBuffer = import_node_buffer4.Buffer.alloc(8);\n    this.socket.once("connect", () => { this.keepAliveInterval = setInterval(() => this.keepAlive(), KEEP_ALIVE_INTERVAL); });';
if (src.includes(oldKeepAlive)) { src = src.replace(oldKeepAlive, newKeepAlive); patched++; }

// 3. Patch send(): use TCP write instead of UDP send
const oldSend = '  send(buffer) {\n    this.socket.send(buffer, this.remote.port, this.remote.ip);\n  }';
const newSend = '  send(buffer) {\n    // TCP write instead of UDP send\n    if (this.socket && !this.socket.destroyed) {\n      try { this.socket.write(buffer); } catch {}\n    }\n  }';
if (src.includes(oldSend)) { src = src.replace(oldSend, newSend); patched++; }

// 4. Patch destroy(): use TCP destroy instead of UDP close
const oldDestroy = '  destroy() {\n    try {\n      this.socket.close();\n    } catch {\n    }\n    clearInterval(this.keepAliveInterval);\n  }';
const newDestroy = '  destroy() {\n    try {\n      if (this.socket && !this.socket.destroyed) this.socket.destroy();\n    } catch {}\n    clearInterval(this.keepAliveInterval);\n  }';
if (src.includes(oldDestroy)) { src = src.replace(oldDestroy, newDestroy); patched++; }

// 5. Patch performIPDiscovery(): use TCP local address instead of UDP discovery
const oldDiscovery = `  async performIPDiscovery(ssrc) {
    return new Promise((resolve2, reject) => {
      const listener = /* @__PURE__ */ __name((message) => {
        try {
          if (message.readUInt16BE(0) !== 2) return;
          const packet = parseLocalPacket(message);
          this.socket.off("message", listener);
          resolve2(packet);
        } catch {
        }
      }, "listener");
      this.socket.on("message", listener);
      this.socket.once("close", () => reject(new Error("Cannot perform IP discovery - socket closed")));
      const discoveryBuffer = import_node_buffer4.Buffer.alloc(74);
      discoveryBuffer.writeUInt16BE(1, 0);
      discoveryBuffer.writeUInt16BE(70, 2);
      discoveryBuffer.writeUInt32BE(ssrc, 4);
      this.send(discoveryBuffer);
    });
  }`;
const newDiscovery = `  async performIPDiscovery(ssrc) {
    // TCP mode: get local address from TCP socket, no UDP discovery needed
    return new Promise((resolve2, reject) => {
      const timeout = setTimeout(() => reject(new Error("TCP IP discovery timeout")), 10000);
      const done = (ip, port) => { clearTimeout(timeout); console.log("📡 TCP voice local: " + ip + ":" + port); resolve2({ ip, port }); };
      if (this.socket.localAddress) {
        done(this.socket.localAddress, this.socket.localPort);
      } else {
        this.socket.once("connect", () => done(this.socket.localAddress, this.socket.localPort));
        this.socket.once("error", (err) => { clearTimeout(timeout); reject(err); });
      }
    });
  }`;
if (src.includes(oldDiscovery)) { src = src.replace(oldDiscovery, newDiscovery); patched++; }

fs.writeFileSync(targetFile, src);

if (patched === 5) {
  console.log('✅ patch-voice.js: all 5 patches applied successfully (TCP voice mode)');
} else {
  console.log(`⚠️  patch-voice.js: applied ${patched}/5 patches (version mismatch?)`);
}
