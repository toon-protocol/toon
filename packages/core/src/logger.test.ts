import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger } from './logger.js';
import type { Logger, LogEntry } from './logger.js';

describe('createLogger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };
  });

  describe('JSON output mode (default)', () => {
    it('should output structured JSON for info level', () => {
      const log = createLogger({ component: 'bootstrap' });
      log.info('Peer registered', { peerId: 'abc123' });

      expect(consoleSpy.log).toHaveBeenCalledOnce();
      const output = consoleSpy.log.mock.calls[0]?.[0] as string;
      const entry = JSON.parse(output) as LogEntry;

      expect(entry.level).toBe('info');
      expect(entry.component).toBe('bootstrap');
      expect(entry.msg).toBe('Peer registered');
      expect(entry['peerId']).toBe('abc123');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should use console.error for error level', () => {
      const log = createLogger({ component: 'x402' });
      log.error('Settlement failed', { reason: 'insufficient funds' });

      expect(consoleSpy.error).toHaveBeenCalledOnce();
      expect(consoleSpy.log).not.toHaveBeenCalled();

      const output = consoleSpy.error.mock.calls[0]?.[0] as string;
      const entry = JSON.parse(output) as LogEntry;
      expect(entry.level).toBe('error');
      expect(entry['reason']).toBe('insufficient funds');
    });

    it('should use console.warn for warn level', () => {
      const log = createLogger({ component: 'relay' });
      log.warn('Connection dropped');

      expect(consoleSpy.warn).toHaveBeenCalledOnce();
      const output = consoleSpy.warn.mock.calls[0]?.[0] as string;
      const entry = JSON.parse(output) as LogEntry;
      expect(entry.level).toBe('warn');
    });

    it('should include static context fields in every entry', () => {
      const log = createLogger({
        component: 'attestation',
        context: { nodeId: 'genesis', enclaveType: 'marlin-oyster' },
      });

      log.info('Attestation published');
      log.warn('Attestation stale');

      expect(consoleSpy.log).toHaveBeenCalledOnce();
      expect(consoleSpy.warn).toHaveBeenCalledOnce();

      const infoEntry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      const warnEntry = JSON.parse(
        consoleSpy.warn.mock.calls[0]?.[0] as string
      ) as LogEntry;

      expect(infoEntry['nodeId']).toBe('genesis');
      expect(infoEntry['enclaveType']).toBe('marlin-oyster');
      expect(warnEntry['nodeId']).toBe('genesis');
      expect(warnEntry['enclaveType']).toBe('marlin-oyster');
    });

    it('should merge per-call fields with context', () => {
      const log = createLogger({
        component: 'bootstrap',
        context: { nodeId: 'peer-1' },
      });

      log.info('Channel opened', { channelId: 'ch-42', deposit: '1000' });

      const entry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      expect(entry['nodeId']).toBe('peer-1');
      expect(entry['channelId']).toBe('ch-42');
      expect(entry['deposit']).toBe('1000');
    });
  });

  describe('log level filtering', () => {
    it('should suppress debug when level is info (default)', () => {
      const log = createLogger({ component: 'test' });
      log.debug('Should not appear');

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
    });

    it('should emit debug when level is debug', () => {
      const log = createLogger({ component: 'test', level: 'debug' });
      log.debug('Trace message');

      expect(consoleSpy.log).toHaveBeenCalledOnce();
    });

    it('should suppress info and debug when level is warn', () => {
      const log = createLogger({ component: 'test', level: 'warn' });
      log.debug('suppressed');
      log.info('suppressed');
      log.warn('visible');
      log.error('visible');

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalledOnce();
      expect(consoleSpy.error).toHaveBeenCalledOnce();
    });

    it('should only emit error when level is error', () => {
      const log = createLogger({ component: 'test', level: 'error' });
      log.debug('suppressed');
      log.info('suppressed');
      log.warn('suppressed');
      log.error('visible');

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalledOnce();
    });
  });

  describe('human-readable output mode', () => {
    it('should output human-readable format when json is false', () => {
      const log = createLogger({ component: 'relay', json: false });
      log.info('Server started', { port: 7100 });

      expect(consoleSpy.log).toHaveBeenCalledOnce();
      const output = consoleSpy.log.mock.calls[0]?.[0] as string;
      expect(output).toContain('[INFO]');
      expect(output).toContain('[relay]');
      expect(output).toContain('Server started');
      expect(output).toContain('"port":7100');
    });

    it('should omit extra JSON when no fields', () => {
      const log = createLogger({ component: 'relay', json: false });
      log.info('Ready');

      const output = consoleSpy.log.mock.calls[0]?.[0] as string;
      expect(output).toBe('[INFO] [relay] Ready');
    });
  });

  describe('child logger', () => {
    it('should inherit parent context and add own fields', () => {
      const parent = createLogger({
        component: 'dvm',
        context: { nodeId: 'worker-1' },
      });

      const child: Logger = parent.child({ correlationId: 'job-abc' });
      child.info('Job started');

      const entry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      expect(entry.component).toBe('dvm');
      expect(entry['nodeId']).toBe('worker-1');
      expect(entry['correlationId']).toBe('job-abc');
    });

    it('should not affect parent context', () => {
      const parent = createLogger({
        component: 'dvm',
        context: { nodeId: 'worker-1' },
      });

      parent.child({ correlationId: 'job-abc' });
      parent.info('Parent log');

      const entry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      expect(entry['correlationId']).toBeUndefined();
      expect(entry['nodeId']).toBe('worker-1');
    });

    it('should inherit log level from parent', () => {
      const parent = createLogger({
        component: 'dvm',
        level: 'warn',
      });

      const child = parent.child({ correlationId: 'job-abc' });
      child.info('Should be suppressed');
      child.warn('Should be visible');

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalledOnce();
    });
  });

  describe('edge cases', () => {
    it('should handle empty message', () => {
      const log = createLogger({ component: 'test' });
      log.info('');

      const entry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      expect(entry.msg).toBe('');
    });

    it('should handle no fields argument', () => {
      const log = createLogger({ component: 'test' });
      log.info('Simple message');

      const entry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      expect(entry.msg).toBe('Simple message');
      expect(entry.component).toBe('test');
    });

    it('should handle fields overriding context', () => {
      const log = createLogger({
        component: 'test',
        context: { key: 'context-value' },
      });
      log.info('Override', { key: 'field-value' });

      const entry = JSON.parse(
        consoleSpy.log.mock.calls[0]?.[0] as string
      ) as LogEntry;
      expect(entry['key']).toBe('field-value');
    });
  });
});
