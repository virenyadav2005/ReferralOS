import { z } from 'zod';

const safeUrl = z.string().trim().url().refine((value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}, 'Use a valid http or https URL.');

export const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(80),
  roles: z.array(z.enum(['candidate', 'employee'])).min(1).max(2).default(['candidate']),
  companyName: z.string().trim().min(2).max(120).optional(),
  jobTitle: z.string().trim().max(120).optional(),
  workEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
}).superRefine((data, ctx) => {
  if (data.roles.includes('employee') && !data.companyName) {
    ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Company is required for employee registration.' });
  }
});

export const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) });

export const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  headline: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(1200).optional(),
  skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
});

const stepSchema = z.object({
  stepNumber: z.number().int().min(1).max(30),
  title: z.string().trim().min(2).max(120),
  instructions: z.string().trim().min(4).max(2000),
  responsible: z.enum(['candidate', 'employee', 'either']),
  actionType: z.enum(['open_url', 'apply_external', 'request_referral', 'complete_form', 'send_email', 'confirm_application', 'wait', 'custom']),
  destinationUrl: safeUrl.optional().or(z.literal('')),
  destinationEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  requiresApplicationId: z.boolean().default(false),
  completionMethod: z.enum(['manual_candidate', 'manual_employee', 'external_unverified', 'not_required']),
});

export const jobSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().min(20).max(8000),
  location: z.string().trim().min(2).max(120),
  locationType: z.enum(['remote', 'hybrid', 'onsite']),
  experienceLevel: z.enum(['intern', 'entry', 'mid', 'senior', 'lead', 'executive']),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'internship']).default('full_time'),
  skills: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  salaryRange: z.string().trim().max(100).optional().or(z.literal('')),
  sourceUrl: safeUrl.optional().or(z.literal('')),
  workflowTemplate: z.enum(['direct_referral_link', 'apply_first', 'request_employee', 'referral_form', 'email_instructions', 'custom']),
  expiresAt: z.string().datetime({ offset: true }),
  steps: z.array(stepSchema).min(1).max(30),
}).superRefine((data, ctx) => {
  if (data.steps.some((step) => step.destinationUrl && !step.destinationUrl.startsWith('http'))) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Workflow destinations must be external http or https URLs.' });
  }
  const numbers = data.steps.map((step) => step.stepNumber);
  if (new Set(numbers).size !== numbers.length || numbers.some((n, i) => n !== i + 1)) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Steps must be uniquely numbered in order starting at 1.' });
  }
  for (const [index, step] of data.steps.entries()) {
    if (['open_url','apply_external','complete_form'].includes(step.actionType) && !step.destinationUrl) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'destinationUrl'], message: 'This action requires a destination URL.' });
    }
    if (step.actionType === 'send_email' && !step.destinationEmail) {
      ctx.addIssue({ code: 'custom', path: ['steps', index, 'destinationEmail'], message: 'An email action requires a valid contact address.' });
    }
  }
  if (data.workflowTemplate === 'request_employee' && !data.steps.some((step) => step.actionType === 'request_referral')) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'The employee request workflow needs a referral request step.' });
  }
  if (Date.parse(data.expiresAt) <= Date.now()) ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiration must be in the future.' });
});

export const referralSchema = z.object({
  message: z.string().trim().max(1200).optional(), applicationId: z.string().trim().max(120).optional(),
  resumeConsent: z.preprocess((value) => value === true || value === 'true', z.boolean()).optional(),
  useSavedResume: z.preprocess((value) => value === true || value === 'true', z.boolean()).optional(),
});
export const completionSchema = z.object({ applicationId: z.string().trim().max(120).optional(), note: z.string().trim().max(1200).optional() });
export const workflowStepReviewSchema = z.object({
  action: z.enum(['approve', 'request_information', 'return_for_changes']),
  response: z.string().trim().min(4).max(1200),
});
export const statusSchema = z.object({ status: z.enum(['accepted','declined','candidate_action_needed','employee_action_needed','referral_confirmed','candidate_reported_applied','withdrawn','closed']), note: z.string().trim().max(1200).optional(), confirmEmployerSubmission: z.boolean().optional() }).superRefine((value, ctx) => {
  if (value.status === 'referral_confirmed' && (!value.confirmEmployerSubmission || !value.note?.trim())) {
    ctx.addIssue({ code: 'custom', path: ['confirmEmployerSubmission'], message: 'Confirm that you completed the referral through an authorized employer process and add a note.' });
  }
  if (value.status === 'closed' && !value.note?.trim()) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Give a reason when closing a referral request.' });
});
export const reportSchema = z.object({ reason: z.enum(['expired','misleading','duplicate','inappropriate','other']), details: z.string().trim().max(1200).optional() });
export const verificationReviewSchema = z.object({ status: z.enum(['approved','rejected']), reviewNote: z.string().trim().max(1200).optional() });
export const reportReviewSchema = z.object({ status: z.enum(['reviewing','resolved','dismissed']), removeJob: z.boolean().default(false) });
export const resumeConsentSchema = z.object({ consent: z.boolean() });
export const workEmailTokenSchema = z.object({ token: z.string().min(32).max(200) });
export const workEmailSchema = z.object({ workEmail: z.string().trim().email().max(254) });
export const requestMessageSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine((value) => {
    const url=new URL(value);const host=url.hostname.toLowerCase();
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
      (host==='fcm.googleapis.com'||host==='web.push.apple.com'||host==='push.services.mozilla.com'||host.endsWith('.push.services.mozilla.com'));
  }, 'Push endpoint must use HTTPS and a supported browser push service.'),
  keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(16).max(100) }),
});
export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2048) });
export const jobImportDraftSchema = z.object({
  draft:z.object({companyId:z.string().uuid().or(z.literal('')).optional(),companyName:z.string().trim().max(140).optional(),title:z.string().trim().max(140).optional(),description:z.string().trim().max(8000).optional(),location:z.string().trim().max(120).optional(),locationType:z.enum(['remote','hybrid','onsite']).or(z.literal('')).optional(),experienceLevel:z.enum(['intern','entry','mid','senior','lead','executive']).or(z.literal('')).optional(),experience:z.string().trim().max(120).optional(),employmentType:z.enum(['full_time','part_time','contract','internship']).or(z.literal('')).optional(),skills:z.array(z.string().trim().min(1).max(40)).max(20).optional(),salaryRange:z.string().trim().max(100).optional(),sourceUrl:z.string().trim().max(2000).optional(),applicationUrl:z.string().trim().max(2000).optional(),referralUrl:z.string().trim().max(2000).optional(),workflowTemplate:z.enum(['direct_referral_link','apply_first','request_employee','referral_form','email_instructions','custom']).or(z.literal('')).optional(),expiresAt:z.string().datetime({offset:true}).or(z.literal('')).optional(),steps:z.array(stepSchema).max(30).optional(),requisitionId:z.string().trim().max(120).optional(),qualifications:z.string().trim().max(4000).optional(),referralInstructions:z.string().trim().max(4000).optional(),deadline:z.string().trim().max(100).optional()}).strict(),
  reviewConfirmed:z.boolean().optional(),externalProcessingConsent:z.boolean().optional(),imageOrder:z.array(z.string().uuid()).max(5).optional(),
}).superRefine((value,ctx)=>{if(value.reviewConfirmed){const result=jobSchema.safeParse(value.draft);if(!result.success)for(const issue of result.error.issues)ctx.addIssue({code:'custom',path:['draft',...issue.path],message:issue.message});}});
export const jobImportExtractSchema=z.object({consentToExternalProcessing:z.literal(true)});
export const jobImportPublishSchema=z.object({confirmReviewed:z.literal(true)});
export const jobImportImageOrderSchema=z.object({imageIds:z.array(z.string().uuid()).min(1).max(5)});
export const jobStatusSchema = z.object({ status: z.enum(['published','paused','closed']), note:z.string().trim().max(1200).optional() }).superRefine((value,ctx)=>{
  if(value.status==='closed'&&!value.note?.trim())ctx.addIssue({code:'custom',path:['note'],message:'Give a reason when closing a job listing.'});
});
export const contactSchema = z.object({ name:z.string().trim().min(2).max(100),email:z.string().trim().email().max(254),topic:z.string().trim().min(2).max(120),body:z.string().trim().min(20).max(4000) });
export const contactReviewSchema = z.object({ status:z.enum(['open','resolved']) });

export function parseBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: 'Please review the highlighted information.', details: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) });
    req.validatedBody = result.data;
    next();
  };
}
