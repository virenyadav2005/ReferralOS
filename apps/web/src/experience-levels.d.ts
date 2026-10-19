export type ExperienceLevelValue = 'intern' | 'entry' | 'mid' | 'senior' | 'lead' | 'executive';
export const experienceLevelOptions: ReadonlyArray<{ value: ExperienceLevelValue; label: string }>;
export function formatExperienceLevel(value: string): string;
