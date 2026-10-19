import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatJobValidationErrors, jobValidationKey, jobValidationLabel } from '../../web/src/job-validation.js';

test('server workflow validation paths map to readable job-form field errors', () => {
  const errors = formatJobValidationErrors([
    { field: 'title', message: 'String must contain at least 3 character(s)' },
    { field: 'steps.0.destinationUrl', message: 'This action requires a destination URL.' },
    { field: 'steps.1.destinationEmail', message: 'Invalid email' },
  ]);
  assert.deepEqual(errors, {
    title: 'String must contain at least 3 character(s)',
    'step-0-destinationUrl': 'This action requires a destination URL.',
    'step-1-destinationEmail': 'Invalid email',
  });
  assert.equal(jobValidationKey('steps.2.instructions'), 'step-2-instructions');
  assert.equal(jobValidationLabel('step-0-destinationUrl'), 'Step 1 destination url');
  assert.equal(jobValidationLabel('companyId'), 'Company');
});

test('job workflow controls keep each step property bound to its matching control', () => {
  const pages = readFileSync(new URL('../../web/src/Pages.tsx', import.meta.url), 'utf8');
  assert.match(pages, /value=\{step\.title\} onChange=\{\(e\)=>updateStep\(index,'title',e\.target\.value\)\}/);
  assert.match(pages, /value=\{step\.responsible\} onChange=\{\(e\)=>updateStep\(index,'responsible',e\.target\.value\)\}/);
  assert.match(pages, /value=\{step\.actionType\} onChange=\{\(e\)=>updateStep\(index,'actionType',e\.target\.value\)\}/);
  assert.match(pages, /value=\{step\.destinationUrl\} onChange=\{\(e\)=>updateStep\(index,'destinationUrl',e\.target\.value\)\}/);
  assert.match(pages, /value=\{step\.destinationEmail\} onChange=\{\(e\)=>updateStep\(index,'destinationEmail',e\.target\.value\)\}/);
  assert.match(pages, /value=\{step\.completionMethod\} onChange=\{\(e\)=>updateStep\(index,'completionMethod',e\.target\.value\)\}/);
  assert.match(pages, /value=\{step\.instructions\} onChange=\{\(e\)=>updateStep\(index,'instructions',e\.target\.value\)\}/);
  assert.match(pages, /checked=\{step\.requiresApplicationId\} onChange=\{\(e\)=>updateStep\(index,'requiresApplicationId',e\.target\.checked\)\}/);
});
