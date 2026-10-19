export type ImportField = { value: string | string[] | null; confidence: number; sourceText: string | null; uncertain: boolean };
export type ImportAffiliation = { company_id: string; company_name: string; status: string };

export function populateImportForm<T extends Record<string, unknown>>(
  current: T,
  fields: Record<string, ImportField> | undefined,
  affiliations?: ImportAffiliation[],
): T;

export function hydrateImportForm<T extends Record<string, unknown>>(
  blank: T,
  draft: Record<string, unknown> | null | undefined,
  affiliations?: ImportAffiliation[],
): T;
