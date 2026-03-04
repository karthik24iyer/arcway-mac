const pty = require('node-pty');
const fs = require('fs');

/**
 * PTY Interface - Direct Claude Code process management without tmux
 * Eliminates input hanging issues by using native terminal environment
 */
class PTYInterface {
  constructor(config) {
    this.config = config;
    this.defaultDirectory = config.pty?.defaultDirectory || process.cwd();
    this.processes = new Map(); // sessionId -> { ptyProcess, info }
    this.sessionTimeout = config.pty?.sessionTimeout || 24 * 60 * 60 * 1000; // 24 hours
    
    console.log('📟 PTYInterface initialized for direct Claude Code processes');
    
    // Check Claude Code availability on startup
    this.checkClaudeAvailability();
  }
  
  async checkClaudeAvailability() {
    try {
      const { spawn } = require('child_process');
      const claude = spawn('which', ['claude']);
      
      claude.on('exit', (code) => {
        if (code === 0) {
          console.log('✅ Claude Code is available');
        } else {
          console.error('❌ Claude Code is not available. Please install Claude Code CLI');
        }
      });
      
      claude.on('error', () => {
        console.error('❌ Error checking Claude availability');
      });
    } catch (error) {
      console.error('❌ Error checking Claude availability:', error);
    }
  }
  
  /**
   * Create Claude Code session with direct PTY
   */
  async createClaudeSession(sessionId, workingDirectory, skipPermissions = false) {
    try {
      const directory = workingDirectory || this.defaultDirectory;

      // Validate directory
      if (!fs.existsSync(directory)) {
        return {
          success: false,
          error: `Directory does not exist: ${directory}`
        };
      }

      // Idempotency: return existing process if already alive
      const existing = this.processes.get(sessionId);
      if (existing && !existing.ptyProcess.killed) {
        console.log(`♻️  Reusing existing PTY session: ${sessionId}`);
        return { success: true, sessionId, directory: existing.info.directory, pid: existing.ptyProcess.pid };
      }

      console.log(`🚀 Creating Claude PTY session: ${sessionId} in ${directory}`);

      // Spawn Claude Code directly with PTY
      const claudePath = require('child_process').execSync('which claude 2>/dev/null || echo ""').toString().trim() || 'claude';
      const claudeArgs = skipPermissions ? ['--dangerously-skip-permissions'] : [];
      const claudeProcess = pty.spawn(claudePath, claudeArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: directory,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });
      
      // Store process info
      const processInfo = {
        sessionId,
        directory,
        created: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        cols: 80,
        rows: 24
      };
      
      this.processes.set(sessionId, {
        ptyProcess: claudeProcess,
        info: processInfo
      });
      
      // Set up process event handlers
      claudeProcess.on('exit', (code, signal) => {
        console.log(`🔚 Claude process ${sessionId} exited with code ${code}, signal: ${signal}`);
        this.processes.delete(sessionId);
      });
      
      claudeProcess.on('error', (error) => {
        console.error(`❌ Claude process ${sessionId} error:`, error);
        this.processes.delete(sessionId);
      });
      
      console.log(`✅ Claude PTY session created: ${sessionId}`);
      
      return {
        success: true,
        sessionId,
        directory,
        pid: claudeProcess.pid,
        created: processInfo.created
      };
      
    } catch (error) {
      console.error(`❌ Error creating Claude PTY session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Resume an existing Claude Code session from history using --resume flag
   */
  async resumeClaudeSession(historySessionId, workingDirectory, skipPermissions = false) {
    try {
      const os = require('os');
      const directory = (workingDirectory && fs.existsSync(workingDirectory))
        ? workingDirectory
        : os.homedir();

      // Idempotency: return existing process if already alive
      const existing = this.processes.get(historySessionId);
      if (existing && !existing.ptyProcess.killed) {
        console.log(`♻️  Reusing existing PTY session: ${historySessionId}`);
        return { success: true, sessionId: historySessionId, directory: existing.info.directory, pid: existing.ptyProcess.pid };
      }

      console.log(`🔄 Resuming Claude session: ${historySessionId} in ${directory}`);

      const claudePath = require('child_process').execSync('which claude 2>/dev/null || echo ""').toString().trim() || 'claude';
      const resumeArgs = skipPermissions
        ? ['--dangerously-skip-permissions', '--resume', historySessionId]
        : ['--resume', historySessionId];
      const claudeProcess = pty.spawn(claudePath, resumeArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: directory,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });

      const processInfo = {
        sessionId: historySessionId,
        directory,
        created: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        cols: 80,
        rows: 24
      };

      this.processes.set(historySessionId, { ptyProcess: claudeProcess, info: processInfo });

      claudeProcess.on('exit', () => {
        console.log(`🔚 Resumed Claude process ${historySessionId} exited`);
        this.processes.delete(historySessionId);
      });

      claudeProcess.on('error', (error) => {
        console.error(`❌ Resumed Claude process ${historySessionId} error:`, error);
        this.processes.delete(historySessionId);
      });

      console.log(`✅ Claude session resumed: ${historySessionId}`);

      return { success: true, sessionId: historySessionId, directory, pid: claudeProcess.pid };

    } catch (error) {
      console.error(`❌ Error resuming Claude session ${historySessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send command to Claude session
   */
  async sendCommand(sessionId, command) {
    try {
      const session = this.processes.get(sessionId);
      if (!session) {
        return {
          success: false,
          error: 'Session not found'
        };
      }
      
      const { ptyProcess } = session;
      
      // Update last activity
      session.info.lastActivity = new Date().toISOString();
      
      // Send command to Claude
      ptyProcess.write(command + '\r');
      
      return { success: true };
      
    } catch (error) {
      console.error(`❌ Error sending command to ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Send keys to Claude session
   */
  async sendKeys(sessionId, text, specialKey = null) {
    try {
      const session = this.processes.get(sessionId);
      if (!session) {
        return {
          success: false,
          error: 'Session not found'
        };
      }
      
      const { ptyProcess } = session;
      
      // Update last activity
      session.info.lastActivity = new Date().toISOString();
      
      if (specialKey) {
        // Send special key
        switch (specialKey) {
          case 'ctrl_c':
            ptyProcess.write('\x03');
            break;
          case 'ctrl_d':
            ptyProcess.write('\x04');
            break;
          case 'ctrl_z':
            ptyProcess.write('\x1a');
            break;
          case 'escape':
            ptyProcess.write('\x1b');
            break;
          case 'tab':
            ptyProcess.write('\t');
            break;
          case 'enter':
            ptyProcess.write('\r');
            break;
          default:
            throw new Error(`Unknown special key: ${specialKey}`);
        }
      } else {
        // Send regular text
        ptyProcess.write(text);
      }
      
      return { success: true };
      
    } catch (error) {
      console.error(`❌ Error sending keys to ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Set up data listener for session output
   */
  onData(sessionId, callback) {
    const session = this.processes.get(sessionId);
    if (!session) {
      callback(new Error('Session not found'), null);
      return;
    }
    
    const { ptyProcess } = session;
    
    // Remove existing listeners to avoid duplicates
    ptyProcess.removeAllListeners('data');
    
    // Set up new data listener
    ptyProcess.on('data', (data) => {
      // Update last activity
      session.info.lastActivity = new Date().toISOString();
      callback(null, data);
    });
  }
  
  /**
   * Get current session output (compatibility method)
   * PTY uses real-time streaming, so this returns a status message
   */
  async capturePane(sessionId) {
    const session = this.processes.get(sessionId);
    if (!session) {
      return {
        success: false,
        error: 'Session not found',
        output: ''
      };
    }
    
    return {
      success: true,
      output: '[PTY Session Active - Use real-time streaming]'
    };
  }
  
  /**
   * Check if session exists and is active
   */
  async sessionExists(sessionId) {
    const session = this.processes.get(sessionId);
    const exists = session && !session.ptyProcess.killed;
    
    return { exists };
  }
  
  /**
   * Kill session
   */
  async killSession(sessionId) {
    try {
      const session = this.processes.get(sessionId);
      if (!session) {
        return {
          success: true // Already gone
        };
      }
      
      const { ptyProcess } = session;
      
      // Kill the process
      ptyProcess.kill('SIGTERM');
      
      // Remove from our tracking
      this.processes.delete(sessionId);
      
      console.log(`🗑️  Killed PTY session: ${sessionId}`);
      
      return { success: true };
      
    } catch (error) {
      console.error(`❌ Error killing PTY session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Resize session terminal
   */
  async resizeSession(sessionId, rows, cols) {
    try {
      const session = this.processes.get(sessionId);
      if (!session) {
        return {
          success: false,
          error: 'Session not found'
        };
      }
      
      const { ptyProcess } = session;
      
      // Resize the PTY
      ptyProcess.resize(cols, rows);
      
      // Update stored dimensions
      session.info.cols = cols;
      session.info.rows = rows;
      
      return { success: true };
      
    } catch (error) {
      console.error(`❌ Error resizing PTY session ${sessionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get session information
   */
  async getSessionInfo(sessionId) {
    try {
      const session = this.processes.get(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      
      const { info } = session;
      
      return {
        name: sessionId,
        created: info.created,
        lastActivity: info.lastActivity,
        terminalSize: {
          cols: info.cols,
          rows: info.rows
        },
        pid: session.ptyProcess.pid,
        directory: info.directory
      };
      
    } catch (error) {
      console.error(`❌ Error getting PTY session info for ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * List all active sessions
   */
  async listSessions() {
    const sessions = [];
    
    for (const [sessionId, session] of this.processes.entries()) {
      if (!session.ptyProcess.killed) {
        sessions.push({
          name: sessionId,
          created: session.info.created,
          lastActivity: session.info.lastActivity,
          pid: session.ptyProcess.pid
        });
      }
    }
    
    return sessions;
  }
  
  /**
   * Get process PID for session
   */
  async getSessionPid(sessionId) {
    const session = this.processes.get(sessionId);
    return session ? session.ptyProcess.pid : null;
  }
  
  /**
   * Send special key combinations
   */
  async sendSpecialKey(sessionId, key) {
    return this.sendKeys(sessionId, '', key);
  }
  
  /**
   * Cleanup inactive sessions
   */
  async cleanupInactiveSessions() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [sessionId, session] of this.processes.entries()) {
      const lastActivity = new Date(session.info.lastActivity).getTime();
      const inactive = now - lastActivity;
      
      if (inactive > this.sessionTimeout) {
        console.log(`🧹 Cleaning up inactive PTY session: ${sessionId}`);
        await this.killSession(sessionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} inactive PTY sessions`);
    }
    
    return cleanedCount;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const stats = {
      totalSessions: this.processes.size,
      activeSessions: 0,
      processes: []
    };
    
    for (const [sessionId, session] of this.processes.entries()) {
      if (!session.ptyProcess.killed) {
        stats.activeSessions++;
        stats.processes.push({
          sessionId,
          pid: session.ptyProcess.pid,
          created: session.info.created,
          directory: session.info.directory
        });
      }
    }
    
    return stats;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = PTYInterface;