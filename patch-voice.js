/**
 * patch-voice.js — Railway TCP voice patch
 * Replaces UDP socket with TCP in @discordjs/voice so Railway's firewall is bypassed.
 * Targets @discordjs/voice 0.17.x (pinned in package.json).
 */

const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'node_modules/@discordjs/voice/dist/index.js');

if (!fs.existsSync(targetFile)) {
  console.log('⚠️  patch-voice: @discordjs/voice not found, skipping');
  process.exit(0);
}

let src = fs.readFileSync(targetFile, 'utf8');

if (src.includes('// TCP MODE')) {
  console.log('✅ patch-voice: already patched');
  process.exit(0);
}

let count = 0;

// ── Patch 1: constructor ──────────────────────────────────────────────────────
src = src.replace(
  `  constructor(remote) {
    super();
    this.socket = (0, import_node_dgram.createSocket)("udp4");
    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("message", (buffer) => this.onMessage(buffer));
    this.socket.on("close", () => this.emit("close"));
    this.remote = remote;
    this.keepAliveBuffer = import_node_buffer2.Buffer.alloc(8);
    this.keepAliveInterval = setInterval(() => this.keepAlive(), KEEP_ALIVE_INTERVAL);
    setImmediate(() => this.keepAlive());
  }`,
  `  constructor(remote) {
    super();
    // TCP MODE: bypass Railway UDP block — connect to Discord voice server via TCP port 443
    this.remote = remote;
    this.keepAliveBuffer = import_node_buffer2.Buffer.alloc(8);
    const net = require("net");
    this.socket = net.createConnection({ host: remote.ip, port: 443 });
    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("data", (buffer) => this.onMessage(buffer));
    this.socket.on("close", () => this.emit("close"));
    this.socket.once("connect", () => {
      this.keepAliveInterval = setInterval(() => this.keepAlive(), KEEP_ALIVE_INTERVAL);
    });
  }`,
  () => count++
);
count++; // replace() doesn't take callback — track manually below

// ── Patch 2: send() ───────────────────────────────────────────────────────────
const beforeSend = src;
src = src.replace(
  `  send(buffer) {
    this.socket.send(buffer, this.remote.port, this.remote.ip);
  }`,
  `  send(buffer) {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.write(buffer); } catch {}
    }
  }`
);

// ── Patch 3: destroy() ────────────────────────────────────────────────────────
src = src.replace(
  `  destroy() {
    try {
      this.socket.close();
    } catch {
    }
    clearInterval(this.keepAliveInterval);
  }`,
  `  destroy() {
    try {
      if (this.socket && !this.socket.destroyed) this.socket.destroy();
    } catch {}
    clearInterval(this.keepAliveInterval);
  }`
);

// ── Patch 4: performIPDiscovery() ─────────────────────────────────────────────
src = src.replace(
  `  async performIPDiscovery(ssrc) {
    return new Promise((resolve2, reject) => {
      const listener = /* @__PURE__ */ __name((message) => {
        try {
          if (message.readUInt16BE(0) !== 2)
            return;
          const packet = parseLocalPacket(message);
          this.socket.off("message", listener);
          resolve2(packet);
        } catch {
        }
      }, "listener");
      this.socket.on("message", listener);
      this.socket.once("close", () => reject(new Error("Cannot perform IP discovery - socket closed")));
      const discoveryBuffer = import_node_buffer2.Buffer.alloc(74);
      discoveryBuffer.writeUInt16BE(1, 0);
      discoveryBuffer.writeUInt16BE(70, 2);
      discoveryBuffer.writeUInt32BE(ssrc, 4);
      this.send(discoveryBuffer);
    });
  }`,
  `  async performIPDiscovery(ssrc) {
    // TCP MODE: resolve local address from TCP socket; no UDP discovery needed
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => reject(new Error("TCP voice: IP discovery timeout")), 10000);
      const done = (ip, port) => {
        clearTimeout(timer);
        console.log("📡 TCP voice ready — local address: " + ip + ":" + port);
        resolve2({ ip, port });
      };
      if (this.socket.localAddress) {
        done(this.socket.localAddress, this.socket.localPort);
      } else {
        this.socket.once("connect", () => done(this.socket.localAddress, this.socket.localPort));
        this.socket.once("error", (err) => { clearTimeout(timer); reject(err); });
      }
    });
  }`
);

fs.writeFileSync(targetFile, src);

// Verify patches applied by checking key strings
const verify = fs.readFileSync(targetFile, 'utf8');
const checks = [
  verify.includes('TCP MODE'),
  verify.includes('this.socket.write(buffer)'),
  verify.includes('this.socket.destroy()'),
  verify.includes('TCP voice ready'),
];
const passed = checks.filter(Boolean).length;
console.log(`✅ patch-voice: ${passed}/4 patches applied (TCP voice mode active)`);
if (passed < 4) {
  console.log('⚠️  Some patches may not have matched — check @discordjs/voice version');
}
