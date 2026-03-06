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
      // Capture only lines ABOVE the current visible pane (-E -1) so there's no overlap
      // with the full-screen redraw that tmux attach-session sends right after.
      // -J joins lines tmux hard-wrapped at pane width so xterm can soft-wrap at its own width.
      // No -e: plain text avoids per-cell SGR sequences that xterm.dart renders incorrectly.
      // \r\n conversion: capture-pane outputs bare \n (pipe, no PTY onlcr translation).
      // xterm.dart follows VT100 where \n = cursor-down only (no CR), causing a staircase
      // effect. The live PTY stream already has \r\n via node-pty's onlcr. We match that here.
      const raw = execSync(`tmux capture-pane -t ${sessionId} -p -S -2000 -E -1 -J`).toString();
      return raw.replace(/\r?\n/g, '\r\n');
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
