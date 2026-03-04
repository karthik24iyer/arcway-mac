/**
 * Simple Health Monitor - Basic service health checking
 * Returns 200/500 status without over-engineering
 */
class HealthMonitor {
  constructor(config, sessionManager, terminalHandler) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.terminalHandler = terminalHandler;
    this.startTime = Date.now();
    
    console.log('🏥 Simple HealthMonitor initialized');
  }
  
  /**
   * Get basic health status
   * @returns {Promise<Object>} Simple health status
   */
  async getHealthStatus() {
    try {
      // Simple checks - if we can call these methods, service is healthy
      const sessionStats = await this.sessionManager.getSessionStats();
      const streamStatus = this.terminalHandler.getStreamStatus();
      
      return {
        status: 'healthy',
        uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
        sessions: sessionStats,
        streams: {
          active: streamStatus.activeStreams || 0
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      // If any core service fails, return error status
      console.error('❌ Health check failed:', error);
      return {
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = HealthMonitor;