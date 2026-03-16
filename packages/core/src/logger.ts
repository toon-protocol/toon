/**
 * Structured logging for the Crosstown protocol.
 *
 * Provides JSON-formatted log output with contextual fields for:
 * - TEE enclave observability (component, enclaveType)
 * - DVM job log correlation (correlationId)
 * - Multi-node debugging (nodeId, pubkey)
 *
 * Zero runtime dependencies. Uses console.log/console.error as the
 * transport layer. Output is structured JSON when `json: true` (default
 * in production), or human-readable when `json: false` (development).
 *
 * @module
 */

/**
 * Log levels ordered by severity.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Configuration for creating a Logger instance.
 */
export interface LoggerConfig {
  /** Component name (e.g., 'bootstrap', 'x402', 'attestation') */
  component: string;
  /** Minimum log level to emit. Default: 'info' */
  level?: LogLevel;
  /** Output as JSON. Default: true */
  json?: boolean;
  /** Static context fields merged into every log entry */
  context?: Record<string, unknown>;
}

/**
 * A structured log entry.
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Component that produced the log */
  component: string;
  /** Log message */
  msg: string;
  /** Additional structured fields */
  [key: string]: unknown;
}

/**
 * Structured logger with contextual fields.
 *
 * Usage:
 * ```typescript
 * const log = createLogger({ component: 'bootstrap' });
 * log.info('Peer registered', { peerId: 'abc', ilpAddress: 'g.crosstown.peer' });
 * log.error('Bootstrap failed', { error: err.message });
 *
 * // Child logger with additional context
 * const jobLog = log.child({ correlationId: 'job-123' });
 * jobLog.info('DVM job started');
 * ```
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;

  /**
   * Create a child logger with additional context fields.
   * The child inherits all parent context and adds its own.
   */
  child(context: Record<string, unknown>): Logger;
}

/**
 * Create a structured logger.
 *
 * @param config - Logger configuration
 * @returns A Logger instance
 */
export function createLogger(config: LoggerConfig): Logger {
  const minLevel = config.level ?? 'info';
  const jsonOutput = config.json ?? true;
  const baseContext = config.context ?? {};
  const component = config.component;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minLevel];
  }

  function formatEntry(
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      component,
      msg,
      ...baseContext,
      ...fields,
    };
  }

  function emit(
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>
  ): void {
    if (!shouldLog(level)) return;

    const entry = formatEntry(level, msg, fields);

    if (jsonOutput) {
      const output = JSON.stringify(entry);
      if (level === 'error') {
        console.error(output);
      } else if (level === 'warn') {
        console.warn(output);
      } else {
        console.log(output);
      }
    } else {
      // Human-readable format for development
      const contextStr =
        Object.keys({ ...baseContext, ...fields }).length > 0
          ? ' ' + JSON.stringify({ ...baseContext, ...fields })
          : '';
      const prefix = `[${level.toUpperCase()}] [${component}]`;
      const output = `${prefix} ${msg}${contextStr}`;
      if (level === 'error') {
        console.error(output);
      } else if (level === 'warn') {
        console.warn(output);
      } else {
        console.log(output);
      }
    }
  }

  const logger: Logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (context) =>
      createLogger({
        component,
        level: minLevel,
        json: jsonOutput,
        context: { ...baseContext, ...context },
      }),
  };

  return logger;
}
