const os = require('os');
const path = require('path');
const fs = require('fs');
const PTYInterface = require('./ptyInterface');
const { v4: uuidv4 } = require('uuid');

class SessionManager {
  constructor(config) {
    this.config = config;
    this.sessionPrefix = config.session?.sessionPrefix || 'claude-';
    this.pty = new PTYInterface(config);

    console.log('📂 SessionManager initialized');
  }

  async listClaudeHistorySessions() {
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

            const isActive = this.pty.sessionExists(sessionId);
            sessions.push({
              sessionId,
              name,
              directory: cwd || '',
              userId: 'default',
              created: firstTs,
              lastActivity: lastTs || firstTs,
              isActive,
              status: isActive ? 'active' : 'idle',
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

  async _getCwdForHistorySession(sessionId) {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    try {
      for (const projectDir of await fs.promises.readdir(projectsDir)) {
        const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          for (const line of content.split('\n'))
            try { const e = JSON.parse(line); if (e.cwd) return e.cwd; } catch {}
        } catch {}
      }
    } catch {}
    return os.homedir();
  }

  async connectToSession(sessionId, skipPermissions) {
    if (this.pty.sessionExists(sessionId)) return { success: true, isNew: false };
    const cwd = await this._getCwdForHistorySession(sessionId);
    const args = ['--resume', sessionId, ...(skipPermissions ? ['--dangerously-skip-permissions'] : [])];
    this.pty.startSession(sessionId, cwd, args);
    return { success: true, isNew: true };
  }

  async createClaudeSession(directory, skipPermissions) {
    const sessionId = `${this.sessionPrefix}${uuidv4().substring(0, 8)}`;
    const args = skipPermissions ? ['--dangerously-skip-permissions'] : [];
    this.pty.startSession(sessionId, directory, args);
    return { success: true, sessionId };
  }

  async terminateSession(sessionId) {
    this.pty.killSession(sessionId);
    return { success: true };
  }

  async getSessionStatus(sessionId) {
    const running = this.pty.sessionExists(sessionId);
    return { success: true, status: { sessionId, isActive: running, status: running ? 'active' : 'idle' } };
  }

  async killAllActiveSessions() {
    const runningSessions = await this.pty.listSessions();
    for (const { name: sessionId } of runningSessions) {
      await this.pty.killSession(sessionId);
      await this.state.deleteSession(sessionId);
    }
    if (runningSessions.length > 0) {
      console.log(`🧹 Killed ${runningSessions.length} active PTY session(s) on client reconnect`);
    }
  }
}

module.exports = SessionManager;
