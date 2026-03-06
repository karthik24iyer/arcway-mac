const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Import service modules
const AuthManager = require('./auth');
const SessionManager = require('./sessionManager');
const TerminalHandler = require('./terminalHandler');
const MessageHandler = require('./messageHandler');
const HealthMonitor = require('./healthMonitor');

// Load configuration
const configPath = path.join(__dirname, '..', 'config', 'default.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

/**
 * Claude Remote Service Server - Simplified integration without over-engineering
 * Focused on core functionality with essential limits and validation
 */
class ClaudeRemoteServer {
  constructor() {
    this.config = config;
    this.startTime = Date.now();
    this.connections = new Map(); // connectionId -> connection state
    this.connectionCount = 0;
    
    // Connection limits (missing in original)
    this.maxConnections = config.server?.maxConnections || 100;
    this.maxMessageSize = config.server?.maxMessageSize || 1024 * 1024; // 1MB
    this.messageRateLimit = config.server?.messageRateLimit || 180; // messages per minute
    
    // Initialize core components
    this.initializeComponents();
    
    // Setup Express app and HTTP server
    this.setupExpressApp();
    this.setupHttpServer();
    this.setupWebSocketServer();
    
    // Setup cleanup handlers
    this.setupCleanupHandlers();
    
    console.log('🚀 Claude Remote Service initialized');
  }

  /**
   * Initialize all service components
   */
  initializeComponents() {
    try {
      // Initialize core managers
      this.authManager = new AuthManager(this.config);
      this.sessionManager = new SessionManager(this.config);
      this.terminalHandler = new TerminalHandler(this.config, this.sessionManager);
      
      // Initialize message handler
      this.messageHandler = new MessageHandler(
        this.authManager, 
        this.sessionManager, 
        this.terminalHandler, 
        this.config
      );
      
      // Initialize health monitor
      this.healthMonitor = new HealthMonitor(this.config, this.sessionManager, this.terminalHandler);
      
      console.log('✅ All service components initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize service components:', error);
      process.exit(1);
    }
  }

  /**
   * Setup Express application with simplified endpoints
   */
  setupExpressApp() {
    this.app = express();
    this.app.use(express.json({ limit: '1mb' })); // Limit request size
    
    // Health check endpoint using integrated HealthMonitor
    this.app.get('/health', async (req, res) => {
      try {
        const healthStatus = await this.healthMonitor.getHealthStatus();
        
        if (healthStatus.status === 'healthy') {
          res.status(200).json(healthStatus);
        } else {
          res.status(500).json(healthStatus);
        }
      } catch (error) {
        res.status(500).json({
          status: 'error',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Basic stats endpoint (simplified from comprehensive reporting)
    this.app.get('/stats', async (req, res) => {
      try {
        const sessionStats = await this.sessionManager.getSessionStats();
        const connectionStats = this.getBasicConnectionStats();
        
        res.json({
          service: 'claude-remote-service',
          uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
          sessions: sessionStats,
          connections: connectionStats,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Authentication endpoints
    this.app.post('/auth/login', async (req, res) => {
      try {
        const { username, password } = req.body;
        
        if (!username || !password) {
          return res.status(400).json({
            error: 'Username and password are required',
            timestamp: new Date().toISOString()
          });
        }
        
        const loginResult = await this.authManager.login(username, password);
        
        if (loginResult.success) {
          res.json({
            success: true,
            token: loginResult.token,
            user: loginResult.user,
            timestamp: new Date().toISOString()
          });
        } else {
          res.status(401).json({
            error: loginResult.error || 'Invalid credentials',
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        res.status(500).json({
          error: 'Authentication failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    this.app.post('/auth/register', async (req, res) => {
      try {
        const { username, password } = req.body;
        
        if (!username || !password) {
          return res.status(400).json({
            error: 'Username and password are required',
            timestamp: new Date().toISOString()
          });
        }
        
        const registerResult = await this.authManager.register(username, password);
        
        if (registerResult.success) {
          res.json({
            success: true,
            user: registerResult.user,
            timestamp: new Date().toISOString()
          });
        } else {
          res.status(400).json({
            error: registerResult.error || 'Registration failed',
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        res.status(500).json({
          error: 'Registration failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    this.app.post('/auth/logout', async (req, res) => {
      try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
        
        if (token) {
          await this.authManager.logout(token);
        }
        
        res.json({
          success: true,
          message: 'Logged out successfully',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({
          error: 'Logout failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Authentication middleware (delegates to AuthManager for unified token validation)
    const authenticateToken = async (req, res, next) => {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];

      if (!token) {
        return res.status(401).json({
          error: 'Access token required',
          timestamp: new Date().toISOString()
        });
      }

      try {
        const result = await this.authManager.validateToken(token);
        req.user = result.user;
        next();
      } catch (error) {
        return res.status(403).json({
          error: error.message || 'Invalid token',
          timestamp: new Date().toISOString()
        });
      }
    };

    // Sessions API endpoint
    this.app.get('/api/sessions', authenticateToken, async (req, res) => {
      try {
        const userId = req.user.username || req.user.userId || 'default';
        const sessions = await this.sessionManager.listUserSessions(userId);
        
        res.json({
          success: true,
          sessions: sessions.map(session => ({
            sessionId: session.sessionId,
            name: session.sessionId,
            directory: session.directory,
            status: session.status,
            created: session.created,
            lastActivity: session.lastActivity || session.updatedAt,
            isActive: session.isActive
          })),
          total: sessions.length,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Error listing sessions:', error);
        res.status(500).json({
          error: 'Failed to list sessions',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Service configuration endpoint (public info only)
    this.app.get('/config', (req, res) => {
      const publicConfig = {
        server: {
          host: this.config.server.host,
          port: this.config.server.port,
          maxConnections: this.maxConnections
        },
        session: {
          maxSessions: this.config.session?.maxSessions || 10,
          sessionTimeout: this.config.session?.sessionTimeout || 86400000
        },
        features: [
          'authentication',
          'session_management', 
          'terminal_streaming'
        ],
        auth_endpoints: [
          'POST /auth/login',
          'POST /auth/register', 
          'POST /auth/logout'
        ],
        websocket_url: `ws://${this.config.server.host || 'localhost'}:${this.config.server.port || 8080}`
      };
      
      res.json(publicConfig);
    });

    console.log('🌐 Express app configured');
  }

  /**
   * Setup HTTP server
   */
  setupHttpServer() {
    this.server = http.createServer(this.app);
    console.log('📡 HTTP server created');
  }

  /**
   * Setup WebSocket server with connection limits and validation
   */
  setupWebSocketServer() {
    this.wss = new WebSocket.Server({ 
      server: this.server,
      perMessageDeflate: false,
      maxPayload: this.maxMessageSize // Add message size limit
    });

    this.wss.on('connection', (ws, req) => {
      // Check connection limit
      if (this.connectionCount >= this.maxConnections) {
        console.warn(`⚠️  Connection rejected: limit reached (${this.maxConnections})`);
        ws.close(1008, 'Connection limit reached');
        return;
      }
      
      console.log('🔌 New WebSocket connection established');
      this.handleNewConnection(ws, req);
    });

    // Add proper error handling for WebSocket server
    this.wss.on('error', (error) => {
      console.error('❌ WebSocket server error:', error);
    });

    console.log('🔌 WebSocket server configured with limits and error handling');
  }

  /**
   * Handle new WebSocket connection with basic tracking
   */
  handleNewConnection(ws, req, relayUser = null) {
    const connectionId = uuidv4();
    const clientIP = req.socket.remoteAddress;

    console.log(`🔗 New connection: ${connectionId} from ${clientIP}`);

    // Initialize connection state
    const connectionState = {
      id: connectionId,
      ws: ws,
      authenticatedUser: relayUser ? {
        username: relayUser.email,
        permissions: ['terminal_access', 'session_management'],
        token: null
      } : null,
      currentSession: null,
      connectedAt: new Date().toISOString(),
      clientIP: clientIP,
      messageCount: 0,
      lastActivity: Date.now()
    };
    
    this.connections.set(connectionId, connectionState);
    this.connectionCount++;

    // Send welcome message
    this.sendWelcomeMessage(ws, connectionId);

    // Setup message handling with rate limiting
    ws.on('message', async (message) => {
      // Skip rate limiting for real-time terminal events (keystrokes and resize burst naturally)
      let parsedType;
      try { parsedType = JSON.parse(message).type; } catch (_) {}
      const isTerminalEvent = parsedType === 'terminal_resize' || parsedType === 'terminal_input' || parsedType === 'special_key_input';
      if (!isTerminalEvent && !this.checkRateLimit(connectionState)) {
        console.warn(`⚠️  Rate limit exceeded for connection: ${connectionId}`);
        ws.close(1008, 'Rate limit exceeded');
        return;
      }
      
      // Validate message size
      if (message.length > this.maxMessageSize) {
        console.warn(`⚠️  Message too large from ${connectionId}: ${message.length} bytes`);
        ws.close(1009, 'Message too large');
        return;
      }
      
      await this.handleMessage(ws, message, connectionState);
    });

    // Setup connection close handling
    ws.on('close', () => {
      this.handleConnectionClose(connectionId, connectionState);
    });

    // Setup error handling
    ws.on('error', (error) => {
      this.handleConnectionError(connectionId, error);
    });

    // Basic heartbeat (simplified from complex monitoring)
    this.setupBasicHeartbeat(ws, connectionId);
  }

  /**
   * Check rate limiting for connection
   */
  checkRateLimit(connectionState) {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Initialize rate limit tracking if needed
    if (!connectionState.messageTimestamps) {
      connectionState.messageTimestamps = [];
    }
    
    // Remove old timestamps
    connectionState.messageTimestamps = connectionState.messageTimestamps.filter(
      timestamp => timestamp > oneMinuteAgo
    );
    
    // Check if under limit
    if (connectionState.messageTimestamps.length >= this.messageRateLimit) {
      return false;
    }
    
    // Add current timestamp
    connectionState.messageTimestamps.push(now);
    return true;
  }

  /**
   * Send welcome message to new connections
   */
  sendWelcomeMessage(ws, connectionId) {
    const welcomeMessage = {
      type: 'welcome',
      data: {
        message: 'Connected to Claude Remote Service',
        connection_id: connectionId,
        server_time: new Date().toISOString(),
        supported_message_types: this.messageHandler.getSupportedMessageTypes(),
        limits: {
          max_message_size: this.maxMessageSize,
          rate_limit: this.messageRateLimit
        }
      },
      timestamp: new Date().toISOString(),
      id: uuidv4()
    };

    ws.send(JSON.stringify(welcomeMessage));
  }

  /**
   * Handle incoming WebSocket messages with validation
   */
  async handleMessage(ws, message, connectionState) {
    try {
      // Update activity timestamp
      connectionState.lastActivity = Date.now();
      connectionState.messageCount++;

      // Parse and validate message
      let parsedMessage;
      try {
        parsedMessage = JSON.parse(message.toString());
      } catch (error) {
        console.error(`❌ Invalid JSON from ${connectionState.id}:`, error);
        return this.sendError(ws, 'INVALID_JSON', 'Invalid message format', false);
      }

      // Basic message validation
      if (!parsedMessage.type || !parsedMessage.data) {
        return this.sendError(ws, 'INVALID_MESSAGE', 'Message must have type and data fields', false);
      }

      console.log(`📩 Message from ${connectionState.id}: ${parsedMessage.type}`);

      // Route message through message handler
      await this.messageHandler.routeMessage(ws, parsedMessage, connectionState);
      
    } catch (error) {
      console.error(`❌ Error handling message from ${connectionState.id}:`, error);
      this.sendError(ws, 'MESSAGE_PROCESSING_ERROR', 'Failed to process message', true);
    }
  }

  /**
   * Handle connection close
   */
  handleConnectionClose(connectionId, connectionState) {
    console.log(`🔌 Connection closed: ${connectionId}`);

    // Clean up terminal streaming if active
    if (connectionState.currentSession) {
      Promise.resolve()
        .then(() => this.terminalHandler.detachFromSession(connectionState.currentSession))
        .catch(error => console.error('Error detaching from session:', error));
    }

    // Clean up authentication
    if (connectionState.authenticatedUser?.token) {
      try {
        this.authManager.logout(connectionState.authenticatedUser.token);
      } catch (error) {
        console.error('Error logging out:', error);
      }
    }

    // Remove connection
    this.connections.delete(connectionId);
    this.connectionCount--;
  }

  /**
   * Handle connection errors
   */
  handleConnectionError(connectionId, error) {
    console.error(`❌ WebSocket error for ${connectionId}:`, error);
    
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.handleConnectionClose(connectionId, connection);
    }
  }

  /**
   * Setup basic heartbeat (simplified from complex monitoring)
   */
  setupBasicHeartbeat(ws, connectionId) {
    const heartbeatInterval = setInterval(() => {
      const connection = this.connections.get(connectionId);
      if (!connection || ws.readyState !== WebSocket.OPEN) {
        clearInterval(heartbeatInterval);
        return;
      }

      // Check for inactive connections (5 minutes)
      const inactiveTime = Date.now() - connection.lastActivity;
      if (inactiveTime > 5 * 60 * 1000) {
        console.log(`⚠️  Closing inactive connection: ${connectionId}`);
        ws.close(1000, 'Connection inactive');
        clearInterval(heartbeatInterval);
        return;
      }

      // Send ping
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Send error message to WebSocket
   */
  sendError(ws, errorCode, message, retryable) {
    if (ws.readyState === WebSocket.OPEN) {
      const errorMessage = {
        type: 'error',
        data: {
          error_code: errorCode,
          message: message,
          retryable: retryable
        },
        timestamp: new Date().toISOString(),
        id: uuidv4()
      };
      
      ws.send(JSON.stringify(errorMessage));
    }
  }

  /**
   * Get basic connection statistics (simplified)
   */
  getBasicConnectionStats() {
    const connections = Array.from(this.connections.values());
    const authenticatedConnections = connections.filter(c => c.authenticatedUser).length;
    const activeStreams = this.terminalHandler.getActiveStreams().length;
    
    return {
      total_connections: this.connectionCount,
      active_connections: connections.length,
      authenticated_connections: authenticatedConnections,
      active_terminal_streams: activeStreams,
      max_connections: this.maxConnections
    };
  }

  /**
   * Setup cleanup handlers for graceful shutdown
   */
  setupCleanupHandlers() {
    const gracefulShutdown = async (signal) => {
      console.log(`\n🛑 Received ${signal}, initiating graceful shutdown...`);
      
      try {
        // Stop relay client if active
        if (this.relayClient) {
          this.relayClient.stop();
        }

        // Close WebSocket server
        console.log('🔌 Closing WebSocket connections...');
        this.wss.clients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1001, 'Server shutting down');
          }
        });

        this.wss.close();
        
        // Clean up terminal handler
        console.log('🧹 Cleaning up terminal streams...');
        await this.terminalHandler.cleanup();
        
        // Clean up session manager
        console.log('💾 Saving session state...');
        await this.sessionManager.cleanupInactiveSessions();
        
        // Close HTTP server
        console.log('📡 Closing HTTP server...');
        this.server.close(() => {
          console.log('✅ Graceful shutdown complete');
          process.exit(0);
        });
        
        // Force exit after 10 seconds
        setTimeout(() => {
          console.log('⚠️  Force exit after timeout');
          process.exit(1);
        }, 10000);
        
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('❌ Uncaught Exception:', error);
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      gracefulShutdown('UNHANDLED_REJECTION');
    });

    console.log('🛡️  Graceful shutdown handlers configured');
  }

  /**
   * Start the server
   */
  start(callback) {
    const PORT = process.env.PORT || this.config.server.port || 8080;
    const HOST = process.env.HOST || this.config.server.host || 'localhost';

    if (process.env.RELAY_URL) {
      const RelayClient = require('./relayClient');
      this.relayClient = new RelayClient(
        process.env.RELAY_URL,
        async (ws, relayUser) => {
          await this.sessionManager.killAllActiveSessions();
          this.handleNewConnection(ws, { socket: { remoteAddress: 'relay' } }, relayUser);
        }
      );
      this.relayClient.start();
      console.log('\n🎉 Claude Remote Service Started Successfully!');
      console.log('=====================================');
      console.log(`🔗 Relay mode active: ${process.env.RELAY_URL}`);
      console.log('=====================================');
      console.log('📋 Service Status:');
      console.log('   - Authentication: ✅ Ready');
      console.log('   - Session Management: ✅ Ready');
      console.log('   - Terminal Streaming: ✅ Ready');
      console.log('=====================================\n');
      if (callback) callback();
    } else {
      this.server.listen(PORT, HOST, () => {
        console.log('\n🎉 Claude Remote Service Started Successfully!');
        console.log('=====================================');
        console.log(`🌐 Server running on ${HOST}:${PORT}`);
        console.log(`🔌 WebSocket URL: ws://${HOST}:${PORT}`);
        console.log(`🏥 Health Check: http://${HOST}:${PORT}/health`);
        console.log(`📊 Statistics: http://${HOST}:${PORT}/stats`);
        console.log('=====================================');
        console.log('📋 Service Status:');
        console.log('   - Authentication: ✅ Ready');
        console.log('   - Session Management: ✅ Ready');
        console.log('   - Terminal Streaming: ✅ Ready');
        console.log('=====================================\n');
        console.log('🚀 Ready to accept connections from Flutter app!\n');

        if (callback) callback();
      });
    }

    // Setup basic maintenance tasks
    this.setupMaintenanceTasks();
  }

  /**
   * Setup maintenance tasks
   */
  setupMaintenanceTasks() {
    // Clean up expired auth sessions every minute
    setInterval(() => {
      this.authManager.cleanupExpiredSessions();
    }, 60000);

    // Clean up inactive sessions every 5 minutes
    setInterval(() => {
      this.sessionManager.cleanupInactiveSessions();
    }, 300000);

    console.log('🔄 Maintenance tasks scheduled');
  }
}

// Create and start the server
const server = new ClaudeRemoteServer();
server.start();

module.exports = ClaudeRemoteServer;