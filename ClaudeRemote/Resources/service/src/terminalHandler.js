class TerminalHandler {
  constructor(config, sessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.activeStreams = new Map(); // sessionId -> stream info

    console.log('🖥️  TerminalHandler initialized');
  }

  async attachToSession(sessionId, websocket, connectionState = null) {
    try {
      console.log(`📡 Attaching to terminal session: ${sessionId}`);

      const sessionStatus = await this.sessionManager.getSessionStatus(sessionId);
      if (!sessionStatus.success) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const streamInfo = {
        sessionId,
        websocket,
        connectionState,
        isActive: true,
        attachedAt: new Date().toISOString()
      };

      this.activeStreams.set(sessionId, streamInfo);

      await this.startOutputStreaming(sessionId);

      console.log(`✅ Attached to terminal session: ${sessionId}`);

      return { success: true };
    } catch (error) {
      console.error(`❌ Error attaching to session ${sessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async detachFromSession(sessionId) {
    try {
      console.log(`🔌 Detaching from terminal session: ${sessionId}`);

      const streamInfo = this.activeStreams.get(sessionId);
      if (streamInfo) {
        streamInfo.isActive = false;
        this.activeStreams.delete(sessionId);
      }

      console.log(`✅ Detached from terminal session: ${sessionId}`);
      return { success: true };
    } catch (error) {
      console.error(`❌ Error detaching from session ${sessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async sendInput(sessionId, input, sequenceNumber = null) {
    try {
      const streamInfo = this.activeStreams.get(sessionId);
      if (!streamInfo || !streamInfo.isActive) {
        throw new Error(`No active stream for session: ${sessionId}`);
      }

      const result = await this.sessionManager.pty.sendKeys(sessionId, input);

      if (!result.success) {
        throw new Error(`Failed to send input: ${result.error}`);
      }

      console.log(`⌨️  Input sent to session ${sessionId}: ${input.substring(0, 50)}${input.length > 50 ? '...' : ''}`);

      return { success: true };
    } catch (error) {
      console.error(`❌ Error sending input to session ${sessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async handleSpecialKeys(sessionId, key, modifiers = []) {
    try {
      const keyMappings = {
        'ctrl_c': 'ctrl_c',
        'ctrl_d': 'ctrl_d',
        'ctrl_z': 'ctrl_z',
        'enter': 'enter',
        'escape': 'escape',
        'tab': 'tab'
      };

      const ptyKey = keyMappings[key.toLowerCase()];
      if (!ptyKey) {
        throw new Error(`Unknown special key: ${key}`);
      }

      const result = await this.sessionManager.pty.sendKeys(sessionId, '', ptyKey);

      if (!result.success) {
        throw new Error(`Failed to send special key: ${result.error}`);
      }

      return { success: true };
    } catch (error) {
      console.error(`❌ Error sending special key to session ${sessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async resizeTerminal(sessionId, rows, cols) {
    try {
      if (rows < 1 || rows > 200 || cols < 1 || cols > 500) {
        throw new Error('Invalid terminal dimensions');
      }

      const session = await this.sessionManager.state.getSession(sessionId);
      if (!session) {
        // Session not yet in state (resize raced ahead of connect) — ignore silently
        return { success: true, terminalSize: { rows, cols } };
      }

      const result = await this.sessionManager.pty.resizeSession(sessionId, rows, cols);

      if (!result.success) {
        throw new Error(`Failed to resize terminal: ${result.error}`);
      }

      console.log(`📐 Terminal resized for session ${sessionId}: ${cols}x${rows}`);

      return { success: true, terminalSize: { rows, cols } };
    } catch (error) {
      console.error(`❌ Error resizing terminal for session ${sessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async startOutputStreaming(sessionId) {
    const streamInfo = this.activeStreams.get(sessionId);
    if (!streamInfo) return;

    console.log(`📡 Starting real-time PTY streaming for session: ${sessionId}`);

    this.sessionManager.pty.onData(sessionId, (error, data) => {
      try {
        if (error) {
          console.error(`❌ PTY data error for session ${sessionId}:`, error);
          return;
        }

        if (!streamInfo.isActive) return;

        if (data && streamInfo.websocket && streamInfo.websocket.readyState === 1) {
          if (streamInfo.connectionState) {
            streamInfo.connectionState.lastActivity = Date.now();
          }

          streamInfo.websocket.send(JSON.stringify({
            type: 'terminal_output',
            data: {
              session_id: sessionId,
              output: data,
              timestamp: new Date().toISOString(),
              real_time: true
            }
          }));
        }
      } catch (error) {
        console.error(`❌ Output streaming error for session ${sessionId}:`, error);
      }
    });
  }

  getStreamStatus() {
    const activeStreams = Array.from(this.activeStreams.values());

    return {
      activeStreams: activeStreams.length,
      totalStreams: activeStreams.length,
      streams: activeStreams.map(stream => ({
        sessionId: stream.sessionId,
        isActive: stream.isActive,
        attachedAt: stream.attachedAt,
        websocketState: stream.websocket ? stream.websocket.readyState : null
      }))
    };
  }

  getActiveStreams() {
    return Array.from(this.activeStreams.keys());
  }

  async cleanup() {
    console.log('🧹 Cleaning up terminal streams...');
    for (const sessionId of this.activeStreams.keys()) {
      await this.detachFromSession(sessionId);
    }
    console.log('✅ Terminal streams cleanup complete');
  }
}

module.exports = TerminalHandler;
