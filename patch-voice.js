/**
 * patch-voice.js — Railway voice patch
 * 
 * Problem: @discordjs/voice does UDP IP discovery by sending a packet to Discord's
 * voice server and reading back the response to learn our public IP. On Railway, 
 * outbound UDP to Discord's high ports (50000-65535) may be blocked.
 *
 * Fix: Patch performIPDiscovery() to use a STUN server (port 3478 UDP, widely allowed)
 * to discover our public IP/port instead, then use that for the SelectProtocol packet.
 * The actual RTP audio still goes over UDP — we just fix the discovery step.
 */

const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'node_modules/@discordjs/voice/dist/index.js');

if (!fs.existsSync(targetFile)) {
  console.log('⚠️  patch-voice: @discordjs/voice not found, skipping');
  process.exit(0);
}

let src = fs.readFileSync(targetFile, 'utf8');

if (src.includes('// STUN PATCH')) {
  console.log('✅ patch-voice: already patched');
  process.exit(0);
}

let count = 0;

// ── Patch performIPDiscovery to use STUN for public IP discovery ──────────────
const oldDiscovery = `  async performIPDiscovery(ssrc) {
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
  }`;

const newDiscovery = `  async performIPDiscovery(ssrc) {
    // STUN PATCH: Use STUN (port 3478) to get public IP since Railway may block
    // Discord's high UDP ports during IP discovery. Audio RTP still uses normal UDP.
    return new Promise((resolve2, reject) => {
      const dgram = require("dgram");
      const stunSock = dgram.createSocket("udp4");
      const STUN_HOST = "stun.l.google.com";
      const STUN_PORT = 19302;

      // Build a minimal STUN Binding Request
      const stunMsg = import_node_buffer2.Buffer.alloc(20);
      stunMsg.writeUInt16BE(0x0001, 0); // Binding Request
      stunMsg.writeUInt16BE(0x0000, 2); // Length
      stunMsg.writeUInt32BE(0x2112A442, 4); // Magic cookie
      // Transaction ID (12 random bytes)
      for (let i = 8; i < 20; i++) stunMsg[i] = Math.floor(Math.random() * 256);

      const timer = setTimeout(() => {
        stunSock.close();
        // Fallback: try original Discord IP discovery
        console.warn("⚠️  STUN timed out, trying Discord IP discovery...");
        const listener = /* @__PURE__ */ __name((message) => {
          try {
            if (message.readUInt16BE(0) !== 2) return;
            const packet = parseLocalPacket(message);
            this.socket.off("message", listener);
            resolve2(packet);
          } catch {}
        }, "listener");
        this.socket.on("message", listener);
        this.socket.once("close", () => reject(new Error("Cannot perform IP discovery - socket closed")));
        const discoveryBuffer = import_node_buffer2.Buffer.alloc(74);
        discoveryBuffer.writeUInt16BE(1, 0);
        discoveryBuffer.writeUInt16BE(70, 2);
        discoveryBuffer.writeUInt32BE(ssrc, 4);
        this.send(discoveryBuffer);
        setTimeout(() => reject(new Error("IP discovery timeout")), 8000);
      }, 5000);

      stunSock.on("message", (msg) => {
        clearTimeout(timer);
        try {
          // Parse STUN response to get our mapped (public) address
          let offset = 20;
          while (offset < msg.length) {
            const attrType = msg.readUInt16BE(offset);
            const attrLen = msg.readUInt16BE(offset + 2);
            if (attrType === 0x0001 || attrType === 0x0020) { // MAPPED-ADDRESS or XOR-MAPPED-ADDRESS
              const family = msg[offset + 5];
              if (family === 0x01) { // IPv4
                let port = msg.readUInt16BE(offset + 6);
                let b0 = msg[offset + 8], b1 = msg[offset + 9], b2 = msg[offset + 10], b3 = msg[offset + 11];
                if (attrType === 0x0020) { // XOR decode
                  port ^= 0x2112;
                  b0 ^= 0x21; b1 ^= 0x12; b2 ^= 0xA4; b3 ^= 0x42;
                }
                const ip = b0 + "." + b1 + "." + b2 + "." + b3;
                // Use our local UDP port (where Discord will actually send RTP to)
                const localPort = this.socket.address().port;
                console.log("📡 STUN public IP: " + ip + ", local UDP port: " + localPort);
                stunSock.close();
                resolve2({ ip, port: localPort });
                return;
              }
            }
            offset += 4 + attrLen + (attrLen % 4 ? 4 - attrLen % 4 : 0);
          }
          throw new Error("No mapped address in STUN response");
        } catch (e) {
          stunSock.close();
          reject(e);
        }
      });

      stunSock.on("error", (err) => {
        clearTimeout(timer);
        stunSock.close();
        reject(err);
      });

      stunSock.bind(0, () => {
        require("dns").lookup(STUN_HOST, (err, addr) => {
          if (err) { clearTimeout(timer); stunSock.close(); reject(err); return; }
          stunSock.send(stunMsg, STUN_PORT, addr);
        });
      });
    });
  }`;

if (src.includes(oldDiscovery)) {
  src = src.replace(oldDiscovery, newDiscovery);
  count++;
  console.log('✅ Patched performIPDiscovery() with STUN');
} else {
  console.log('❌ performIPDiscovery() not found — version mismatch?');
}

fs.writeFileSync(targetFile, src);
console.log(`patch-voice: ${count}/1 patches applied`);
