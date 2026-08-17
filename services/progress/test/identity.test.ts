/**
 * The development identity, and the limits it is honest about.
 *
 * These tests exist as much to document the limitation as to check the code:
 * the override is off unless a deployment asks for it, and even then it is
 * validated rather than trusted. None of this is authentication and no test
 * here should ever be read as claiming otherwise.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_STUDENT_ID,
  DEV_STUDENT_HEADER,
  DevStudentIdentity,
  assertValidStudentId,
} from '../src/identity.js';
import { ProgressError } from '../src/types.js';

describe('DevStudentIdentity', () => {
  it('resolves every request to the configured development student', () => {
    const identity = new DevStudentIdentity();
    const resolved = identity.resolve();

    expect(resolved.studentId).toBe(DEFAULT_DEV_STUDENT_ID);
    expect(resolved.studentId).toBe('dev-student-001');
    // Served to the client so the UI can say "development identity" instead of
    // implying somebody signed in.
    expect(resolved.authenticated).toBe(false);
    expect(resolved.source).toBe('development-default');
  });

  it('ignores the override header unless the deployment enabled it', () => {
    const identity = new DevStudentIdentity({ studentId: 'dev-student-001' });

    expect(identity.headerName).toBeNull();
    expect(identity.resolve({ header: 'dev-student-999' }).studentId).toBe('dev-student-001');
  });

  it('honours the override header when it is switched on for development', () => {
    const identity = new DevStudentIdentity({ allowHeaderOverride: true });

    expect(identity.headerName).toBe(DEV_STUDENT_HEADER);
    const resolved = identity.resolve({ header: 'dev-student-002' });
    expect(resolved.studentId).toBe('dev-student-002');
    expect(resolved.source).toBe('development-header');
    expect(resolved.authenticated).toBe(false);
  });

  it('falls back to the default when the header is empty', () => {
    const identity = new DevStudentIdentity({ allowHeaderOverride: true });
    expect(identity.resolve({ header: '   ' }).studentId).toBe('dev-student-001');
    expect(identity.resolve({}).studentId).toBe('dev-student-001');
  });

  it('rejects a malformed override rather than silently using the default', () => {
    const identity = new DevStudentIdentity({ allowHeaderOverride: true });
    expect(() => identity.resolve({ header: 'Robert; DROP TABLE students' })).toThrow(ProgressError);
    expect(() => identity.resolve({ header: 'a' })).toThrow(ProgressError);
  });

  it('validates student ids everywhere they enter the system', () => {
    expect(assertValidStudentId('dev-student-001')).toBe('dev-student-001');
    expect(assertValidStudentId('  DEV-Student-001  ')).toBe('dev-student-001');

    for (const bad of ['', 'ab', '-leading', 'has space', 'x'.repeat(65), null, 42]) {
      expect(() => assertValidStudentId(bad)).toThrow(ProgressError);
    }
  });
});
