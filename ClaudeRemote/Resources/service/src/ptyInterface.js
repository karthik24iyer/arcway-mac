const pty = require('node-pty');
const { execSync } = require('child_process');

class PTYInterface {
  constructor(config) {
    // Guard: tmux must be installed
    try {
      execSync('which tmux');
    } catch {
      throw new Error('tmux is not installed or not in PATH');
    }

    // sessions: Map<sessionId, Map<clientId, { ptyProcess }>>
    this.sessions = new Map();
  }

  startSession(sessionId, cwd, claudeArgs) {
    const args = claudeArgs.length ? ` ${claudeArgs.join(' ')}` : '';
    execSync(`tmux new-session -d -s ${sessionId} -c '${cwd}' "claude${args}"`);
  }

  sessionExists(sessionId) {
    try { execSync(`tmux has-session -t ${sessionId}`); return true; } catch { return false; }
  }

  getScrollback(sessionId) {
    return execSync(`tmux capture-pane -t ${sessionId} -p -S -50000 -e`).toString();
  }

  attachClient(sessionId, clientId, onData, onExit) {
    const clientPty = pty.spawn('tmux', ['attach-session', '-t', sessionId], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });

    clientPty.on('data', onData);
    clientPty.on('exit', onExit);

    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, new Map());
    this.sessions.get(sessionId).set(clientId, { ptyProcess: clientPty });
  }

  sendInput(sessionId, clientId, data) {
    this.sessions.get(sessionId)?.get(clientId)?.ptyProcess.write(data);
  }

  resizeClient(sessionId, clientId, cols, rows) {
    this.sessions.get(sessionId)?.get(clientId)?.ptyProcess.resize(cols, rows);
  }

  killSession(sessionId) {
    try { execSync(`tmux kill-session -t ${sessionId}`); } catch {}
    this.sessions.delete(sessionId);
  }

  detachClient(sessionId, clientId) {
    const client = this.sessions.get(sessionId)?.get(clientId);
    if (client) {
      client.ptyProcess.kill();
      this.sessions.get(sessionId).delete(clientId);
    }
  }

  listRunningSessions() {
    try {
      return execSync('tmux list-sessions').toString().trim().split('\n')
        .filter(l => l)
        .map(l => l.split(':')[0]);
    } catch { return []; }
  }
}

module.exports = PTYInterface;
