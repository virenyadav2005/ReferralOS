const knownLabels = {
  companyId: 'Company',
  title: 'Job title',
  description: 'About the role',
  location: 'Location',
  locationType: 'Work arrangement',
  experienceLevel: 'Experience level',
  expiresAt: 'Expiration date',
  workflowTemplate: 'Referral workflow',
  steps: 'Referral workflow steps',
};

export function jobValidationKey(field) {
  const stepMatch = /^steps\.(\d+)\.(.+)$/.exec(field ?? '');
  return stepMatch ? `step-${stepMatch[1]}-${stepMatch[2]}` : field;
}

export function formatJobValidationErrors(details = []) {
  const errors = {};
  for (const detail of details) {
    if (!detail || typeof detail.field !== 'string' || typeof detail.message !== 'string') continue;
    const key = jobValidationKey(detail.field);
    if (key && !errors[key]) errors[key] = detail.message;
  }
  return errors;
}

export function jobValidationLabel(field) {
  const stepMatch = /^step-(\d+)-(.+)$/.exec(field ?? '');
  if (stepMatch) {
    const part = stepMatch[2].replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
    return `Step ${Number(stepMatch[1]) + 1} ${part}`;
  }
  return knownLabels[field] ?? field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}
