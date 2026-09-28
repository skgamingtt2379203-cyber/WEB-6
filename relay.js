/**
 * D4Hz WEB — Zero-Dependency Native Voice Relay Backend
 * Powered by Node.js 24 Native WebSocket, dgram (UDP), and crypto
 * No npm dependencies required!
 * Run: node relay.js
 */
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PORT = 7432;
const activeClients = new Map(); // token -> NativeVoiceClient
const voiceStatesByGuild = new Map(); // guildId -> Map(userId, voiceState)
let currentSession = null;

// ══════════════════════════════════════════════════════════
//  DISCORD PROFILE ACTIVITY & RICH PRESENCE (DEATH.gif)
// ══════════════════════════════════════════════════════════
const DEFAULT_DEATH_GIF_URL = 'https://files.catbox.moe/fi131s.gif';
const DISCORD_APP_IDS = ['383226320970055681', '1344697306231935048'];
let localDiscordPipe = null;

function buildDiscordActivity(details = 'D4Hz WEB — High Frequency Audio', state = 'Voice Amplifier Active ⚡', startTime = null, imageUrl = null) {
  const img = imageUrl || DEFAULT_DEATH_GIF_URL;
  return {
    name: 'D4Hz',
    type: 0,
    application_id: DISCORD_APP_IDS[0],
    details: details,
    state: state,
    timestamps: {
      start: startTime || Date.now()
    },
    assets: {
      large_image: img,
      large_text: 'D4Hz — DEATH',
      small_image: img,
      small_text: 'D4Hz WEB'
    },
    buttons: [
      { label: 'D4Hz', url: 'https://github.com' }
    ]
  };
}

function updateLocalDiscordIpc(details, state, imageUrl = null) {
  if (process.platform !== 'win32') return;

  if (localDiscordPipe && !localDiscordPipe.destroyed) {
    sendIpcActivity(localDiscordPipe, details, state, imageUrl);
    return;
  }

  function tryConnectPipe(pipeIndex, appIdIndex = 0) {
    if (pipeIndex > 9) return;
    const pipePath = `\\\\?\\pipe\\discord-ipc-${pipeIndex}`;
    const clientId = DISCORD_APP_IDS[appIdIndex] || DISCORD_APP_IDS[0];

    try {
      const s = net.connect(pipePath, () => {
        localDiscordPipe = s;
        const handshake = JSON.stringify({ v: 1, client_id: clientId });
        const hBuf = Buffer.from(handshake);
        const hdr = Buffer.alloc(8);
        hdr.writeInt32LE(0, 0);
        hdr.writeInt32LE(hBuf.length, 4);
        s.write(Buffer.concat([hdr, hBuf]));
      });

      s.once('data', (d) => {
        try {
          const op = d.readInt32LE(0);
          const len = d.readInt32LE(4);
          const resStr = d.subarray(8, 8 + len).toString();
          if (resStr.includes('"code":4000') && appIdIndex + 1 < DISCORD_APP_IDS.length) {
            s.destroy();
            localDiscordPipe = null;
            tryConnectPipe(pipeIndex, appIdIndex + 1);
            return;
          }
        } catch (e) {}
        sendIpcActivity(s, details, state, imageUrl);
      });

      s.on('error', () => {
        if (localDiscordPipe === s) localDiscordPipe = null;
        tryConnectPipe(pipeIndex + 1, appIdIndex);
      });

      s.on('close', () => {
        if (localDiscordPipe === s) localDiscordPipe = null;
      });
    } catch (e) {
      tryConnectPipe(pipeIndex + 1, appIdIndex);
    }
  }

  tryConnectPipe(0);
}

function sendIpcActivity(socket, details, state, imageUrl = null) {
  try {
    const img = imageUrl || DEFAULT_DEATH_GIF_URL;
    const actPayload = JSON.stringify({
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: {
          name: 'D4Hz',
          type: 0,
          details: details || 'D4Hz WEB — High Frequency Audio',
          state: state || 'Voice Amplifier Active ⚡',
          timestamps: { start: Math.floor(Date.now() / 1000) },
          assets: {
            large_image: img,
            large_text: 'D4Hz — DEATH',
            small_image: img,
            small_text: 'D4Hz WEB'
          },
          buttons: [
            { label: 'D4Hz', url: 'https://github.com' }
          ]
        }
      },
      nonce: crypto.randomUUID()
    });
    const aBuf = Buffer.from(actPayload);
    const hdr = Buffer.alloc(8);
    hdr.writeInt32LE(1, 0);
    hdr.writeInt32LE(aBuf.length, 4);
    socket.write(Buffer.concat([hdr, aBuf]));
    console.log('[Relay] 🎮 Discord Desktop Profile Activity updated with DEATH.gif');
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════
//  NATIVE DISCORD VOICE CLIENT (Zero-dependency Node 24)
// ══════════════════════════════════════════════════════════
class NativeVoiceClient {
  constructor(token, isBot = false, username = '') {
    this.token = token.trim();
    this.isBot = !!isBot;
    this.username = username || (this.isBot ? 'Bot' : 'User');

    // Gateway State
    this.gwWs = null;
    this.gwHb = null;
    this.gwSeq = null;
    this.userId = null;
    this.sessionId = null;
    this.guildId = null;
    this.channelId = null;
    this.voiceStateReceived = false;
    this.retried4006 = false;

    // Voice Gateway State
    this.voiceWs = null;
    this.voiceHb = null;
    this.voiceToken = null;
    this.voiceEndpoint = null;
    this.ssrc = 0;
    this.voiceIp = null;
    this.voicePort = 0;
    this.secretKey = null;
    this.voiceMode = 'aead_aes256_gcm_rtpsize';
    this.udp = null;

    // Audio Repeating State
    this.isReady = false;
    this.seq = 1;
    this.timestamp = 0;
    this.packetCounter = 0;

    // Callbacks
    this.onTargetAudio = null;
  }

  // 1. Connect to main Discord Gateway
  connectGateway(guildId, channelId) {
    this.guildId = guildId;
    this.channelId = channelId;

    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`[${this.username}] Gateway connection timed out`));
        }
      }, 15000);

      try {
        this.gwWs = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
      } catch (e) {
        clearTimeout(timeout);
        return reject(e);
      }

      this.gwWs.onopen = () => {
        console.log(`[${this.username}] Gateway WS connected`);
      };

      this.gwWs.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.s) this.gwSeq = msg.s;

        switch (msg.op) {
          case 10: { // HELLO
            const interval = msg.d.heartbeat_interval;
            this._sendGwHeartbeat();
            this.gwHb = setInterval(() => this._sendGwHeartbeat(), interval);
            this._sendIdentify();
            break;
          }
          case 11: break; // Heartbeat ACK
          case 9: { // Invalid Session
            clearTimeout(timeout);
            if (!resolved) {
              resolved = true;
              reject(new Error(`[${this.username}] Invalid session / token rejected`));
            }
            break;
          }
          case 0: { // Dispatch
            if (msg.t === 'READY') {
              this.userId = msg.d.user.id;
              this.sessionId = msg.d.session_id;
              console.log(`[${this.username}] Gateway READY as ${msg.d.user.username} (${this.userId})`);

              // If user token, send Op 14 channel subscription
              if (!this.isBot && this.channelId) {
                try {
                  this.gwWs.send(JSON.stringify({
                    op: 14,
                    d: { guild_id: this.guildId, channels: { [this.channelId]: [[0, 99]] } }
                  }));
                } catch (e) {}
              }

              // Send Op 4 to join Voice Channel
              setTimeout(() => {
                this._sendJoinVC();
              }, 150);
            }

            if (msg.t === 'VOICE_STATE_UPDATE' && msg.d) {
              // Cache voice state
              if (msg.d.guild_id) {
                if (!voiceStatesByGuild.has(msg.d.guild_id)) {
                  voiceStatesByGuild.set(msg.d.guild_id, new Map());
                }
                const gMap = voiceStatesByGuild.get(msg.d.guild_id);
                if (msg.d.channel_id) {
                  gMap.set(msg.d.user_id, msg.d);
                } else {
                  gMap.delete(msg.d.user_id);
                }
              }

              if (msg.d.user_id === this.userId) {
                if (msg.d.channel_id) {
                  this.sessionId = msg.d.session_id;
                  this.voiceStateReceived = true;
                  console.log(`[${this.username}] ✅ VOICE_STATE_UPDATE: session_id=${this.sessionId}, channel_id=${msg.d.channel_id}`);
                  this._tryConnectVoiceWs();
                } else {
                  console.log(`[${this.username}] Disconnected from voice channel (channel_id is null)`);
                }
              }
            }

            if (msg.t === 'VOICE_SERVER_UPDATE' && msg.d) {
              if (msg.d.guild_id === this.guildId) {
                this.voiceToken = msg.d.token;
                this.voiceEndpoint = msg.d.endpoint;
                console.log(`[${this.username}] Voice server update: endpoint=${this.voiceEndpoint}`);
                this._tryConnectVoiceWs();
              }
            }
            break;
          }
        }
      };

      this.gwWs.onerror = (e) => {
        console.error(`[${this.username}] Gateway WS error:`, e.message || 'unknown');
      };

      this.gwWs.onclose = (e) => {
        console.log(`[${this.username}] Gateway WS closed (${e.code})`);
        if (this.gwHb) { clearInterval(this.gwHb); this.gwHb = null; }
      };

      // Store resolver for when voice handshake is complete
      this._voiceReadyResolve = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(this);
        }
      };
      this._voiceReadyReject = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      };
    });
  }

  _sendGwHeartbeat() {
    if (this.gwWs && this.gwWs.readyState === 1) {
      this.gwWs.send(JSON.stringify({ op: 1, d: this.gwSeq }));
    }
  }

  _sendIdentify() {
    if (!this.gwWs || this.gwWs.readyState !== 1) return;
    const act = buildDiscordActivity('D4Hz WEB — High Frequency Audio', 'Voice Amplifier Active ⚡', Date.now());
    const payload = this.isBot
      ? {
          token: this.token.startsWith('Bot ') ? this.token : `Bot ${this.token}`,
          intents: 641, // Guilds (1) | GuildVoiceStates (128) | GuildMessages (512)
          properties: { os: 'Windows', browser: 'Discord Client', device: 'desktop' },
          presence: { status: 'online', since: 0, activities: [{ name: 'D4Hz', type: 0, state: 'Voice Amplifier Active ⚡' }], afk: false }
        }
      : {
          token: this.token,
          capabilities: 16381,
          intents: 0,
          properties: {
            os: 'Windows', browser: 'Discord Client', device: '', system_locale: 'en-US',
            browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.5 Safari/537.36',
            browser_version: '32.2.5', os_version: '10.0.19045', release_channel: 'stable', client_build_number: 375492, client_event_source: null
          },
          presence: { status: 'online', since: 0, activities: [act], afk: false },
          compress: false
        };

    this.gwWs.send(JSON.stringify({ op: 2, d: payload }));
  }

  updatePresence(details, state, imageUrl = null) {
    if (!this.gwWs || this.gwWs.readyState !== 1) return;
    const act = buildDiscordActivity(details, state, this._presenceStart || Date.now(), imageUrl);
    this.gwWs.send(JSON.stringify({
      op: 3,
      d: {
        since: 0,
        activities: [act],
        status: 'online',
        afk: false
      }
    }));
  }

  _sendJoinVC() {
    if (!this.gwWs || this.gwWs.readyState !== 1) return;
    console.log(`[${this.username}] Sending Op 4 join Voice Channel: ${this.channelId}`);
    this.gwWs.send(JSON.stringify({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.channelId,
        self_mute: false,
        self_deaf: false
      }
    }));
  }

  // 2. Connect to Discord Voice Gateway WebSocket
  _tryConnectVoiceWs() {
    if (!this.voiceStateReceived || !this.voiceToken || !this.voiceEndpoint || this.voiceWs) {
      return;
    }

    const endpoint = this.voiceEndpoint.replace(/:443$/, '');
    const voiceWsUrl = `wss://${endpoint}/?v=8`;
    console.log(`[${this.username}] Connecting Voice WS: ${voiceWsUrl}`);

    try {
      this.voiceWs = new WebSocket(voiceWsUrl);
    } catch (e) {
      if (this._voiceReadyReject) this._voiceReadyReject(e);
      return;
    }

    this.voiceWs.onopen = () => {
      console.log(`[${this.username}] Voice WS connected`);
    };

    this.voiceWs.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.op) {
        case 8: { // HELLO
          const interval = msg.d.heartbeat_interval;

          console.log(`[${this.username}] Voice HELLO (interval: ${interval}ms). Sending Op 0 Identify (server: ${this.guildId}, user: ${this.userId})...`);
          this.voiceWs.send(JSON.stringify({
            op: 0,
            d: {
              server_id: String(this.guildId),
              user_id: String(this.userId),
              session_id: String(this.sessionId),
              token: this.voiceToken,
              video: false,
              streams: [],
              max_dave_protocol_version: 1
            }
          }));

          // Start voice heartbeat interval AFTER identify is dispatched
          if (this.voiceHb) clearInterval(this.voiceHb);
          this.voiceHb = setInterval(() => this._sendVoiceHeartbeat(), interval);
          break;
        }
        case 2: { // READY
          this.ssrc = msg.d.ssrc;
          this.voiceIp = msg.d.ip;
          this.voicePort = msg.d.port;
          console.log(`[${this.username}] Voice READY: ssrc=${this.ssrc}, ip=${this.voiceIp}:${this.voicePort}`);
          this._startUdpDiscovery();
          break;
        }
        case 4: { // SESSION_DESCRIPTION
          this.secretKey = Buffer.from(msg.d.secret_key);
          this.voiceMode = msg.d.mode || 'aead_aes256_gcm_rtpsize';
          console.log(`[${this.username}] Voice SESSION_DESCRIPTION: mode=${this.voiceMode}`);

          // Send Op 5 Speaking (1 = Microphone, 4 = Priority)
          this._sendSpeaking(true);

          this.isReady = true;
          if (this._voiceReadyResolve) this._voiceReadyResolve();
          break;
        }
        case 5: { // SPEAKING from other users
          if (msg.d && msg.d.user_id && msg.d.ssrc) {
            if (currentSession && msg.d.user_id === currentSession.targetUserId) {
              currentSession.targetSSRC = msg.d.ssrc;
              console.log(`[Relay] Identified target user ${msg.d.user_id} SSRC: ${msg.d.ssrc}`);
            }
          }
          break;
        }
      }
    };

    this.voiceWs.onerror = (e) => {
      console.error(`[${this.username}] Voice WS error:`, e.message || 'unknown');
    };

    this.voiceWs.onclose = (e) => {
      console.log(`[${this.username}] Voice WS closed (${e.code})`);
      if (this.voiceHb) { clearInterval(this.voiceHb); this.voiceHb = null; }

      if (e.code === 4006 && !this.retried4006) {
        this.retried4006 = true;
        console.log(`[${this.username}] Received 4006 (Session not ready) — retrying fresh voice join in 500ms...`);
        this.voiceWs = null;
        this.voiceToken = null;
        this.voiceStateReceived = false;
        setTimeout(() => this._sendJoinVC(), 500);
        return;
      }

      if (!this.isReady && this._voiceReadyReject) {
        this._voiceReadyReject(new Error(`Voice connection closed (${e.code})`));
      }
    };
  }

  _sendVoiceHeartbeat() {
    if (this.voiceWs && this.voiceWs.readyState === 1) {
      this.voiceWs.send(JSON.stringify({ op: 3, d: Date.now() }));
    }
  }

  _sendSpeaking(speaking = true) {
    if (!this.voiceWs || this.voiceWs.readyState !== 1) return;
    this.voiceWs.send(JSON.stringify({
      op: 5,
      d: {
        speaking: speaking ? 5 : 0, // 5 = Mic + Priority
        delay: 0,
        ssrc: this.ssrc
      }
    }));
  }

  // 3. UDP IP Discovery and Protocol Selection
  _startUdpDiscovery() {
    try {
      this.udp = dgram.createSocket('udp4');
    } catch (e) {
      if (this._voiceReadyReject) this._voiceReadyReject(e);
      return;
    }

    this.udp.on('message', (msg) => {
      if (msg.length === 74) {
        // IP discovery response
        let nullIdx = -1;
        for (let i = 8; i < 72; i++) {
          if (msg[i] === 0) { nullIdx = i; break; }
        }
        const myIp = msg.toString('utf8', 8, nullIdx > 8 ? nullIdx : 72);
        const myPort = msg.readUInt16BE(72);
        console.log(`[${this.username}] UDP Discovery complete: ${myIp}:${myPort}`);

        // Send Op 1 Select Protocol
        if (this.voiceWs && this.voiceWs.readyState === 1) {
          this.voiceWs.send(JSON.stringify({
            op: 1,
            d: {
              protocol: 'udp',
              data: {
                address: myIp,
                port: myPort,
                mode: 'aead_aes256_gcm_rtpsize'
              }
            }
          }));
        }
      } else if (msg.length >= 12 && this.onTargetAudio) {
        // Handle incoming RTP audio
        this.onTargetAudio(msg);
      }
    });

    this.udp.on('error', (err) => {
      console.error(`[${this.username}] UDP error:`, err.message);
    });

    // Send 74-byte IP Discovery request
    const discoveryPacket = Buffer.alloc(74);
    discoveryPacket.writeUInt16BE(0x0001, 0); // Request
    discoveryPacket.writeUInt16BE(70, 2);     // Length
    discoveryPacket.writeUInt32BE(this.ssrc, 4); // SSRC
    this.udp.send(discoveryPacket, this.voicePort, this.voiceIp);
  }

  // 4. Send Opus audio frame via this account's UDP socket
  sendRtpOpus(opusBuffer) {
    if (!this.udp || !this.secretKey || !this.voicePort || !this.voiceIp) return;

    try {
      // 12-byte RTP header
      const header = Buffer.alloc(12);
      header[0] = 0x80; // Version 2
      header[1] = 0x78; // Payload type 120 (Opus)
      header.writeUInt16BE(this.seq & 0xFFFF, 2);
      this.seq = (this.seq + 1) & 0xFFFF;
      header.writeUInt32BE(this.timestamp >>> 0, 4);
      this.timestamp = (this.timestamp + 960) >>> 0; // 20ms @ 48kHz
      header.writeUInt32BE(this.ssrc >>> 0, 8);

      // AES-256-GCM encryption with 4-byte counter
      const nonce = Buffer.alloc(12, 0);
      nonce.writeUInt32BE(this.packetCounter >>> 0, 0);

      const cipher = crypto.createCipheriv('aes-256-gcm', this.secretKey, nonce);
      cipher.setAAD(header);
      const encrypted = Buffer.concat([cipher.update(opusBuffer), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(this.packetCounter >>> 0, 0);
      this.packetCounter = (this.packetCounter + 1) >>> 0;

      const rtpPacket = Buffer.concat([header, encrypted, authTag, counterBuf]);
      this.udp.send(rtpPacket, this.voicePort, this.voiceIp);
    } catch (e) {
      // Silently discard packet encryption drop
    }
  }

  destroy() {
    this.isReady = false;
    if (this.gwHb) { clearInterval(this.gwHb); this.gwHb = null; }
    if (this.voiceHb) { clearInterval(this.voiceHb); this.voiceHb = null; }

    // Leave VC on Gateway
    if (this.gwWs && this.gwWs.readyState === 1 && this.guildId) {
      try {
        this.gwWs.send(JSON.stringify({
          op: 4,
          d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
        }));
      } catch (e) {}
    }

    if (this.voiceWs) { try { this.voiceWs.close(1000); } catch (e) {} this.voiceWs = null; }
    if (this.gwWs) { try { this.gwWs.close(1000); } catch (e) {} this.gwWs = null; }
    if (this.udp) { try { this.udp.close(); } catch (e) {} this.udp = null; }
    console.log(`[${this.username}] Client destroyed and disconnected`);
  }
}

function maskToken(token) {
  if (!token || typeof token !== 'string') return '***';
  return token.length > 8 ? `${token.slice(0, 6)}...***` : '***';
}


// ══════════════════════════════════════════════════════════
//  SOUNDPAD DISCORD BROADCASTER & OPUS EXTRACTOR
// ══════════════════════════════════════════════════════════
let soundpadTimer = null;

function stopSoundpad() {
  if (soundpadTimer) {
    clearInterval(soundpadTimer);
    soundpadTimer = null;
  }
}

function extractOpusFromWebM(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0xA3) { // SimpleBlock
      let lenByte = buf[i + 1];
      let len = 0, lenLen = 0;
      if (lenByte & 0x80) { len = lenByte & 0x7F; lenLen = 1; }
      else if (lenByte & 0x40) { len = ((lenByte & 0x3F) << 8) | buf[i + 2]; lenLen = 2; }
      else if (lenByte & 0x20) { len = ((lenByte & 0x1F) << 16) | (buf[i + 2] << 8) | buf[i + 3]; lenLen = 3; }
      
      if (len > 4 && i + 1 + lenLen + len <= buf.length) {
        const blockStart = i + 1 + lenLen;
        const opusData = buf.subarray(blockStart + 4, blockStart + len);
        if (opusData.length > 0) frames.push(opusData);
        i = blockStart + len;
        continue;
      }
    }
    i++;
  }
  return frames;
}

function playSoundpadOpus(frames) {
  stopSoundpad();
  if (!frames || !frames.length) return;
  console.log(`[Soundpad] Broadcasting ${frames.length} Opus frames to ${activeClients.size} voice clients...`);
  
  // Set all clients to speaking mode
  for (const [, client] of activeClients) {
    client._sendSpeaking(true);
  }

  let idx = 0;
  soundpadTimer = setInterval(() => {
    if (idx >= frames.length || activeClients.size === 0) {
      stopSoundpad();
      console.log('[Soundpad] Playback finished');
      return;
    }
    const frame = frames[idx];
    for (const [, client] of activeClients) {
      if (client.isReady) {
        client.sendRtpOpus(frame);
      }
    }
    idx++;
  }, 20);
}

// ══════════════════════════════════════════════════════════
//  HTTP SERVER & REST / RELAY ENDPOINTS
// ══════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  // Enforce local network security origin policy (localhost or local LAN for mobile)
  const origin = req.headers.origin;
  const isLocalOrigin = !origin || origin === 'null' ||
    origin.includes('localhost') || origin.includes('127.0.0.1') ||
    origin.includes('192.168.') || origin.includes('10.') || origin.includes('172.');
  if (!isLocalOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Forbidden: Origin blocked under Discord Security Guidelines' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Captcha-Key, X-Captcha-Rqtoken');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, 'http://localhost');

  // Static web app serving for mobile & desktop browsers
  if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  if (req.method === 'GET' && (reqUrl.pathname === '/DEATH.gif' || reqUrl.pathname === '/death.gif')) {
    const filePath = path.join(__dirname, 'DEATH.gif');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // 1. GET /invite-info?code=...
  if (req.method === 'GET' && reqUrl.pathname === '/invite-info') {
    const code = reqUrl.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing code' }));
      return;
    }
    const cleanCode = code.replace(/^https?:\/\/(www\.)?(discord\.gg\/|discord(app)?\.com\/invite\/)/i, '').trim();
    try {
      const dRes = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(cleanCode)}?with_counts=true`);
      const data = await dRes.json();
      res.writeHead(dRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 1b. POST /join-invite — Join server via Discord invite with rate-limiting backoff & member onboarding
  if (req.method === 'POST' && (reqUrl.pathname === '/join-invite' || req.url === '/join-invite')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { accounts, inviteCode } = JSON.parse(body || '{}');
        const cleanCode = (inviteCode || '').replace(/^https?:\/\/(www\.)?(discord\.gg\/|discord(app)?\.com\/invite\/)/i, '').trim();
        const results = [];

        for (const acc of (accounts || [])) {
          try {
            let res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(cleanCode)}`, {
              method: 'POST',
              headers: {
                'Authorization': acc.token,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({})
            });

            if (res.status === 429) {
              const retryAfter = parseFloat(res.headers.get('retry-after') || '2');
              await new Promise(r => setTimeout(r, (retryAfter * 1000) + 200));
              res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(cleanCode)}`, {
                method: 'POST',
                headers: { 'Authorization': acc.token, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
              });
            }

            const data = await res.json();

            // Handle member onboarding / verification rules if guild requires it
            if (res.ok && data.guild_id) {
              let subRes = await fetch(`https://discord.com/api/v10/guilds/${data.guild_id}/onboarding`, {
                headers: { 'Authorization': acc.token }
              });
              if (subRes.status === 429) {
                const subRetry = parseFloat(subRes.headers.get('retry-after') || '1.5');
                await new Promise(r => setTimeout(r, (subRetry * 1000) + 100));
                subRes = await fetch(`https://discord.com/api/v10/guilds/${data.guild_id}/onboarding`, {
                  headers: { 'Authorization': acc.token }
                });
              }
            }

            results.push({
              username: acc.username,
              ok: res.ok,
              token: maskToken(acc.token),
              guild: data.guild || null
            });
          } catch (err) {
            results.push({
              username: acc.username,
              ok: false,
              token: maskToken(acc.token),
              error: err.message
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /play-sound — Broadcast soundpad Opus frames to all connected VC clients
  if (req.method === 'POST' && (reqUrl.pathname === '/play-sound' || req.url === '/play-sound')) {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const fullBuf = Buffer.concat(chunks);
        let frames = [];
        // Check if payload is JSON with base64 frames or raw WebM
        if (fullBuf[0] === 0x7B) { // '{'
          const data = JSON.parse(fullBuf.toString('utf8'));
          if (Array.isArray(data.frames)) {
            frames = data.frames.map(f => Buffer.from(f, 'base64'));
          } else if (data.webm) {
            frames = extractOpusFromWebM(Buffer.from(data.webm, 'base64'));
          }
        } else {
          // Direct WebM binary
          frames = extractOpusFromWebM(fullBuf);
        }

        if (frames.length > 0) {
          playSoundpadOpus(frames);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, framesPlayed: frames.length }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No valid Opus audio frames found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /stop-sound — Stop soundpad playback
  if (req.method === 'POST' && (reqUrl.pathname === '/stop-sound' || req.url === '/stop-sound')) {
    stopSoundpad();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /fetch-vc-users — Actively fetch users in voice channel via quick Gateway scan
  if (req.method === 'POST' && reqUrl.pathname === '/fetch-vc-users') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { token, isBot, guildId, channelId } = JSON.parse(body);
        if (!guildId || !channelId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing guildId or channelId' }));
          return;
        }

        // Check if we already have them in voiceStatesByGuild
        const gMap = voiceStatesByGuild.get(guildId);
        const users = [];
        if (gMap) {
          for (const [uid, vs] of gMap) {
            if (vs.channel_id === channelId) {
              users.push({ user_id: uid, channel_id: vs.channel_id, member: vs.member });
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, users, count: users.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 2. GET /vc-users?guildId=...&channelId=...
  if (req.method === 'GET' && reqUrl.pathname === '/vc-users') {
    const guildId = reqUrl.searchParams.get('guildId');
    const channelId = reqUrl.searchParams.get('channelId');

    const users = [];
    if (guildId && voiceStatesByGuild.has(guildId)) {
      const gMap = voiceStatesByGuild.get(guildId);
      for (const [uid, vs] of gMap) {
        if (!channelId || vs.channel_id === channelId) {
          users.push({
            user_id: uid,
            channel_id: vs.channel_id,
            member: vs.member
          });
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: users.length, users }));
    return;
  }

  // 5. POST /start — start voice relay and audio amplification
  if (req.method === 'POST' && (reqUrl.pathname === '/start' || req.url === '/start')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = JSON.parse(body);
        const result = await startVoiceRelay(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 6. POST /stop — stop all voice connections
  if (req.method === 'POST' && (reqUrl.pathname === '/stop' || req.url === '/stop')) {
    await stopAllClients();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 7. GET /status
  if (req.method === 'GET' && (reqUrl.pathname === '/status' || req.url === '/status')) {
    const clientsList = [];
    for (const [tk, c] of activeClients) {
      clientsList.push({
        username: c.username,
        isBot: c.isBot,
        isReady: c.isReady,
        ssrc: c.ssrc
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      active: activeClients.size,
      targetUserId: currentSession ? currentSession.targetUserId : null,
      targetSSRC: currentSession ? currentSession.targetSSRC : null,
      repeatingActive: !!(currentSession && currentSession.targetSSRC),
      clients: clientsList
    }));
    return;
  }

  // 8. GET /DEATH.gif — Serve local DEATH.gif file
  if (req.method === 'GET' && (reqUrl.pathname === '/DEATH.gif' || req.url === '/DEATH.gif')) {
    const gifPath = path.join(__dirname, 'DEATH.gif');
    if (fs.existsSync(gifPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(gifPath).pipe(res);
    } else {
      res.writeHead(302, { 'Location': DEFAULT_DEATH_GIF_URL });
      res.end();
    }
    return;
  }

  // 9. POST /update-activity — Update Discord Rich Presence and Profile Activity
  if (req.method === 'POST' && (reqUrl.pathname === '/update-activity' || req.url === '/update-activity')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { details, state, imageUrl } = JSON.parse(body || '{}');
        for (const [, c] of activeClients) {
          c.updatePresence(details, state, imageUrl);
        }
        updateLocalDiscordIpc(details, state, imageUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, details, state }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// ══════════════════════════════════════════════════════════
//  VOICE RELAY MANAGEMENT & AUDIO REPEATING
// ══════════════════════════════════════════════════════════
async function stopAllClients() {
  for (const [, client] of activeClients) {
    try {
      client.updatePresence('D4Hz WEB — High Frequency Audio', 'Voice Amplifier Idle');
      client.destroy();
    } catch (e) {}
  }
  activeClients.clear();
  currentSession = null;
  updateLocalDiscordIpc('D4Hz WEB — High Frequency Audio', 'Voice Amplifier Idle');
  console.log('[Relay] All clients disconnected and stopped');
}

async function startVoiceRelay(cfg) {
  await stopAllClients();

  const { accounts, guildId, channelId, targetUserId } = cfg;
  if (!accounts || !accounts.length || !guildId || !channelId) {
    throw new Error('Missing required configuration (accounts, guildId, channelId)');
  }

  currentSession = {
    guildId,
    channelId,
    targetUserId: targetUserId || null,
    targetSSRC: null,
    packetsForwarded: 0
  };

  console.log(`[Relay] Starting voice amplification on guild ${guildId}, VC ${channelId} for ${accounts.length} accounts...`);
  if (targetUserId) {
    console.log(`[Relay] 🎯 Target User: ${targetUserId}`);
  }

  const connectedList = [];
  const clientInstances = [];

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    try {
      const client = new NativeVoiceClient(acc.token, acc.isBot, acc.username);
      clientInstances.push(client);

      // Connect gateway and voice
      await client.connectGateway(guildId, channelId);
      activeClients.set(acc.token, client);
      connectedList.push({ username: acc.username, ok: true, token: maskToken(acc.token) });
      console.log(`[Relay] ✅ [${acc.username || i}] fully connected to VC!`);

      // Every client listens for incoming audio from target / active speaker
      client.onTargetAudio = (rawRtp) => {
        if (!currentSession || rawRtp.length < 16) return;

        const packetSsrc = rawRtp.readUInt32BE(8);

        // Ignore our own accounts' audio packets to prevent feedback echo loops
        for (const c of clientInstances) {
          if (c && c.ssrc === packetSsrc) return;
        }

        // If target SSRC is specified, filter for it; otherwise auto-amplify whichever user speaks
        if (currentSession.targetSSRC && packetSsrc !== currentSession.targetSSRC) {
          return;
        } else if (!currentSession.targetSSRC) {
          currentSession.targetSSRC = packetSsrc;
          console.log(`[Relay] 🎯 Auto-locked active speaker SSRC: ${packetSsrc}`);
        }

        // Decrypt incoming Opus packet from voice stream
        let opusData = null;
        try {
          if (client.voiceMode === 'aead_aes256_gcm_rtpsize' && client.secretKey) {
            const recvCounter = rawRtp.readUInt32BE(rawRtp.length - 4);
            const nonce = Buffer.alloc(12, 0);
            nonce.writeUInt32BE(recvCounter >>> 0, 0);

            const decipher = crypto.createDecipheriv('aes-256-gcm', client.secretKey, nonce);
            decipher.setAAD(rawRtp.subarray(0, 12));
            decipher.setAuthTag(rawRtp.subarray(rawRtp.length - 20, rawRtp.length - 4));
            opusData = Buffer.concat([decipher.update(rawRtp.subarray(12, rawRtp.length - 20)), decipher.final()]);
          } else {
            opusData = rawRtp.subarray(12);
          }
        } catch (decErr) {
          return;
        }

        if (!opusData || !opusData.length) return;

        // Forward and amplify Opus audio to ALL active clients
        for (const ampClient of clientInstances) {
          if (ampClient && ampClient.isReady && ampClient.ssrc !== packetSsrc) {
            ampClient.sendRtpOpus(opusData);
          }
        }

        currentSession.packetsForwarded++;
        if (currentSession.packetsForwarded % 200 === 0) {
          console.log(`[Relay] 📢 Relaying voice — ${currentSession.packetsForwarded} packets amplified!`);
        }
      };
    } catch (err) {
      console.error(`[Relay] ❌ [${acc.username || i}] failed:`, err.message);
      connectedList.push({ username: acc.username, ok: false, token: maskToken(acc.token), error: err.message });
    }

    if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 1800 + Math.random() * 800)); // Anti-violation human stagger
  }

  // Update Discord Profile Activity with DEATH.gif for all connected voice clients and local desktop
  const actDetails = targetUserId ? `Amplifying Target User` : 'D4Hz WEB — High Frequency Audio';
  const actState = `Amplifying Voice in VC ⚡`;
  updateLocalDiscordIpc(actDetails, actState);
  for (const [, c] of activeClients) {
    try { c.updatePresence(actDetails, actState); } catch (e) {}
  }

  return {
    ok: true,
    connected: activeClients.size,
    total: accounts.length,
    results: connectedList
  };
}

process.on('SIGINT', async () => {
  await stopAllClients();
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`====================================================`);
  console.log(`🚀 D4Hz WEB Voice Relay Backend active on http://127.0.0.1:${PORT}`);
  console.log(`⚡ Zero-dependency native Node 24 voice client engine`);
  console.log(`====================================================`);
});
