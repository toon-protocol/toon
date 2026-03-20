/**
 * Tests for DVM Kind Constants and Export Verification (Story 5.1, AC #6)
 *
 * Split from dvm.test.ts during A4 (Epic 6 start).
 *
 * Test IDs:
 * - T-5.1-08 [P2]: Kind constants defined
 * - T-5.1-23 [P0]: Export verification from @toon-protocol/core
 */

import { describe, it, expect } from 'vitest';

// DVM kind constants
import {
  JOB_REQUEST_KIND_BASE,
  JOB_RESULT_KIND_BASE,
  JOB_FEEDBACK_KIND,
  TEXT_GENERATION_KIND,
  IMAGE_GENERATION_KIND,
  TEXT_TO_SPEECH_KIND,
  TRANSLATION_KIND,
} from '../constants.js';

describe('DVM kind constants and exports', () => {
  // --------------------------------------------------------------------------
  // T-5.1-08 [P2]: Kind constants defined
  // --------------------------------------------------------------------------
  describe('DVM kind constants (T-5.1-08)', () => {
    it('[P2] JOB_REQUEST_KIND_BASE equals 5000', () => {
      expect(JOB_REQUEST_KIND_BASE).toBe(5000);
    });

    it('[P2] JOB_RESULT_KIND_BASE equals 6000', () => {
      expect(JOB_RESULT_KIND_BASE).toBe(6000);
    });

    it('[P2] JOB_FEEDBACK_KIND equals 7000', () => {
      expect(JOB_FEEDBACK_KIND).toBe(7000);
    });

    it('[P2] TEXT_GENERATION_KIND equals 5100 (reference DVM kind)', () => {
      expect(TEXT_GENERATION_KIND).toBe(5100);
    });

    it('[P2] IMAGE_GENERATION_KIND equals 5200', () => {
      expect(IMAGE_GENERATION_KIND).toBe(5200);
    });

    it('[P2] TEXT_TO_SPEECH_KIND equals 5300', () => {
      expect(TEXT_TO_SPEECH_KIND).toBe(5300);
    });

    it('[P2] TRANSLATION_KIND equals 5302', () => {
      expect(TRANSLATION_KIND).toBe(5302);
    });
  });

  // ==========================================================================
  // Tests: Export Verification (AC #6)
  // ==========================================================================

  describe('export verification (T-5.1-23)', () => {
    it('[P0] DVM constants importable from @toon-protocol/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: kind constants
      expect(core.JOB_REQUEST_KIND_BASE).toBe(5000);
      expect(core.JOB_RESULT_KIND_BASE).toBe(6000);
      expect(core.JOB_FEEDBACK_KIND).toBe(7000);
      expect(core.TEXT_GENERATION_KIND).toBe(5100);
      expect(core.IMAGE_GENERATION_KIND).toBe(5200);
      expect(core.TEXT_TO_SPEECH_KIND).toBe(5300);
      expect(core.TRANSLATION_KIND).toBe(5302);
    });

    it('[P0] DVM builder functions importable from @toon-protocol/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: builder functions
      expect(typeof core.buildJobRequestEvent).toBe('function');
      expect(typeof core.buildJobResultEvent).toBe('function');
      expect(typeof core.buildJobFeedbackEvent).toBe('function');
    });

    it('[P0] DVM parser functions importable from @toon-protocol/core', async () => {
      // Arrange
      const core = await import('../index.js');

      // Assert: parser functions
      expect(typeof core.parseJobRequest).toBe('function');
      expect(typeof core.parseJobResult).toBe('function');
      expect(typeof core.parseJobFeedback).toBe('function');
    });
  });
});
