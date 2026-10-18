import type { WorkflowStep } from '../types';

const actionLabels: Record<WorkflowStep['actionType'],string> = {
  open_url:'Open employee-provided link', apply_external:'Apply on external careers site', request_referral:'Request an employee referral',
  complete_form:'Complete external form', send_email:'Send an email', confirm_application:'Record your application details', wait:'Wait for a response', custom:'Follow this instruction',
};

export function WorkflowSteps({ steps, completed = [], onComplete, disableActions = false }: { steps: WorkflowStep[]; completed?: string[]; onComplete?: (step: WorkflowStep) => void; disableActions?: boolean }) {
  return <div className="workflow-steps">{steps.map((step) => {
    const done = completed.includes(step.id);
    const mail = step.destinationEmail ? `mailto:${step.destinationEmail}` : null;
    const link = step.destinationUrl;
    return <article className={`workflow-step ${done?'step-done':''}`} key={step.id}>
      <div className="step-number">{done ? '✓' : String(step.stepNumber).padStart(2,'0')}</div>
      <div className="step-content"><div className="step-heading"><h3>{step.title}</h3><span className="step-owner">{step.responsible==='either'?'Candidate or employee':`${step.responsible[0].toUpperCase()}${step.responsible.slice(1)} action`}</span></div>
        <p>{step.instructions}</p><span className="step-action-type">{actionLabels[step.actionType]}</span>
        {!disableActions && link && <a className="button button-outline button-small step-link" href={link} target="_blank" rel="noopener noreferrer">Open employee-provided destination <span aria-hidden="true">↗</span></a>}
        {!disableActions && mail && <a className="button button-outline button-small step-link" href={mail}>Email {step.destinationEmail} <span aria-hidden="true">↗</span></a>}
        {step.requiresApplicationId && <div className="step-hint">Keep your application ID for your own records.</div>}
        {step.completionMethod==='external_unverified' && <div className="step-hint">Opening a link or sending email does not confirm completion. You may record your own progress below.</div>}
        {!disableActions && onComplete && !done && step.actionType!=='request_referral' && step.completionMethod!=='not_required' && <button className="text-button step-complete" onClick={() => onComplete(step)}>I’ve completed this step</button>}
        {done && <span className="step-recorded">Your progress is recorded. External completion is not verified.</span>}
      </div>
    </article>;
  })}</div>;
}
