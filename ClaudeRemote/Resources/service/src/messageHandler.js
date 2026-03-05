const { v4: uuidv4 } = require('uuid');

/**
 * MessageHandler - Routes and processes WebSocket messages
 * Handles message validation, routing, and response formatting
 */
class MessageHandler {
  constructor(authManager, sessionManager, terminalHandler, config) {
    this.authManager = authManager;
    this.sessionManager = sessionManager;
    this.terminalHandler = terminalHandler;
    this.config = config;
    
    // Message routing map (9 routes for MVP)
    this.messageRoutes = {
      'auth_request': this.handleAuthRequest.bind(this),
      'session_list_request': this.handleSessionListRequest.bind(this),
      'session_create_request': this.handleSessionCreateRequest.bind(this),
      'session_connect_request': this.handleSessionConnectRequest.bind(this),
      'session_disconnect_request': this.handleSessionDisconnectRequest.bind(this),
      'session_status_request': this.handleSessionStatusRequest.bind(this),
      'session_terminate_request': this.handleSessionTerminateRequest.bind(this),
      'terminal_input': this.handleTerminalInput.bind(this),
      'special_key_input': this.handleSpecialKeyInput.bind(this),
      'terminal_resize': this.handleTerminalResize.bind(this),
      'ping': this.handlePing.bind(this)
    };

    console.log('MessageHandler initialized with', Object.keys(this.messageRoutes).length, 'routes');
  }

  /**
   * Route incoming WebSocket message to appropriate handler
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Parsed message object
   * @param {Object} connectionState - Connection state object
   * @returns {Promise<void>}
   */
  async routeMessage(ws, message, connectionState) {
    try {
      // Validate message structure
      const validation = this.validateMessage(message);
      if (!validation.isValid) {
        return this.sendError(ws, 'INVALID_MESSAGE', validation.error, false);
      }

      // Get message handler
      const handler = this.messageRoutes[message.type];
      if (!handler) {
        return this.sendError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`, false);
      }

      // Execute handler
      await handler(ws, message, connectionState);
      
    } catch (error) {
      console.error(`❌ Error routing message ${message.type}:`, error);
      this.sendError(ws, 'MESSAGE_PROCESSING_ERROR', 'Failed to process message', true);
    }
  }

  /**
   * Handle authentication requests
   */
  async handleAuthRequest(ws, message, connectionState) {
    try {
      const { username, password, client_info } = message.data;
      
      if (!username || !password) {
        return this.sendError(ws, 'INVALID_CREDENTIALS', 'Username and password required', true);
      }
      
      const result = await this.authManager.authenticate(username, password, client_info);
      
      if (result.success) {
        connectionState.authenticatedUser = {
          username: result.userInfo.username,
          permissions: result.userInfo.permissions,
          token: result.token
        };
        
        this.sendResponse(ws, 'auth_response', {
          success: true,
          token: result.token,
          expires_at: result.expiresAt,
          user_info: result.userInfo
        });
      } else {
        this.sendResponse(ws, 'auth_response', {
          success: false,
          error: result.error,
          message: result.message,
          retryable: result.retryable
        });
      }
    } catch (error) {
      console.error('Authentication error:', error);
      this.sendError(ws, 'AUTH_FAILED', 'Authentication failed', true);
    }
  }

  /**
   * Handle session list requests
   */
  async handleSessionListRequest(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const sessions = await this.sessionManager.listClaudeHistorySessions();
      
      this.sendResponse(ws, 'session_list_response', {
        sessions: sessions,
        total_sessions: sessions.length
      });
    } catch (error) {
      console.error('Session list error:', error);
      this.sendError(ws, 'SESSION_ERROR', 'Failed to list sessions', true);
    }
  }

  /**
   * Handle session creation requests
   */
  async handleSessionCreateRequest(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { directory: rawDir, session_name, skip_permissions } = message.data;
      const directory = (rawDir && rawDir.trim()) || '~';

      const result = await this.sessionManager.createClaudeSession(
        directory,
        session_name,
        connectionState.authenticatedUser.username,
        !!skip_permissions
      );
      
      if (result.success) {
        this.sendResponse(ws, 'session_create_response', {
          success: true,
          session: result.session
        });
      } else {
        this.sendError(ws, result.errorCode || 'SESSION_CREATE_FAILED', result.error, true);
      }
    } catch (error) {
      console.error('Session creation error:', error);
      this.sendError(ws, 'SESSION_CREATE_FAILED', 'Failed to create session', true);
    }
  }

  /**
   * Handle session connection requests
   */
  async handleSessionConnectRequest(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { session_id, skip_permissions } = message.data;

      if (!session_id) {
        return this.sendError(ws, 'SESSION_ID_REQUIRED', 'Session ID is required', false);
      }

      const result = await this.sessionManager.connectToSession(
        session_id,
        connectionState.authenticatedUser.username,
        !!skip_permissions
      );
      
      if (result.success) {
        connectionState.currentSession = session_id;
        
        // Start terminal streaming
        await this.terminalHandler.attachToSession(session_id, ws, connectionState);
        
        this.sendResponse(ws, 'session_connect_response', {
          success: true,
          session_id: session_id,
          session: result.session
        });
      } else {
        this.sendError(ws, result.errorCode || 'SESSION_CONNECTION_FAILED', result.error, false);
      }
    } catch (error) {
      console.error('Session connection error:', error);
      this.sendError(ws, 'SESSION_CONNECTION_FAILED', error.message, false);
    }
  }

  /**
   * Handle session disconnection requests
   */
  async handleSessionDisconnectRequest(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { session_id } = message.data;
      const sessionToDisconnect = session_id || connectionState.currentSession;
      
      if (!sessionToDisconnect) {
        return this.sendError(ws, 'NO_ACTIVE_SESSION', 'No session to disconnect from', false);
      }
      
      // Stop terminal streaming
      await this.terminalHandler.detachFromSession(sessionToDisconnect);
      
      // Disconnect from session
      const result = await this.sessionManager.disconnectFromSession(
        sessionToDisconnect,
        connectionState.authenticatedUser.username
      );
      
      if (result.success) {
        connectionState.currentSession = null;
        
        this.sendResponse(ws, 'session_disconnect_response', {
          success: true,
          session_id: sessionToDisconnect,
          message: 'Disconnected successfully'
        });
      } else {
        this.sendError(ws, result.errorCode || 'DISCONNECT_FAILED', result.error, true);
      }
    } catch (error) {
      console.error('Session disconnection error:', error);
      this.sendError(ws, 'DISCONNECT_FAILED', error.message, true);
    }
  }

  /**
   * Handle session status requests
   */
  async handleSessionStatusRequest(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { session_id } = message.data;
      
      if (!session_id) {
        return this.sendError(ws, 'SESSION_ID_REQUIRED', 'Session ID is required', false);
      }
      
      const result = await this.sessionManager.getSessionStatus(session_id);
      
      if (result.success) {
        this.sendResponse(ws, 'session_status_response', {
          success: true,
          status: result.status
        });
      } else {
        this.sendError(ws, result.errorCode || 'STATUS_CHECK_FAILED', result.error, false);
      }
    } catch (error) {
      console.error('Session status error:', error);
      this.sendError(ws, 'STATUS_CHECK_FAILED', error.message, true);
    }
  }

  /**
   * Handle terminal input
   */
  async handleTerminalInput(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { session_id, input, sequence_number } = message.data;
      const targetSession = session_id || connectionState.currentSession;
      
      if (!targetSession) {
        return this.sendError(ws, 'NO_ACTIVE_SESSION', 'No active session for input', false);
      }
      
      if (input === undefined) {
        return this.sendError(ws, 'INPUT_REQUIRED', 'Input data is required', false);
      }
      
      await this.terminalHandler.sendInput(targetSession, input, sequence_number);

      // Response is handled by the terminal streaming
    } catch (error) {
      console.error('Terminal input error:', error);
      this.sendError(ws, 'TERMINAL_INPUT_ERROR', error.message, true);
    }
  }

  /**
   * Handle special key input
   */
  async handleSpecialKeyInput(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { session_id, key, modifiers } = message.data;
      const targetSession = session_id || connectionState.currentSession;
      
      if (!targetSession) {
        return this.sendError(ws, 'NO_ACTIVE_SESSION', 'No active session for special key', false);
      }
      
      if (!key) {
        return this.sendError(ws, 'KEY_REQUIRED', 'Key code is required', false);
      }
      
      await this.terminalHandler.handleSpecialKeys(targetSession, key, modifiers);
      
      // Response is handled by the terminal streaming
    } catch (error) {
      console.error('Special key error:', error);
      this.sendError(ws, 'SPECIAL_KEY_ERROR', error.message, true);
    }
  }

  /**
   * Handle terminal resize
   */
  async handleTerminalResize(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;
      
      const { session_id, rows, cols } = message.data;
      const targetSession = session_id || connectionState.currentSession;
      
      if (!targetSession) {
        return this.sendError(ws, 'NO_ACTIVE_SESSION', 'No active session for resize', false);
      }
      
      if (!rows || !cols) {
        return this.sendError(ws, 'DIMENSIONS_REQUIRED', 'Rows and cols are required', false);
      }
      
      const result = await this.terminalHandler.resizeTerminal(targetSession, rows, cols);
      
      this.sendResponse(ws, 'terminal_resize_response', {
        success: true,
        session_id: targetSession,
        terminal_size: result.terminalSize
      });
    } catch (error) {
      console.error('Terminal resize error:', error);
      this.sendError(ws, 'TERMINAL_RESIZE_ERROR', error.message, true);
    }
  }

  /**
   * Handle ping requests
   */
  handlePing(ws, message, connectionState) {
    this.sendResponse(ws, 'pong', {
      ping_id: message.id,
      server_time: new Date().toISOString()
    });
  }

  /**
   * Handle session termination requests
   */
  async handleSessionTerminateRequest(ws, message, connectionState) {
    try {
      if (!await this.validateAuth(ws, message, connectionState)) return;

      const { session_id } = message.data;

      if (!session_id) {
        return this.sendError(ws, 'SESSION_ID_REQUIRED', 'Session ID is required', false);
      }

      // Detach terminal streaming first
      await this.terminalHandler.detachFromSession(session_id);

      // Terminate the session
      const result = await this.sessionManager.terminateSession(
        session_id,
        connectionState.authenticatedUser.username
      );

      if (result.success) {
        if (connectionState.currentSession === session_id) {
          connectionState.currentSession = null;
        }

        this.sendResponse(ws, 'session_terminate_response', {
          success: true,
          session_id: session_id,
          message: 'Session terminated'
        });
      } else {
        this.sendError(ws, result.errorCode || 'SESSION_TERMINATE_FAILED', result.error, false);
      }
    } catch (error) {
      console.error('Session termination error:', error);
      this.sendError(ws, 'SESSION_TERMINATE_FAILED', error.message, true);
    }
  }

  /**
   * Validate message structure
   * @param {Object} message - Message to validate
   * @returns {Object} Validation result
   */
  validateMessage(message) {
    if (!message || typeof message !== 'object') {
      return {
        isValid: false,
        error: 'Message must be an object'
      };
    }

    if (!message.type || typeof message.type !== 'string') {
      return {
        isValid: false,
        error: 'Message type is required and must be a string'
      };
    }

    if (!message.data || typeof message.data !== 'object') {
      return {
        isValid: false,
        error: 'Message data is required and must be an object'
      };
    }

    return { isValid: true };
  }

  /**
   * Validate authentication for protected endpoints
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} message - Message object
   * @param {Object} connectionState - Connection state
   * @returns {Promise<boolean>} Whether authentication is valid
   */
  async validateAuth(ws, message, connectionState) {
    if (!connectionState.authenticatedUser) {
      this.sendError(ws, 'UNAUTHORIZED', 'Authentication required', false);
      return false;
    }

    // Validate token if provided
    if (message.data.token) {
      try {
        await this.authManager.validateToken(message.data.token);
      } catch (error) {
        this.sendError(ws, error.code || 'TOKEN_INVALID', error.message, true);
        return false;
      }
    }

    return true;
  }

  /**
   * Send a formatted response message
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} type - Response type
   * @param {Object} data - Response data
   */
  sendResponse(ws, type, data) {
    try {
      if (ws.readyState !== ws.OPEN) {
        console.warn(`⚠️  Cannot send ${type}: WebSocket not open`);
        return;
      }

      const response = {
        type: type,
        data: data,
        timestamp: new Date().toISOString(),
        id: uuidv4()
      };

      ws.send(JSON.stringify(response));
    } catch (error) {
      console.error(`❌ Error sending response ${type}:`, error);
    }
  }

  /**
   * Send an error message
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} errorCode - Error code
   * @param {string} message - Error message
   * @param {boolean} retryable - Whether the error is retryable
   */
  sendError(ws, errorCode, message, retryable) {
    this.sendResponse(ws, 'error', {
      error_code: errorCode,
      message: message,
      retryable: retryable
    });
  }

  /**
   * Get supported message types
   * @returns {Array} List of supported message types
   */
  getSupportedMessageTypes() {
    return Object.keys(this.messageRoutes);
  }

  /**
   * Get message routing statistics
   * @returns {Object} Routing statistics
   */
  getRoutingStats() {
    return {
      supported_message_types: this.getSupportedMessageTypes(),
      total_routes: Object.keys(this.messageRoutes).length,
      authentication_required: [
        'session_list_request',
        'session_create_request',
        'session_connect_request',
        'session_disconnect_request',
        'session_status_request',
        'session_terminate_request',
        'terminal_input',
        'special_key_input',
        'terminal_resize'
      ],
      public_endpoints: ['auth_request', 'ping']
    };
  }
}

module.exports = MessageHandler;