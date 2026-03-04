const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const PLACEHOLDER_SECRETS = ['your-jwt-secret-here', 'GENERATE_ON_FIRST_RUN', 'default-secret'];

class AuthManager {
  constructor(config) {
    this.jwtSecret = this.resolveJwtSecret(config);
    this.jwtExpiresIn = config.auth.jwtExpiresIn;
    this.bcryptRounds = config.auth.bcryptRounds;
    this.activeSessions = new Map();
    this.failedAttempts = new Map();
    this.users = new Map();

    // User persistence
    this.usersFile = path.resolve(__dirname, '..', 'data', 'users.json');

    // Initialize: load persisted users, then ensure default user exists
    this.userInitialized = this.initializeUsers();

    console.log('AuthManager initialized with JWT and bcrypt');
  }

  /**
   * Resolve JWT secret: env var > config (if not placeholder) > ephemeral random
   */
  resolveJwtSecret(config) {
    // 1. Environment variable
    if (process.env.JWT_SECRET) {
      console.log('JWT secret loaded from JWT_SECRET environment variable');
      return process.env.JWT_SECRET;
    }

    // 2. Config value (if not a placeholder)
    const configSecret = config.auth?.jwtSecret;
    if (configSecret && !PLACEHOLDER_SECRETS.includes(configSecret)) {
      console.log('JWT secret loaded from config');
      return configSecret;
    }

    // 3. Generate ephemeral secret
    const ephemeral = crypto.randomBytes(32).toString('hex');
    console.warn('WARNING: No persistent JWT secret configured. Generated ephemeral secret. Set JWT_SECRET env var for persistence.');
    return ephemeral;
  }

  /**
   * Load persisted users, then ensure default admin user exists
   */
  async initializeUsers() {
    await this.loadUsersFromDisk();

    if (!this.users.has('admin')) {
      const defaultPassword = 'TestPassword123!';
      const hashedPassword = await this.hashPassword(defaultPassword);

      this.users.set('admin', {
        username: 'admin',
        password_hash: hashedPassword,
        permissions: ['terminal_access', 'session_management'],
        created_at: new Date().toISOString(),
        status: 'active',
        max_sessions: 10
      });

      await this.saveUsersToDisk();
      console.log('Default admin user created');
    } else {
      console.log('Loaded users from persistence');
    }
  }

  /**
   * Load users from data/users.json
   */
  async loadUsersFromDisk() {
    try {
      if (fs.existsSync(this.usersFile)) {
        const data = fs.readFileSync(this.usersFile, 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.users)) {
          for (const user of parsed.users) {
            this.users.set(user.username, user);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load users from disk:', error.message);
    }
  }

  /**
   * Save users to data/users.json
   */
  async saveUsersToDisk() {
    try {
      const dataDir = path.dirname(this.usersFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const data = {
        version: '1.0.0',
        savedAt: new Date().toISOString(),
        users: Array.from(this.users.values())
      };

      fs.writeFileSync(this.usersFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to save users to disk:', error.message);
    }
  }

  async authenticate(username, password, clientInfo = {}) {
    try {
      await this.userInitialized;

      const deviceId = clientInfo.device_id || 'unknown';
      if (!this.checkRateLimit(deviceId)) {
        throw new AuthError('RATE_LIMITED', 'Too many authentication attempts');
      }

      const user = this.users.get(username);
      if (!user) {
        this.recordFailedAttempt(deviceId);
        throw new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
      }

      const isValid = await this.verifyPassword(password, user.password_hash);
      if (!isValid) {
        this.recordFailedAttempt(deviceId);
        throw new AuthError('INVALID_CREDENTIALS', 'Invalid username or password');
      }

      if (user.status !== 'active') {
        throw new AuthError('ACCOUNT_LOCKED', 'Account is not active');
      }

      const token = this.generateToken(user, clientInfo);
      const expiresAt = new Date(Date.now() + this.parseExpiresIn(this.jwtExpiresIn));

      const sessionId = uuidv4();
      this.activeSessions.set(token, {
        sessionId,
        userId: user.username,
        deviceId,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastActivity: new Date().toISOString()
      });

      this.failedAttempts.delete(deviceId);

      return {
        success: true,
        token,
        expiresAt: expiresAt.toISOString(),
        userInfo: {
          username: user.username,
          permissions: user.permissions
        }
      };
    } catch (error) {
      if (error instanceof AuthError) {
        return {
          success: false,
          error: error.code,
          message: error.message,
          retryable: error.retryable
        };
      }
      throw error;
    }
  }

  async validateToken(token) {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);

      const session = this.activeSessions.get(token);
      if (!session) {
        throw new AuthError('TOKEN_INVALID', 'Session not found');
      }

      const user = this.users.get(decoded.username);
      if (!user || user.status !== 'active') {
        this.activeSessions.delete(token);
        throw new AuthError('TOKEN_INVALID', 'User account not found or inactive');
      }

      session.lastActivity = new Date().toISOString();

      return {
        valid: true,
        user: {
          username: decoded.username,
          permissions: decoded.permissions,
          deviceId: decoded.device_id
        }
      };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        this.activeSessions.delete(token);
        throw new AuthError('TOKEN_EXPIRED', 'Token has expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new AuthError('TOKEN_INVALID', 'Invalid token');
      } else if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError('TOKEN_INVALID', 'Token validation failed');
    }
  }

  async hashPassword(password) {
    return await bcrypt.hash(password, this.bcryptRounds);
  }

  async verifyPassword(plainPassword, hashedPassword) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }

  generateToken(user, clientInfo) {
    const payload = {
      sub: user.username,
      username: user.username,
      permissions: user.permissions,
      device_id: clientInfo.device_id || 'unknown',
      session_count: 0,
      last_activity: Date.now()
    };

    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn,
      issuer: 'claude-remote-service',
      audience: 'claude-remote-client'
    });
  }

  checkRateLimit(deviceId) {
    const attempts = this.failedAttempts.get(deviceId) || [];
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 5;

    const recentAttempts = attempts.filter(time => now - time < windowMs);
    return recentAttempts.length < maxAttempts;
  }

  recordFailedAttempt(deviceId) {
    const attempts = this.failedAttempts.get(deviceId) || [];
    attempts.push(Date.now());
    this.failedAttempts.set(deviceId, attempts);
  }

  parseExpiresIn(expiresIn) {
    if (typeof expiresIn === 'number') {
      return expiresIn * 1000;
    }

    const match = expiresIn.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error('Invalid expiresIn format');
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: throw new Error('Invalid time unit');
    }
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of this.activeSessions) {
      if (new Date(session.expiresAt).getTime() < now) {
        this.activeSessions.delete(token);
      }
    }
  }

  logout(token) {
    this.activeSessions.delete(token);
    return { success: true };
  }

  async login(username, password, clientInfo) {
    const result = await this.authenticate(username, password, clientInfo);
    if (result.success) {
      return {
        success: true,
        token: result.token,
        user: result.userInfo
      };
    } else {
      return {
        success: false,
        error: result.message || result.error
      };
    }
  }

  /**
   * Validate password meets minimum requirements:
   * - At least 8 characters
   * - At least one uppercase letter
   * - At least one lowercase letter
   * - At least one number
   */
  validatePassword(password) {
    if (!password || typeof password !== 'string') {
      return { valid: false, error: 'Password is required' };
    }
    if (password.length < 8) {
      return { valid: false, error: 'Password must be at least 8 characters' };
    }
    if (!/[A-Z]/.test(password)) {
      return { valid: false, error: 'Password must contain at least one uppercase letter' };
    }
    if (!/[a-z]/.test(password)) {
      return { valid: false, error: 'Password must contain at least one lowercase letter' };
    }
    if (!/[0-9]/.test(password)) {
      return { valid: false, error: 'Password must contain at least one number' };
    }
    return { valid: true };
  }

  async register(username, password) {
    await this.userInitialized;

    if (this.users.has(username)) {
      return {
        success: false,
        error: 'Username already exists'
      };
    }

    // Validate password
    const passwordCheck = this.validatePassword(password);
    if (!passwordCheck.valid) {
      return {
        success: false,
        error: passwordCheck.error
      };
    }

    try {
      const hashedPassword = await this.hashPassword(password);
      this.users.set(username, {
        username,
        password_hash: hashedPassword,
        permissions: ['terminal_access', 'session_management'],
        created_at: new Date().toISOString(),
        status: 'active',
        max_sessions: 10
      });

      await this.saveUsersToDisk();

      return {
        success: true,
        user: { username }
      };
    } catch (error) {
      return {
        success: false,
        error: 'Registration failed'
      };
    }
  }
}

class AuthError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryable = retryable;
  }
}

module.exports = AuthManager;
