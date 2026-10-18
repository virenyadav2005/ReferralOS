export type Role = 'candidate' | 'employee' | 'admin';
export type User = {
  id: string; email: string; displayName: string; headline: string | null; location: string | null;
  bio: string | null; skills: string[]; roles: Role[]; resumeName?: string | null; resumeConsent?: boolean;
};
export type Company = { id: string; name: string; slug: string; websiteUrl: string | null; description: string | null; isDemo: boolean; openJobs: number };
export type Job = {
  id: string; companyId: string; title: string; description: string; location: string; locationType: 'remote' | 'hybrid' | 'onsite';
  experienceLevel: string; employmentType: string; skills: string[]; salaryRange: string | null; referralMethod: string; sourceType?:'employee'|'screenshot_import';
  referralMethodLabel: string; status: string; isDemo: boolean; expiresAt: string; createdAt: string; updatedAt: string;
  company: { name: string; slug: string; websiteUrl: string | null; isDemo: boolean }; postedBy: string; isSaved: boolean;
};
export type WorkflowStep = {
  id: string; stepNumber: number; title: string; instructions: string; responsible: 'candidate' | 'employee' | 'either';
  actionType: 'open_url' | 'apply_external' | 'request_referral' | 'complete_form' | 'send_email' | 'confirm_application' | 'wait' | 'custom';
  destinationUrl: string | null; destinationEmail: string | null; requiresApplicationId: boolean;
  completionMethod: 'manual_candidate' | 'manual_employee' | 'external_unverified' | 'not_required';
};
export type ReferralRequest = { id: string; status: string; created_at: string; updated_at: string; message: string | null; application_id: string | null; job_title: string; job_id: string; company_name: string; candidate_name?: string; resume_shared?: number; unread_message_count?:number };
