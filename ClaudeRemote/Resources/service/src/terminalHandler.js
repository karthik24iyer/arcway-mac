class TerminalHandler {
  constructor(config, sessionManager) {
    this.pty = sessionManager.pty;
    // Map<sessionId, Set<connectionId>>
    this.activeSessions = new Map();
  }

  async attachToSession(sessionId, connectionId, ws) {
    // 1. Dump scrollback first
    const scrollback = this.pty.getScrollback(sessionId);
    if (scrollback && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal_output', data: { session_id: sessionId, output: scrollback } }));
    }

    // 2. Attach client PTY — live stream from here
    this.pty.attachClient(sessionId, connectionId,
      (data) => {
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'terminal_output', data: { session_id: sessionId, output: data } }));
      },
      () => {
        // tmux session died — notify client
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'status_update', data: { session_id: sessionId, status: 'idle' } }));
      }
    );

    if (!this.activeSessions.has(sessionId)) this.activeSessions.set(sessionId, new Set());
    this.activeSessions.get(sessionId).add(connectionId);
  }

  async detachFromSession(sessionId, connectionId) {
    this.pty.detachClient(sessionId, connectionId);
    this.activeSessions.get(sessionId)?.delete(connectionId);
    if (this.activeSessions.get(sessionId)?.size === 0) this.activeSessions.delete(sessionId);
  }

  async sendInput(sessionId, connectionId, input) {
    this.pty.sendInput(sessionId, connectionId, input);
  }

  async handleSpecialKeys(sessionId, connectionId, key) {
    const keyMap = { enter: '\r', escape: '\x1b', tab: '\t', ctrl_c: '\x03', ctrl_d: '\x04', ctrl_z: '\x1a' };
    this.pty.sendInput(sessionId, connectionId, keyMap[key] ?? '');
  }

  async resizeTerminal(sessionId, connectionId, rows, cols) {
    this.pty.resizeClient(sessionId, connectionId, cols, rows);
    return { success: true, terminalSize: { rows, cols } };
  }

  getActiveStreams() { return [...this.activeSessions.keys()]; }

  async cleanup() {
    for (const [sessionId, clients] of this.activeSessions) {
      for (const clientId of clients) this.pty.detachClient(sessionId, clientId);
    }
    this.activeSessions.clear();
  }
}

module.exports = TerminalHandler;
