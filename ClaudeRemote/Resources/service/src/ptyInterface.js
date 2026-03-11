const pty = require('node-pty');
const { execSync, spawnSync } = require('child_process');
const { normalizeTmuxSGR } = require('./sgrNormalizer');

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
    // Use array-form to avoid shell injection on cwd
    const claudeCmd = claudeArgs.length ? `claude ${claudeArgs.join(' ')}` : 'claude';
    const result = spawnSync('tmux', ['new-session', '-d', '-s', sessionId, '-c', cwd, claudeCmd]);
    if (result.error) throw result.error;
  }

  sessionExists(sessionId) {
    const result = spawnSync('tmux', ['has-session', '-t', sessionId]);
    return result.status === 0;
  }

  getScrollback(sessionId) {
    try {
      // -e includes SGR color codes; normalizeTmuxSGR collapses tmux's per-cell SGR
      // into combined sequences that xterm.dart renders correctly.
      const result = spawnSync('tmux', ['capture-pane', '-t', sessionId, '-p', '-e', '-S', '-2000', '-E', '-1', '-J']);
      const raw = (result.stdout || Buffer.alloc(0)).toString('utf8');
      return normalizeTmuxSGR(raw).replace(/\r?\n/g, '\r\n');
    } catch { return ''; }
  }

  // cols/rows borrowed from main's PTY pattern — pass actual client dimensions
  // rather than hardcoding 80x24, which forces tmux aggressive-resize to squish content
  attachClient(sessionId, clientId, onData, onExit, cols = 220, rows = 50) {
    const clientPty = pty.spawn('tmux', ['attach-session', '-t', sessionId], {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });

    clientPty.on('data', onData);
    // Only fire onExit when tmux session itself dies, not when we detach the client.
    // detachClient removes this listener before kill() so it won't misfire.
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
    try { spawnSync('tmux', ['kill-session', '-t', sessionId]); } catch {}
    this.sessions.delete(sessionId);
  }

  detachClient(sessionId, clientId) {
    const client = this.sessions.get(sessionId)?.get(clientId);
    if (client) {
      // Remove exit listener first so kill() doesn't fire the onExit callback
      // and incorrectly mark the tmux session as dead (borrowed from main's pattern)
      client.ptyProcess.removeAllListeners('exit');
      client.ptyProcess.kill();
      this.sessions.get(sessionId).delete(clientId);
    }
  }

}

module.exports = PTYInterface;
