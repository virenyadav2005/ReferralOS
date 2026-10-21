import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { closeDatabase, migrateDatabase, openDatabase } from '../src/database.js';
import { parseJobPostingText } from '../src/job-text-parser.js';
import { createScreenshotExtractor, ScreenshotExtractionError } from '../src/screenshot-extraction.js';
import { readConfig } from '../src/config.js';
import { hydrateImportForm, populateImportForm } from '../../web/src/job-import-form.js';

const posting = `Company: Infosys Limited
Job Title: Senior Software Engineer
Job Location: Bengaluru, Karnataka
Experience Required: 4-7 years
Employment Type: Full-time
Work Mode: Hybrid
Required Skills:
Java, Spring Boot, SQL
Qualifications:
B.Tech in Computer Science or equivalent
Job Description:
Build and maintain services for enterprise customers.
Work with product and engineering teams.
Job ID: IN-ENG-2042
Salary Range: ₹18-24 LPA
Application Deadline: 31/12/2026
Official Application URL: https://careers.infosys.example/jobs/IN-ENG-2042
Referral URL: https://referrals.infosys.example/IN-ENG-2042
Referral Instructions:
Apply online and share your application ID with the employee.`;

class ApiClient {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  async call(route, { method = 'GET', body, origin = 'http://127.0.0.1:5173' } = {}) {
    method = method.toUpperCase();
    let csrf = '';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) csrf = (await this.call('/auth/csrf')).data.token;
    const headers = new Headers({ connection: 'close' });
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) { headers.set('origin', origin); headers.set('x-csrf-token', csrf); }
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers.set('content-type', 'application/json'); payload = JSON.stringify(body); }
    const response = await fetch(`${this.base}/api${route}`, { method, headers, body: payload });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]; const index = pair.indexOf('=');
      if (index >= 0) this.cookies.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
    }
    const data = (response.headers.get('content-type') ?? '').includes('application/json') ? await response.json() : null;
    return { status: response.status, data };
  }
}

async function createImportApi(t, extractor) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'referralos-ocr-api-'));
  const filename = path.join(directory, 'test.sqlite');
  const db = openDatabase(filename);
  migrateDatabase(db);
  // These tests isolate screenshot parsing/storage and do not test work-email publishing policy.
  const config = { ...readConfig({ NODE_ENV: 'test', APP_ORIGINS: 'http://127.0.0.1:5173', ENFORCE_VERIFIED_EMPLOYEE_EMAIL: 'false' }), databasePath: filename,
    resumeStoragePath: path.join(directory, 'resumes'), jobImportStoragePath: path.join(directory, 'imports') };
  const app = createApp({ db, config, screenshotExtractor: extractor, webDistPath: path.join(directory, 'missing-web') });
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, directory, base: `http://127.0.0.1:${server.address().port}`, config };
}

async function registerAndUpload(base) {
  const client = new ApiClient(base);
  const registration = await client.call('/auth/register', { method: 'POST', body: {
    email: `importer-${Math.random().toString(16).slice(2)}@example.test`, password: 'a-strong-test-password', displayName: 'Import Reviewer',
    roles: ['employee'], companyName: 'Infosys Limited',
  } });
  assert.equal(registration.status, 201);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6e8AAAAASUVORK5CYII=', 'base64');
  const upload = new FormData(); upload.set('authorizedToShare', 'true'); upload.append('screenshots', new Blob([png], { type: 'image/png' }), 'posting.png');
  const created = await client.call('/employee/job-imports', { method: 'POST', body: upload });
  assert.equal(created.status, 201);
  return { client, draftId: created.data.id, image: created.data.images[0] };
}

test('job posting parser extracts labeled Indian-format fields without inventing an experience level', () => {
  const result = parseJobPostingText(posting);
  assert.equal(result.rawText, posting);
  assert.equal(result.fields.companyName.value, 'Infosys Limited');
  assert.equal(result.fields.title.value, 'Senior Software Engineer');
  assert.equal(result.fields.title.uncertain, false, 'a uniquely labeled value is parsed but still requires final user review');
  assert.equal(result.fields.location.value, 'Bengaluru, Karnataka');
  assert.equal(result.fields.experience.value, '4-7 years');
  assert.equal(result.fields.experienceLevel.value, null, 'years are not converted to an invented seniority enum');
  assert.equal(result.fields.employmentType.value, 'full_time');
  assert.equal(result.fields.workArrangement.value, 'hybrid');
  assert.deepEqual(result.fields.skills.value, ['Java', 'Spring Boot', 'SQL']);
  assert.equal(result.fields.qualifications.value, 'B.Tech in Computer Science or equivalent');
  assert.match(result.fields.description.value, /Build and maintain services/);
  assert.equal(result.fields.requisitionId.value, 'IN-ENG-2042');
  assert.equal(result.fields.salaryRange.value, '₹18-24 LPA');
  assert.equal(result.fields.deadline.value, '2026-12-31', 'DD/MM/YYYY is interpreted in the common Indian order');
  assert.equal(result.fields.applicationUrl.value, 'https://careers.infosys.example/jobs/IN-ENG-2042');
  assert.equal(result.fields.referralUrl.value, 'https://referrals.infosys.example/IN-ENG-2042');
  assert.match(result.fields.referralInstructions.value, /share your application ID/);
});

test('parser leaves missing, ambiguous, malformed, and unclear fields blank for manual review', () => {
  const missing = parseJobPostingText('A hiring notice with no labeled job fields.');
  assert.equal(missing.fields.companyName.value, null);
  assert.equal(missing.fields.title.value, null);
  assert.equal(missing.fields.location.value, null);
  assert.equal(missing.fields.skills.value, null);
  assert.equal(missing.fields.description.value, null);
  assert.equal(missing.fields.deadline.value, null);
  assert.equal(missing.fields.title.uncertain, true);

  const ambiguous = parseJobPostingText('Job Title: Software Engineer\nJob Title: Data Engineer\nDeadline: 45/19/2026');
  assert.equal(ambiguous.fields.title.value, null);
  assert.equal(ambiguous.fields.title.uncertain, true);
  assert.equal(ambiguous.fields.deadline.value, null);
  assert.equal(ambiguous.fields.deadline.uncertain, true);

  const malformed = parseJobPostingText({ ParsedResults: [{ ParsedText: 'ignored' }] });
  assert.equal(malformed.rawText, '');
  assert.equal(malformed.fields.description.value, null);
});

test('OCR adapter returns structured fields and rejects malformed provider responses', async () => {
  const config = { nodeEnv: 'production', screenshotOcrUrl: 'https://api.ocr.space/parse/image', screenshotOcrApiKey: 'test-only' };
  const valid = createScreenshotExtractor(config, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: posting }] }) }) });
  const result = await valid.extract([{ mimeType: 'image/png', buffer: Buffer.from('mock image') }]);
  assert.equal(result.fields.title.value, 'Senior Software Engineer');
  assert.equal(result.fields.workArrangement.value, 'hybrid');
  assert.match(result.rawText, /Company: Infosys Limited/);

  const malformed = createScreenshotExtractor(config, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ OCRExitCode: 4, IsErroredOnProcessing: true, ParsedResults: [] }) }) });
  await assert.rejects(() => malformed.extract([{ mimeType: 'image/png', buffer: Buffer.from('mock image') }]), (error) => error instanceof ScreenshotExtractionError && error.category === 'provider_response_error');
});

test('extracted values populate the controlled form state and saved dates hydrate correctly', () => {
  const blank = { companyId: '', companyName: '', title: '', description: '', location: '', experience: '', locationType: '', experienceLevel: '', employmentType: '', skills: [], salaryRange: '', sourceUrl: '', referralUrl: '', workflowTemplate: '', expiresAt: '', requisitionId: '', qualifications: '', referralInstructions: '' };
  const fields = parseJobPostingText(posting).fields;
  const affiliations = [{ company_id: 'company-1', company_name: '  infosys   limited ', status: 'pending' }];
  const populated = populateImportForm(blank, fields, affiliations);
  assert.equal(populated.companyId, 'company-1', 'an exact normalized affiliation match is selected');
  assert.equal(populated.companyName, 'Infosys Limited');
  assert.equal(populated.title, 'Senior Software Engineer');
  assert.equal(populated.location, 'Bengaluru, Karnataka');
  assert.equal(populated.experience, '4-7 years');
  assert.equal(populated.experienceLevel, '', 'no inferred seniority is put into the required select');
  assert.equal(populated.employmentType, 'full_time');
  assert.equal(populated.locationType, 'hybrid');
  assert.deepEqual(populated.skills, ['Java', 'Spring Boot', 'SQL']);
  assert.equal(populated.description, fields.description.value);
  assert.equal(populated.expiresAt, '2026-12-31');
  assert.equal(populated.sourceUrl, fields.applicationUrl.value);

  const edited = populateImportForm({ ...populated, title: 'My corrected title' }, fields, affiliations);
  assert.equal(edited.title, 'My corrected title', 'manual edits are not overwritten');
  const unknownCompany = populateImportForm(blank, fields, [{ company_id: 'other', company_name: 'Different employer', status: 'pending' }]);
  assert.equal(unknownCompany.companyName, 'Infosys Limited');
  assert.equal(unknownCompany.companyId, '', 'unaffiliated companies are never selected or added implicitly');

  const hydrated = hydrateImportForm(blank, { ...populated, expiresAt: '2026-12-31T23:59:59.000Z' }, affiliations);
  assert.equal(hydrated.expiresAt, '2026-12-31');
  assert.deepEqual(hydrated.skills, ['Java', 'Spring Boot', 'SQL']);
});

test('authorized screenshot-import route persists structured fields and raw OCR evidence without publishing', async (t) => {
  let calls = 0;
  const { base, db } = await createImportApi(t, { configured: true, async extract() { calls += 1; return { ...parseJobPostingText(posting), provider: 'ocr.space' }; } });
  const { client, draftId } = await registerAndUpload(base);
  const withoutConsent = await client.call(`/employee/job-imports/${draftId}/extract`, { method: 'POST', body: { consentToExternalProcessing: false } });
  assert.equal(withoutConsent.status, 400);
  assert.equal(calls, 0, 'OCR is not called before explicit consent');
  const response = await client.call(`/employee/job-imports/${draftId}/extract`, { method: 'POST', body: { consentToExternalProcessing: true } });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(response.data.draft.companyName, 'Infosys Limited');
  assert.equal(response.data.draft.title, 'Senior Software Engineer');
  assert.equal(response.data.draft.location, 'Bengaluru, Karnataka');
  assert.equal(response.data.draft.experience, '4-7 years');
  assert.equal(response.data.draft.employmentType, 'full_time');
  assert.equal(response.data.draft.locationType, 'hybrid');
  assert.deepEqual(response.data.draft.skills, ['Java', 'Spring Boot', 'SQL']);
  assert.equal(response.data.draft.sourceUrl, 'https://careers.infosys.example/jobs/IN-ENG-2042');
  assert.equal(response.data.draft.expiresAt, '2026-12-31');
  assert.equal(response.data.extracted.rawText, posting);
  assert.equal(response.data.draft.workflowTemplate, undefined, 'the parser never chooses a referral workflow');
  const saved = JSON.parse(db.prepare('SELECT draft_json FROM job_import_drafts WHERE id=?').get(draftId).draft_json);
  assert.equal(saved.title, 'Senior Software Engineer');
  assert.equal(db.prepare('SELECT status FROM job_import_drafts WHERE id=?').get(draftId).status, 'extracted');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM jobs').get().count, 0, 'extraction does not publish a job');
});

test('OCR failure leaves the private screenshot and draft unchanged', async (t) => {
  const extractor = createScreenshotExtractor({ nodeEnv: 'test', screenshotOcrUrl: 'https://api.ocr.space/parse/image', screenshotOcrApiKey: 'test-only' }, { fetchImpl: async () => { throw new Error('network down'); } });
  const { base, config, db } = await createImportApi(t, extractor);
  const { client, draftId, image } = await registerAndUpload(base);
  const filePath = path.join(config.jobImportStoragePath, db.prepare('SELECT storage_key FROM job_import_images WHERE id=?').get(image.id).storage_key);
  assert.equal(existsSync(filePath), true);
  const response = await client.call(`/employee/job-imports/${draftId}/extract`, { method: 'POST', body: { consentToExternalProcessing: true } });
  assert.equal(response.status, 502);
  const draft = await client.call(`/employee/job-imports/${draftId}`);
  assert.equal(draft.status, 200);
  assert.equal(draft.data.draft.status, 'uploaded');
  assert.equal(draft.data.draft.extracted.rawText, undefined);
  assert.equal(draft.data.draft.images.length, 1);
  assert.equal(existsSync(filePath), true);
});
