const read = (fields, name) => fields?.[name]?.value ?? null;
const normalized = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const dateInputValue = (value) => {
  if (typeof value !== 'string') return '';
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? '';
};

/** Fill only empty review controls; the employee's existing edits always win. */
export function populateImportForm(current, fields, affiliations = []) {
  const next = { ...current };
  const setIfEmpty = (key, value) => {
    if ((next[key] === '' || next[key] == null || (Array.isArray(next[key]) && next[key].length === 0)) && value != null && value !== '') next[key] = value;
  };
  const companyName = read(fields, 'companyName');
  setIfEmpty('companyName', companyName);
  if (!next.companyId && companyName) {
    const matches = affiliations.filter((item) => normalized(item.company_name) === normalized(companyName) && !['rejected', 'revoked'].includes(item.status));
    if (matches.length === 1) next.companyId = matches[0].company_id;
  }
  setIfEmpty('title', read(fields, 'title'));
  setIfEmpty('description', read(fields, 'description'));
  setIfEmpty('location', read(fields, 'location'));
  setIfEmpty('experience', read(fields, 'experience'));
  setIfEmpty('experienceLevel', read(fields, 'experienceLevel'));
  setIfEmpty('employmentType', read(fields, 'employmentType'));
  setIfEmpty('locationType', read(fields, 'workArrangement'));
  const skills = read(fields, 'skills');
  const skillList = Array.isArray(skills) ? skills : typeof skills === 'string' ? skills.split(/[,;|\n]+/).map((item) => item.trim()).filter(Boolean) : null;
  setIfEmpty('skills', skillList);
  setIfEmpty('qualifications', read(fields, 'qualifications'));
  setIfEmpty('salaryRange', read(fields, 'salaryRange'));
  setIfEmpty('requisitionId', read(fields, 'requisitionId'));
  setIfEmpty('sourceUrl', read(fields, 'applicationUrl'));
  setIfEmpty('referralUrl', read(fields, 'referralUrl'));
  setIfEmpty('referralInstructions', read(fields, 'referralInstructions'));
  setIfEmpty('expiresAt', dateInputValue(read(fields, 'deadline')));
  return next;
}

/** Hydrate a saved private draft into the date and list controls used by React. */
export function hydrateImportForm(blank, draft, affiliations = []) {
  const saved = draft && typeof draft === 'object' ? draft : {};
  const hydrated = { ...blank, ...saved };
  hydrated.skills = Array.isArray(saved.skills) ? saved.skills : typeof saved.skills === 'string' ? saved.skills.split(/[,;|\n]+/).map((item) => item.trim()).filter(Boolean) : [];
  hydrated.expiresAt = dateInputValue(saved.expiresAt ?? saved.deadline);
  if (!hydrated.companyName && hydrated.companyId) {
    hydrated.companyName = affiliations.find((item) => item.company_id === hydrated.companyId)?.company_name ?? '';
  }
  return hydrated;
}
