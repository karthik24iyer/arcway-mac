const fs = require('fs').promises;
const path = require('path');

/**
 * SessionState - Manages session persistence and state tracking
 * Handles in-memory session storage with optional file persistence
 */
class SessionState {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.persistenceEnabled = config.session?.persistence?.enabled || false;
    this.persistenceFile = path.resolve(__dirname, '..', config.session?.persistence?.file || 'data/sessions.json');
    this.autoSaveInterval = config.session?.persistence?.autoSaveInterval || 30000; // 30 seconds
    
    console.log('📊 SessionState initialized with persistence:', this.persistenceEnabled);
    
    if (this.persistenceEnabled) {
      this.initializePersistence();
    }
  }

  /**
   * Initialize persistence by loading existing sessions and setting up auto-save
   */
  async initializePersistence() {
    try {
      await this.loadSessions();
      this.startAutoSave();
      console.log('✅ Session persistence initialized');
    } catch (error) {
      console.error('❌ Failed to initialize session persistence:', error);
    }
  }

  /**
   * Add a new session to the state
   * @param {Object} session - Session object to add
   */
  async addSession(session) {
    if (!session.id) {
      throw new Error('Session must have an ID');
    }
    
    this.sessions.set(session.id, {
      ...session,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    
    if (this.persistenceEnabled) {
      await this.saveSessions();
    }
    
    console.log(`📝 Added session ${session.id} to state`);
  }

  /**
   * Update an existing session
   * @param {string} sessionId - Session ID to update
   * @param {Object} updates - Updates to apply to the session
   */
  async updateSession(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found in state`);
    }
    
    const updatedSession = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.sessions.set(sessionId, updatedSession);
    
    if (this.persistenceEnabled) {
      await this.saveSessions();
    }
    
    return updatedSession;
  }

  /**
   * Get a session by ID
   * @param {string} sessionId - Session ID to retrieve
   * @returns {Object|null} Session object or null if not found
   */
  async getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get all sessions for a specific user
   * @param {string} userId - User ID to filter sessions
   * @returns {Array} Array of sessions for the user
   */
  async getSessionsByUser(userId) {
    const allSessions = Array.from(this.sessions.values());
    return allSessions.filter(session => session.userId === userId);
  }

  /**
   * Get all sessions
   * @returns {Array} Array of all sessions
   */
  async getAllSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Remove a session from the state
   * @param {string} sessionId - Session ID to remove
   */
  async removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`⚠️  Attempted to remove non-existent session ${sessionId}`);
      return false;
    }
    
    this.sessions.delete(sessionId);
    
    if (this.persistenceEnabled) {
      await this.saveSessions();
    }
    
    console.log(`🗑️  Removed session ${sessionId} from state`);
    return true;
  }

  /**
   * Get sessions by status
   * @param {string} status - Status to filter by (active, inactive, crashed)
   * @returns {Array} Array of sessions with the specified status
   */
  async getSessionsByStatus(status) {
    const allSessions = Array.from(this.sessions.values());
    return allSessions.filter(session => session.status === status);
  }

  /**
   * Get active sessions (those that are currently running)
   * @returns {Array} Array of active sessions
   */
  async getActiveSessions() {
    const allSessions = Array.from(this.sessions.values());
    return allSessions.filter(session => session.isActive === true);
  }

  /**
   * Get session count statistics
   * @returns {Object} Session count statistics
   */
  getSessionCounts() {
    const allSessions = Array.from(this.sessions.values());
    
    const counts = {
      total: allSessions.length,
      active: 0,
      inactive: 0,
      crashed: 0,
      byUser: {}
    };
    
    for (const session of allSessions) {
      // Count by status
      if (session.isActive) {
        counts.active++;
      } else if (session.status === 'crashed') {
        counts.crashed++;
      } else {
        counts.inactive++;
      }
      
      // Count by user
      if (!counts.byUser[session.userId]) {
        counts.byUser[session.userId] = 0;
      }
      counts.byUser[session.userId]++;
    }
    
    return counts;
  }

  /**
   * Clean up sessions that match a filter function
   * @param {Function} filterFn - Function that returns true for sessions to remove
   * @returns {Array} Array of removed session IDs
   */
  async cleanupSessions(filterFn) {
    const allSessions = Array.from(this.sessions.values());
    const sessionsToRemove = allSessions.filter(filterFn);
    const removedIds = [];
    
    for (const session of sessionsToRemove) {
      await this.removeSession(session.id);
      removedIds.push(session.id);
    }
    
    return removedIds;
  }

  /**
   * Load sessions from persistent storage
   */
  async loadSessions() {
    try {
      // Ensure data directory exists
      const dataDir = path.dirname(this.persistenceFile);
      try {
        await fs.access(dataDir);
      } catch {
        await fs.mkdir(dataDir, { recursive: true });
      }
      
      // Try to load sessions file
      try {
        const data = await fs.readFile(this.persistenceFile, 'utf8');
        const sessionsData = JSON.parse(data);
        
        this.sessions.clear();
        
        if (Array.isArray(sessionsData.sessions)) {
          for (const session of sessionsData.sessions) {
            this.sessions.set(session.id, session);
          }
        }
        
        console.log(`📂 Loaded ${this.sessions.size} sessions from persistence file`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log('📂 No existing sessions file found, starting with empty state');
        } else {
          console.error('❌ Error loading sessions from file:', error);
        }
      }
    } catch (error) {
      console.error('❌ Failed to load sessions:', error);
    }
  }

  /**
   * Save sessions to persistent storage
   */
  async saveSessions() {
    if (!this.persistenceEnabled) return;
    
    try {
      const sessionsData = {
        version: '1.0.0',
        savedAt: new Date().toISOString(),
        sessionCount: this.sessions.size,
        sessions: Array.from(this.sessions.values())
      };
      
      // Ensure data directory exists
      const dataDir = path.dirname(this.persistenceFile);
      await fs.mkdir(dataDir, { recursive: true });
      
      // Write sessions to file
      await fs.writeFile(this.persistenceFile, JSON.stringify(sessionsData, null, 2), 'utf8');
      
      console.log(`💾 Saved ${this.sessions.size} sessions to persistence file`);
    } catch (error) {
      console.error('❌ Failed to save sessions:', error);
    }
  }

  /**
   * Start automatic session saving
   */
  startAutoSave() {
    if (!this.persistenceEnabled) return;
    
    setInterval(async () => {
      try {
        await this.saveSessions();
      } catch (error) {
        console.error('❌ Error in auto-save:', error);
      }
    }, this.autoSaveInterval);
    
    console.log(`🔄 Auto-save started (interval: ${this.autoSaveInterval / 1000}s)`);
  }

  /**
   * Export all sessions data for backup or migration
   * @returns {Object} Complete sessions data
   */
  async exportSessions() {
    return {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      sessionCount: this.sessions.size,
      sessions: Array.from(this.sessions.values()),
      metadata: {
        persistenceEnabled: this.persistenceEnabled,
        autoSaveInterval: this.autoSaveInterval
      }
    };
  }

  /**
   * Import sessions data from backup or migration
   * @param {Object} sessionsData - Sessions data to import
   * @returns {number} Number of sessions imported
   */
  async importSessions(sessionsData) {
    try {
      if (!sessionsData.sessions || !Array.isArray(sessionsData.sessions)) {
        throw new Error('Invalid sessions data format');
      }
      
      let importedCount = 0;
      
      for (const session of sessionsData.sessions) {
        if (session.id && !this.sessions.has(session.id)) {
          this.sessions.set(session.id, {
            ...session,
            importedAt: new Date().toISOString()
          });
          importedCount++;
        }
      }
      
      if (this.persistenceEnabled) {
        await this.saveSessions();
      }
      
      console.log(`📥 Imported ${importedCount} sessions`);
      return importedCount;
    } catch (error) {
      console.error('❌ Failed to import sessions:', error);
      throw error;
    }
  }

  /**
   * Clear all sessions from state (dangerous operation)
   * @param {boolean} confirm - Must be true to proceed
   */
  async clearAllSessions(confirm = false) {
    if (!confirm) {
      throw new Error('Must confirm to clear all sessions');
    }
    
    const sessionCount = this.sessions.size;
    this.sessions.clear();
    
    if (this.persistenceEnabled) {
      await this.saveSessions();
    }
    
    console.log(`🧹 Cleared all ${sessionCount} sessions from state`);
    return sessionCount;
  }

  /**
   * Save a session (alias for addSession to maintain compatibility)
   * @param {string} sessionId - Session ID
   * @param {Object} session - Session object to save
   */
  async saveSession(sessionId, session) {
    const sessionWithId = { ...session, id: sessionId, sessionId: sessionId };

    if (this.sessions.has(sessionId)) {
      return await this.updateSession(sessionId, sessionWithId);
    } else {
      await this.addSession(sessionWithId);
      return sessionWithId;
    }
  }

  /**
   * Delete a session (alias for removeSession to maintain compatibility)
   * @param {string} sessionId - Session ID to delete
   */
  async deleteSession(sessionId) {
    return await this.removeSession(sessionId);
  }

  /**
   * Get health information about the session state
   * @returns {Object} Health information
   */
  getHealthInfo() {
    const counts = this.getSessionCounts();
    
    return {
      isHealthy: true,
      sessionCount: counts.total,
      activeSessionCount: counts.active,
      persistenceEnabled: this.persistenceEnabled,
      persistenceFile: this.persistenceFile,
      lastUpdate: new Date().toISOString(),
      memoryUsage: {
        sessionMapSize: this.sessions.size,
        estimatedMemoryKB: Math.round((JSON.stringify(Array.from(this.sessions.values())).length) / 1024)
      }
    };
  }
}

module.exports = SessionState;