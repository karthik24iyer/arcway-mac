const SessionState = require('./sessionState');
const PTYInterface = require('./ptyInterface');
const { v4: uuidv4 } = require('uuid');

/**
 * Session Manager - High-level session management with Claude Code integration
 * Now uses direct PTY interface instead of tmux for reliable Claude Code execution
 */
class SessionManager {
  constructor(config) {
    this.config = config;
    this.maxSessions = config.session?.maxSessions || 10;
    this.sessionPrefix = config.session?.sessionPrefix || 'claude-';
    this.sessionTimeout = config.session?.sessionTimeout || 24 * 60 * 60 * 1000; // 24 hours
    this.cleanupInterval = config.session?.cleanupInterval || 5 * 60 * 1000; // 5 minutes
    
    // Initialize dependencies
    this.state = new SessionState(config);
    this.pty = new PTYInterface(config);
    
    // Start periodic cleanup
    this.startPeriodicCleanup();
    
    console.log('📂 SessionManager initialized');
  }
  
  /**
   * Create new Claude Code session using PTY
   */
  async createClaudeSession(directory, sessionName = null, userId = 'default', skipPermissions = false) {
    try {
      // Validate directory parameter
      if (!directory || typeof directory !== 'string') {
        return {
          success: false,
          error: 'Directory path is required and must be a string',
          errorCode: 'INVALID_DIRECTORY'
        };
      }

      // Expand ~ to home directory
      if (directory.startsWith('~')) {
        directory = require('os').homedir() + directory.slice(1);
      }

      // Validate directory exists and is accessible
      const fs = require('fs');
      try {
        const stat = fs.statSync(directory);
        if (!stat.isDirectory()) {
          return {
            success: false,
            error: `Path is not a directory: ${directory}`,
            errorCode: 'NOT_DIRECTORY'
          };
        }
        
        // Check read/write access
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      } catch (error) {
        return {
          success: false,
          error: `Directory not accessible: ${directory} (${error.message})`,
          errorCode: 'DIRECTORY_ACCESS_ERROR'
        };
      }

      // Check blocked directories
      const blockedDirs = this.config.session?.blockedDirectories || [];
      const normalizedDir = require('path').resolve(directory);
      for (const blocked of blockedDirs) {
        const normalizedBlocked = require('path').resolve(blocked);
        if (normalizedDir === normalizedBlocked || normalizedDir.startsWith(normalizedBlocked + '/')) {
          return {
            success: false,
            error: `Directory is restricted: ${directory}`,
            errorCode: 'DIRECTORY_ACCESS_DENIED'
          };
        }
      }

      // Check session limit against live PTY processes
      const runningSessions = await this.pty.listSessions();
      if (runningSessions.length >= this.maxSessions) {
        return {
          success: false,
          error: `Maximum sessions reached (${this.maxSessions})`,
          errorCode: 'SESSION_LIMIT_EXCEEDED'
        };
      }
      
      // Generate session info
      const sessionId = sessionName || `${this.sessionPrefix}${uuidv4().substring(0, 8)}`;
      
      console.log(`🔧 Creating Claude session: ${sessionId} in ${directory}`);
      
      // Create PTY session with Claude Code directly
      const ptyResult = await this.pty.createClaudeSession(sessionId, directory, skipPermissions);
      if (!ptyResult.success) {
        return {
          success: false,
          error: ptyResult.error,
          errorCode: 'PTY_ERROR'
        };
      }
      
      // Create session record
      const session = {
        sessionId,
        directory,
        userId,
        pid: ptyResult.pid,
        skipPermissions: !!skipPermissions,
        created: new Date().toISOString(),
        isActive: true,
        status: 'active',
        lastActivity: new Date().toISOString(),
        claudeStatus: 'active'
      };
      
      await this.state.saveSession(sessionId, session);
      
      console.log(`✅ Claude session created successfully: ${sessionId}`);
      
      return {
        success: true,
        sessionId: session.sessionId,
        session: session
      };
      
    } catch (error) {
      console.error('❌ Error creating Claude session:', error);
      return {
        success: false,
        error: error.message,
        errorCode: 'CREATION_ERROR'
      };
    }
  }
  
  /**
   * Check if Claude is running in a session
   */
  async isClaudeRunningInSession(sessionId) {
    try {
      const session = await this.state.getSession(sessionId);
      if (!session || !session.pid) {
        return false;
      }
      
      // For PTY sessions, check if the process is still alive
      const ptyStatus = await this.pty.sessionExists(sessionId);
      return ptyStatus.exists;
    } catch (error) {
      console.error(`Error checking Claude status for ${sessionId}:`, error);
      return false;
    }
  }
  
  /**
   * List sessions for a user
   */
  async listUserSessions(userId) {
    try {
      const allSessions = await this.state.getAllSessions();
      const userSessions = allSessions.filter(session => session.userId === userId);

      // Update session status from PTY
      for (const session of userSessions) {
        const ptyStatus = await this.pty.sessionExists(session.sessionId);
        session.isActive = ptyStatus.exists;
        session.status = ptyStatus.exists ? 'active' : 'idle';
      }

      return userSessions;
    } catch (error) {
      console.error('❌ Error listing sessions:', error);
      return [];
    }
  }

  /**
   * List Claude conversation history from ~/.claude/projects JSONL files
   */
  async listClaudeHistorySessions() {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const sessions = [];

    try {
      if (!fs.existsSync(projectsDir)) return sessions;

      for (const projectDir of fs.readdirSync(projectsDir)) {
        const projectPath = path.join(projectsDir, projectDir);
        try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }

        for (const file of fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))) {
          const sessionId = file.replace('.jsonl', '');
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) continue;

          try {
            const content = fs.readFileSync(path.join(projectPath, file), 'utf8');
            const lines = content.trim().split('\n').filter(l => l.trim());
            if (!lines.length) continue;

            let title = '', customTitle = '', cwd = '', firstTs = '', lastTs = '';

            for (const line of lines) {
              try {
                const e = JSON.parse(line);
                if (!cwd && e.cwd) cwd = e.cwd;
                if (!firstTs && e.timestamp) firstTs = e.timestamp;
                if (e.timestamp) lastTs = e.timestamp;
                if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
                if (!title && e.type === 'user' && e.message?.content) {
                  const c = e.message.content;
                  const text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.find(b => b.type === 'text')?.text || '') : '');
                  title = text.substring(0, 80).replace(/\n/g, ' ').trim();
                }
              } catch {}
            }

            const name = customTitle || title;

            if (!name) continue;

            const ptyStatus = await this.pty.sessionExists(sessionId);
            sessions.push({
              sessionId,
              name,
              directory: cwd || '',
              userId: 'default',
              created: firstTs,
              lastActivity: lastTs || firstTs,
              isActive: ptyStatus.exists,
              status: ptyStatus.exists ? 'active' : 'idle',
              pid: null
            });
          } catch {}
        }
      }

      sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    } catch (error) {
      console.error('❌ Error listing Claude history sessions:', error);
    }

    return sessions;
  }

  /**
   * Find the working directory for a history session from its JSONL file
   */
  async _getCwdForHistorySession(sessionId) {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');

    try {
      for (const projectDir of fs.readdirSync(projectsDir)) {
        const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
        if (fs.existsSync(filePath)) {
          const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
          if (firstLine) {
            const entry = JSON.parse(firstLine);
            return entry.cwd || os.homedir();
          }
        }
      }
    } catch {}

    return os.homedir();
  }
  
  /**
   * Connect to existing session, auto-resuming from Claude history if no PTY is running
   */
  async connectToSession(sessionId, userId, skipPermissions = false) {
    try {
      console.log(`🔗 Connecting user ${userId} to session ${sessionId}`);

      let ptyStatus = await this.pty.sessionExists(sessionId);
      let session = await this.state.getSession(sessionId);

      // Restart PTY if skip_permissions changed
      if (ptyStatus.exists && session?.skipPermissions !== !!skipPermissions) {
        await this.pty.killSession(sessionId);
        ptyStatus = { exists: false };
      }

      if (!ptyStatus.exists) {
        // Resume from Claude history
        const cwd = session?.directory || await this._getCwdForHistorySession(sessionId);
        const ptyResult = await this.pty.resumeClaudeSession(sessionId, cwd, skipPermissions);
        if (!ptyResult.success) {
          return { success: false, error: ptyResult.error, errorCode: 'SESSION_RESUME_FAILED' };
        }

        session = {
          sessionId,
          directory: cwd,
          userId,
          pid: ptyResult.pid,
          skipPermissions: !!skipPermissions,
          created: session?.created || new Date().toISOString(),
          isActive: true,
          status: 'active',
          lastActivity: new Date().toISOString()
        };
        await this.state.saveSession(sessionId, session);
      } else {
        // PTY already running — validate ownership if we have a state record
        if (session && session.userId !== userId) {
          return { success: false, error: 'Access denied to this session', errorCode: 'ACCESS_DENIED' };
        }
        if (!session) {
          session = { sessionId, directory: '', userId, pid: null, created: new Date().toISOString(), isActive: true, status: 'active', lastActivity: new Date().toISOString() };
        }
        session.lastActivity = new Date().toISOString();
        session.isActive = true;
        await this.state.saveSession(sessionId, session);
      }

      console.log(`✅ Connected to session: ${sessionId}`);

      return {
        success: true,
        session,
        currentOutput: '[PTY Session Connected - Use real-time streaming]',
        terminalSize: { rows: 24, cols: 80 }
      };
    } catch (error) {
      console.error('❌ Error connecting to session:', error);
      return { success: false, error: error.message, errorCode: 'CONNECTION_ERROR' };
    }
  }
  
  /**
   * Disconnect from session
   */
  async disconnectFromSession(sessionId, userId) {
    try {
      const session = await this.state.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: 'Session not found',
          errorCode: 'SESSION_NOT_FOUND'
        };
      }

      const hasAccess = await this.validateSessionAccess(sessionId, userId);
      if (!hasAccess) {
        return {
          success: false,
          error: 'Access denied',
          errorCode: 'ACCESS_DENIED'
        };
      }

      // Update session state
      session.lastActivity = new Date().toISOString();
      await this.state.saveSession(sessionId, session);

      console.log(`🔌 Disconnected from session: ${sessionId}`);

      return {
        success: true,
        message: 'Disconnected successfully'
      };
    } catch (error) {
      console.error('❌ Error disconnecting from session:', error);
      return {
        success: false,
        error: error.message,
        errorCode: 'DISCONNECT_ERROR'
      };
    }
  }
  
  /**
   * Terminate session
   */
  async terminateSession(sessionId, userId) {
    try {
      const session = await this.state.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: 'Session not found',
          errorCode: 'SESSION_NOT_FOUND'
        };
      }

      const hasAccess = await this.validateSessionAccess(sessionId, userId);
      if (!hasAccess) {
        return {
          success: false,
          error: 'Access denied',
          errorCode: 'ACCESS_DENIED'
        };
      }

      // Kill PTY session
      const result = await this.pty.killSession(session.sessionId);
      
      // Remove from state
      await this.state.deleteSession(sessionId);

      console.log(`🗑️  Terminated session: ${sessionId}`);

      return {
        success: true,
        ptyResult: result
      };
    } catch (error) {
      console.error('❌ Error terminating session:', error);
      return {
        success: false,
        error: error.message,
        errorCode: 'TERMINATION_ERROR'
      };
    }
  }
  
  /**
   * Get session status
   */
  async getSessionStatus(sessionId) {
    try {
      const session = await this.state.getSession(sessionId);
      if (!session) {
        return {
          success: false,
          error: 'Session not found',
          errorCode: 'SESSION_NOT_FOUND'
        };
      }

      // Check PTY status
      const ptyStatus = await this.pty.sessionExists(session.sessionId);
      
      return {
        success: true,
        status: {
          sessionId,
          isActive: ptyStatus.exists,
          status: ptyStatus.exists ? 'active' : 'idle',
          created: session.created,
          lastActivity: session.lastActivity,
          directory: session.directory,
          pid: session.pid
        }
      };
    } catch (error) {
      console.error('❌ Error getting session status:', error);
      return {
        success: false,
        error: error.message,
        errorCode: 'STATUS_ERROR'
      };
    }
  }
  
  /**
   * Basic session statistics
   */
  async getSessionStats() {
    try {
      const allSessions = await this.state.getAllSessions();
      const stats = {
        total: allSessions.length,
        active: 0,
        inactive: 0
      };

      for (const session of allSessions) {
        if (session.isActive) {
          stats.active++;
        } else {
          stats.inactive++;
        }
      }
      
      return stats;
    } catch (error) {
      console.error('Error getting session stats:', error);
      return {
        total: 0,
        active: 0,
        inactive: 0
      };
    }
  }
  
  /**
   * Restart Claude Code in session (error recovery)
   */
  async restartClaude(sessionId) {
    try {
      const session = await this.state.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      
      console.log(`🔄 Restarting Claude Code in session: ${sessionId}`);
      
      // For PTY sessions, we need to recreate the entire session
      await this.pty.killSession(sessionId);
      await this.sleep(1000);
      
      const result = await this.pty.createClaudeSession(sessionId, session.directory);
      
      // Update session status
      session.claudeStatus = result.success ? 'active' : 'crashed';
      session.lastActivity = new Date().toISOString();
      await this.state.saveSession(sessionId, session);
      
      return result;
    } catch (error) {
      console.error('❌ Error restarting Claude:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Helper methods
   */
  async validateSessionAccess(sessionId, userId) {
    const session = await this.state.getSession(sessionId);
    return session && session.userId === userId;
  }
  
  async getCurrentOutput(sessionId) {
    // For PTY sessions, output is streamed in real-time
    // This method is kept for compatibility but returns a placeholder
    const result = await this.pty.capturePane(sessionId);
    return result.success ? result.output : '';
  }
  
  /**
   * Get current output by sessionId (convenience method)
   */
  async getCurrentOutputBySessionId(sessionId) {
    try {
      const session = await this.state.getSession(sessionId);
      if (!session || !session.sessionId) {
        return '';
      }
      return await this.getCurrentOutput(session.sessionId);
    } catch (error) {
      console.error(`Error getting output for ${sessionId}:`, error);
      return '';
    }
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Cleanup inactive sessions
   */
  async cleanupInactiveSessions() {
    try {
      const allSessions = await this.state.getAllSessions();
      const now = Date.now();
      let cleanedCount = 0;

      for (const session of allSessions) {
        const lastActivity = new Date(session.lastActivity).getTime();
        const inactive = now - lastActivity;

        if (inactive > this.sessionTimeout) {
          console.log(`🧹 Cleaning up inactive session: ${session.sessionId}`);
          await this.pty.killSession(session.sessionId);
          await this.state.deleteSession(session.sessionId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} inactive sessions`);
      }
    } catch (error) {
      console.error('❌ Error during session cleanup:', error);
    }
  }
  
  /**
   * Start periodic cleanup
   */
  startPeriodicCleanup() {
    setInterval(() => {
      this.cleanupInactiveSessions();
    }, this.cleanupInterval);
    
    console.log(`🔄 Periodic cleanup started (interval: ${this.cleanupInterval / 1000}s)`);
  }
}

module.exports = SessionManager;