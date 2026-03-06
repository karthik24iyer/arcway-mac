const pty = require('node-pty');
const { execSync, spawnSync } = require('child_process');

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
    try { execSync(`tmux has-session -t ${sessionId}`); return true; } catch { return false; }
  }

  getScrollback(sessionId) {
    try {
      // Capture only lines ABOVE the current visible pane (-E -1).
      // This is the tmux history that never reaches the xterm widget via attach-session,
      // which only redraws the current screen. Excluding the visible pane (-E -1) means
      // no overlap with the full-screen redraw that follows.
      // -J joins lines that tmux hard-wrapped at pane width (220 cols), so the xterm
      // widget can soft-wrap them at its own width instead of double-wrapping.
      // -J also implies -T which strips trailing spaces tmux uses to pad lines.
      return execSync(`tmux capture-pane -t ${sessionId} -p -S -2000 -E -1 -e -J`).toString();
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
    try { execSync(`tmux kill-session -t ${sessionId}`); } catch {}
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

  listRunningSessions() {
    try {
      return execSync('tmux list-sessions').toString().trim().split('\n')
        .filter(l => l)
        .map(l => l.split(':')[0]);
    } catch { return []; }
  }
}

module.exports = PTYInterface;
