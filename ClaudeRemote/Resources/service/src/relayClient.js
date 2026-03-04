const WebSocket = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEVICE_CRED_PATH = path.join(os.homedir(), '.claude-remote', 'device.json');

class AppSession extends EventEmitter {
  constructor(relayWs) {
    super();
    this._ws = relayWs;
    this.readyState = 1; // WebSocket.OPEN
    this.OPEN = 1;       // ws library adds this to WebSocket.prototype; mirror it here
  }
  deliver(rawData) { if (this.readyState === 1) this.emit('message', rawData); }
  send(data)       { if (this._ws.readyState === 1) this._ws.send(data); }
  ping()           {} // relay handles its own keepalive
  close()          {} // no-op: relay WS lifecycle not controlled by server.js
  destroy() {
    this.readyState = 3; // WebSocket.CLOSED
    this.emit('close');  // triggers server.js handleConnectionClose
    this.removeAllListeners();
  }
}

class RelayClient {
  constructor(relayUrl, onClientConnected) {
    this.relayUrl = relayUrl;
    this.onClientConnected = onClientConnected;
    this.ws = null;
    this.reconnectDelay = 5000;
    this.stopping = false;
    this._currentSession = null;
  }

  start() {
    this._connect();
  }

  stop() {
    this.stopping = true;
    if (this.ws) this.ws.close();
  }

  _connect() {
    if (this.stopping) return;

    const envCredential = process.env.DEVICE_CREDENTIAL;
    const credential = envCredential || this._loadCredential();
    const deviceToken = process.env.DEVICE_TOKEN;

    if (!credential && !deviceToken) {
      console.error('RelayClient: no DEVICE_TOKEN env var and no saved credential at', DEVICE_CRED_PATH);
      process.exit(1);
    }

    console.log(`RelayClient: connecting to ${this.relayUrl}/agent`);
    this.ws = new WebSocket(`${this.relayUrl}/agent`);

    this.ws.on('open', () => {
      console.log('RelayClient: connected to relay');
      if (credential) {
        this.ws.send(JSON.stringify({ type: 'auth', device_credential: credential }));
      } else {
        this.ws.send(JSON.stringify({ type: 'auth', device_token: deviceToken, name: os.hostname() }));
      }
    });

    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'authenticated') {
        console.log('STATUS:connected');
      } else if (msg.type === 'registered') {
        this._saveCredential(msg.device_credential);
        console.log('STATUS:registered');
      } else if (msg.type === 'client_connected') {
        console.log('RelayClient: client connected via relay');
        this._currentSession?.destroy();
        this._currentSession = new AppSession(this.ws);
        this.onClientConnected(this._currentSession, { email: msg.user_email });
      } else if (msg.type === 'error') {
        console.error('RelayClient: relay error:', msg.message);
      } else {
        this._currentSession?.deliver(data);
      }
    });

    this.ws.on('close', () => {
      console.log('STATUS:disconnected');
      console.log(`RelayClient: disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
      this._currentSession?.destroy();
      this._currentSession = null;
      if (!this.stopping) {
        setTimeout(() => this._connect(), this.reconnectDelay);
      }
    });

    this.ws.on('error', (err) => {
      console.error('RelayClient: ws error:', err.message);
    });
  }

  _loadCredential() {
    try {
      if (fs.existsSync(DEVICE_CRED_PATH)) {
        return JSON.parse(fs.readFileSync(DEVICE_CRED_PATH, 'utf8')).device_credential;
      }
    } catch { /* fall through */ }
    return null;
  }

  _saveCredential(cred) {
    const dir = path.dirname(DEVICE_CRED_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEVICE_CRED_PATH, JSON.stringify({ device_credential: cred }, null, 2));
  }
}

module.exports = RelayClient;
