class TerminalHandler {
  constructor(config, sessionManager) {
    this.pty = sessionManager.pty;
    // Map<sessionId, Set<connectionId>>
    this.activeSessions = new Map();
  }

  // cols/rows passed through from connectionState so the initial tmux attach
  // uses the client's actual screen size — avoids the aggressive-resize reflow
  // that happened with the old hardcoded 80x24. Defaults match main branch's
  // generous starting size so Claude's output isn't word-wrapped too early.
  async attachToSession(sessionId, connectionId, ws, cols = 220, rows = 50) {
    // Populate xterm scrollback with tmux history ABOVE the current visible pane.
    // tmux attach-session only redraws the current screen — it never sends past history,
    // which is why the xterm widget's scrollback was nearly empty before this fix.
    // We use -E -1 (stop before the visible pane) so there's zero overlap with the
    // full-screen redraw that tmux attach-session sends immediately after.
    const history = this.pty.getScrollback(sessionId);
    if (history && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal_output', data: { session_id: sessionId, output: history } }));
    }

    this.pty.attachClient(sessionId, connectionId,
      (data) => {
        if (ws.readyState === 1) {
          // Strip alternate-screen enter/exit sequences so Claude's conversation
          // stays on the main screen buffer and is scrollable in the terminal widget.
          // Claude uses \x1b[?1049h to enter alternate screen — without this strip,
          // scrolling up shows old shell history instead of the chat.
          // The clear+reposition sequences (\x1b[2J\x1b[H) that follow still run,
          // giving Claude a clean canvas on the main screen.
          const out = data.replace(/\x1b\[\?1049[hl]/g, '');
          ws.send(JSON.stringify({ type: 'terminal_output', data: { session_id: sessionId, output: out } }));
        }
      },
      () => {
        // tmux session died — notify client
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'status_update', data: { session_id: sessionId, status: 'idle' } }));
      },
      cols,
      rows
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
    if (rows < 1 || rows > 200 || cols < 1 || cols > 500) {
      return { success: true, terminalSize: { rows, cols } }; // ignore bogus dimensions
    }
    // Guard: resize may race ahead of connect (borrowed from main) — silently ignore
    if (!this.activeSessions.get(sessionId)?.has(connectionId)) {
      return { success: true, terminalSize: { rows, cols } };
    }
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
