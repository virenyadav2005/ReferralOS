const headings = {
  skills: ['skills', 'key skills', 'skills required', 'technical skills', 'required skills', 'must have skills'],
  qualifications: ['qualifications', 'qualification', 'education', 'educational requirements', 'eligibility', 'requirements', 'what you bring'],
  description: ['job description', 'role overview', 'about the role', 'about the job', 'responsibilities', 'key responsibilities', 'what you will do'],
};

const stopHeadings = new Set([
  ...Object.values(headings).flat(), 'company', 'company name', 'employer', 'job title', 'title', 'role', 'position',
  'location', 'job location', 'work location', 'location type', 'work location type', 'experience', 'experience required', 'experience level', 'seniority',
  'employment type', 'job type', 'work type', 'work arrangement', 'work mode', 'job id', 'requisition id', 'req id',
  'salary', 'salary range', 'compensation', 'application deadline', 'apply by', 'last date to apply', 'deadline',
  'application url', 'official application url', 'application link', 'link to apply', 'apply online', 'apply here', 'apply link', 'apply before',
  'referral url', 'referral link', 'refer here', 'referral instructions', 'referral process', 'benefits', 'about company',
]);

const cleanLine = (value) => value.replace(/^\s*(?:[•●▪◦*-]|\d+[.)])\s*/, '').trim();
const normalize = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const field = (value, sourceText = null, uncertain = false) => ({
  value: value ?? null,
  // OCR.space supplies plain text rather than per-field confidence. Never
  // manufacture a confidence score from a successful regex match.
  confidence: 0,
  sourceText: sourceText || null,
  uncertain: value == null || uncertain,
});

function linesOf(text) {
  return text.split(/\r?\n/).map(cleanLine).filter(Boolean);
}

function findLabeled(lines, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
  const matcher = new RegExp(`^\\s*(?:${labelPattern})\\s*[:：–-]\\s*(.+?)\\s*$`, 'i');
  const matches = lines.flatMap((line) => {
    const match = line.match(matcher);
    return match ? [{ value: match[1].trim(), source: line }] : [];
  });
  if (!matches.length) return { value: null, sourceText: null, ambiguous: false };
  const unique = [...new Map(matches.map((match) => [normalize(match.value), match])).values()];
  if (unique.length !== 1) return { value: null, sourceText: matches.map((match) => match.source).join('\n'), ambiguous: true };
  return { value: unique[0].value, sourceText: unique[0].source, ambiguous: false };
}

function section(lines, names) {
  const normalizedNames = new Set(names.map(normalize));
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*([^:：]{2,70}?)(?:\s*[:：]\s*(.*))?\s*$/);
    if (!match || !normalizedNames.has(normalize(match[1]))) continue;
    const content = [];
    if (match[2]?.trim()) content.push(match[2].trim());
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      const nextHeading = next.match(/^\s*([^:：]{2,70}?)(?:\s*[:：]\s*.*)?\s*$/);
      if (nextHeading && stopHeadings.has(normalize(nextHeading[1]))) break;
      content.push(next);
    }
    const value = content.join('\n').trim();
    if (value) found.push({ value, sourceText: `${line}\n${content.join('\n')}` });
  }
  if (!found.length) return { value: null, sourceText: null, ambiguous: false };
  const unique = [...new Map(found.map((item) => [normalize(item.value), item])).values()];
  if (unique.length !== 1) return { value: null, sourceText: found.map((item) => item.sourceText).join('\n---\n'), ambiguous: true };
  return { ...unique[0], ambiguous: false };
}

function parseExperienceLevel(value) {
  const text = normalize(value);
  const choices = [
    ['intern', /\b(intern|internship)\b/],
    ['entry', /\b(entry|junior|fresher|graduate)\b/],
    ['mid', /\b(mid(?:[- ]level)?|intermediate)\b/],
    ['senior', /\b(senior|sr\.?|experienced)\b/],
    ['lead', /\b(lead|principal|staff)\b/],
    ['executive', /\b(executive|director|vp|vice president|chief)\b/],
  ];
  const matches = choices.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : null;
}

function parseEmploymentType(value) {
  const text = normalize(value);
  const choices = [
    ['internship', /\b(internship|intern)\b/],
    ['part_time', /\b(part[ -]?time|part time)\b/],
    ['contract', /\b(contract|contractual|freelance|fixed[ -]?term)\b/],
    ['full_time', /\b(full[ -]?time|permanent)\b/],
  ];
  const matches = choices.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : null;
}

function parseArrangement(value) {
  const text = normalize(value);
  const choices = [
    ['remote', /\b(remote|work from home|wfh|home based)\b/],
    ['hybrid', /\b(hybrid)\b/],
    ['onsite', /\b(on[ -]?site|office based|work from office|wfo)\b/],
  ];
  const matches = choices.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : null;
}

function parseDeadline(value) {
  const source = value.trim();
  let year; let month; let day;
  let match = source.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) [, year, month, day] = match;
  if (!match) {
    // Indian job posts commonly use DD/MM/YYYY or DD-MM-YYYY.
    match = source.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
    if (match) [, day, month, year] = match;
  }
  if (!match) {
    match = source.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})[,]?\s+(20\d{2})\b/i);
    if (match) {
      [, day, month, year] = match;
      month = String(new Date(`${month} 1, 2000`).getMonth() + 1);
      if (month === 'NaN') return null;
    }
  }
  if (!match) {
    match = source.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i);
    if (match) {
      [, month, day, year] = match;
      month = String(new Date(`${month} 1, 2000`).getMonth() + 1);
      if (month === 'NaN') return null;
    }
  }
  if (!match) return null;
  const y = Number(year); const m = Number(month); const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function urlFrom(labelled) {
  if (!labelled.value) return null;
  return labelled.value.match(/https?:\/\/[^\s<>()]+/i)?.[0]?.replace(/[.,;]+$/, '') ?? null;
}

function skillList(value) {
  return [...new Set(value.split(/[,;|\n]+/).map((item) => item.trim().replace(/^[-•*\s]+/, '').replace(/[.]+$/, '')).filter(Boolean))].slice(0, 20);
}

/** Extract only values supported by explicit labels/sections in OCR text. */
export function parseJobPostingText(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim().slice(0, 8000) : '';
  const lines = linesOf(text);
  const company = findLabeled(lines, ['company', 'company name', 'employer']);
  const title = findLabeled(lines, ['job title', 'position title', 'role title', 'designation', 'position', 'role']);
  const location = findLabeled(lines, ['job location', 'work location', 'location', 'job locations']);
  const experience = findLabeled(lines, ['experience required', 'required experience', 'experience', 'years of experience']);
  const experienceLevel = findLabeled(lines, ['experience level', 'seniority', 'career level']);
  const employment = findLabeled(lines, ['employment type', 'job type', 'employment']);
  const arrangement = findLabeled(lines, ['work arrangement', 'work mode', 'work location type', 'location type']);
  const skills = section(lines, headings.skills);
  const qualifications = section(lines, headings.qualifications);
  const description = section(lines, headings.description);
  const requisition = findLabeled(lines, ['requisition id', 'requisition', 'job id', 'job code', 'req id', 'ref id']);
  const salary = findLabeled(lines, ['salary range', 'salary', 'compensation', 'ctc']);
  const deadline = findLabeled(lines, ['application deadline', 'last date to apply', 'apply before', 'apply by', 'closing date', 'deadline']);
  const applicationUrl = findLabeled(lines, ['official application url', 'application url', 'application link', 'link to apply', 'apply online', 'apply link', 'apply here']);
  const referralUrl = findLabeled(lines, ['referral url', 'referral link', 'refer here']);
  const referralInstructions = section(lines, ['referral instructions', 'how to apply through referral', 'referral process']);
  const make = (result, value = result.value) => field(result.ambiguous ? null : value, result.sourceText, result.ambiguous);

  let deadlineValue = null;
  if (deadline.value) {
    deadlineValue = parseDeadline(deadline.value);
  }
  let rawSkills = skills.value ? skillList(skills.value) : [];
  if (!rawSkills.length && skills.value) rawSkills = [];
  const appUrl = urlFrom(applicationUrl);
  const refUrl = urlFrom(referralUrl);
  const desc = description.value?.slice(0, 8000) ?? null;
  const qual = qualifications.value?.slice(0, 4000) ?? null;
  const skillValue = rawSkills.length ? rawSkills : null;
  const locationMode = location.value ? parseArrangement(location.value) : null;
  const arrangementValue = arrangement.value ? parseArrangement(arrangement.value) : locationMode;
  const arrangementEvidence = arrangement.value ? arrangement : locationMode ? location : arrangement;
  const employmentValue = employment.value ? parseEmploymentType(employment.value) : null;
  const levelValue = experienceLevel.value ? parseExperienceLevel(experienceLevel.value) : null;

  return {
    rawText: text,
    fields: {
      companyName: make(company),
      title: make(title),
      location: make(location),
      experience: make(experience),
      experienceLevel: make(experienceLevel, levelValue),
      employmentType: make(employment, employmentValue),
      workArrangement: make(arrangementEvidence, arrangementValue),
      skills: make(skills, skillValue),
      qualifications: make(qualifications, qual),
      description: make(description, desc),
      requisitionId: make(requisition),
      salaryRange: make(salary),
      applicationUrl: make(applicationUrl, appUrl),
      referralUrl: make(referralUrl, refUrl),
      referralInstructions: make(referralInstructions, referralInstructions.value?.slice(0, 4000) ?? null),
      deadline: make(deadline, deadlineValue),
    },
  };
}
