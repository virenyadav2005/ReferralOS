import test from 'node:test';
import assert from 'node:assert/strict';
import { experienceLevelOptions, formatExperienceLevel } from '../../web/src/experience-levels.js';

test('experience labels show agreed ranges while preserving existing API values', () => {
  assert.deepEqual(experienceLevelOptions, [
    { value: 'intern', label: 'Intern' },
    { value: 'entry', label: 'Entry Level (0–2 years)' },
    { value: 'mid', label: 'Mid Level (2–5 years)' },
    { value: 'senior', label: 'Senior Level (5–8 years)' },
    { value: 'lead', label: 'Lead / Expert (8+ years)' },
    { value: 'executive', label: 'Executive' },
  ]);
  assert.equal(formatExperienceLevel('mid'), 'Mid Level (2–5 years)');
  assert.equal(formatExperienceLevel('unknown'), 'unknown');
});
