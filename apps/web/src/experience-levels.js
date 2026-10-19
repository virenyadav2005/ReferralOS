export const experienceLevelOptions = [
  { value: 'intern', label: 'Intern' },
  { value: 'entry', label: 'Entry Level (0–2 years)' },
  { value: 'mid', label: 'Mid Level (2–5 years)' },
  { value: 'senior', label: 'Senior Level (5–8 years)' },
  { value: 'lead', label: 'Lead / Expert (8+ years)' },
  { value: 'executive', label: 'Executive' },
];

export function formatExperienceLevel(value) {
  return experienceLevelOptions.find((option) => option.value === value)?.label ?? value;
}
