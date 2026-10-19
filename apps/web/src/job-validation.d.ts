export type JobValidationDetail = { field: string; message: string };
export function jobValidationKey(field: string): string;
export function formatJobValidationErrors(details?: JobValidationDetail[]): Record<string, string>;
export function jobValidationLabel(field: string): string;
