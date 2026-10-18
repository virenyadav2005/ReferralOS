import { Link } from 'react-router-dom';
import type { Job } from '../types';

const levelLabel: Record<string,string> = { intern:'Internship', entry:'Entry level', mid:'Mid level', senior:'Senior', lead:'Lead', executive:'Executive' };
export function JobCard({ job, onBookmark, busy = false }: { job: Job; onBookmark?: (job: Job) => void; busy?: boolean }) {
  return <article className="job-card">
    <div className="job-card-top"><div className="company-avatar">{job.company.name.split(/\s+/).slice(0,2).map((part) => part[0]).join('').toUpperCase()}</div><div className="job-company"><Link to={`/companies/${job.companyId}`}><strong>{job.company.name}</strong></Link><span>{job.company.isDemo ? 'Sample company · demo data' : 'Employee-listed company'}</span></div>
      {onBookmark && <button className={`bookmark-button ${job.isSaved ? 'is-saved' : ''}`} aria-label={job.isSaved ? 'Remove saved job' : 'Save job'} title={job.isSaved ? 'Remove saved job' : 'Save job'} disabled={busy} onClick={() => onBookmark(job)}>{job.isSaved ? '♥' : '♡'}</button>}
    </div>
    <Link className="job-card-title" to={`/jobs/${job.id}`}>{job.title}</Link>
    <div className="job-meta"><span>⌖ {job.location}</span><span>◷ {levelLabel[job.experienceLevel] ?? job.experienceLevel}</span><span>▣ {job.locationType}</span></div>
    <p className="job-card-desc">{job.description.replace(/^DEMO DATA — fictional example listing\. /, '').slice(0,150)}{job.description.length>150?'…':''}</p>
    <div className="job-tags">{job.skills.slice(0,3).map((skill) => <span className="tag" key={skill}>{skill}</span>)}{job.isDemo && <span className="tag tag-demo">Demo listing</span>}{job.sourceType==='screenshot_import'&&<span className="tag">Screenshot source · employee reviewed</span>}</div>
    <div className="job-card-bottom"><span className="workflow-label"><span className="workflow-dot" />{job.referralMethodLabel}</span><span className="posted-date">{new Date(job.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</span></div>
  </article>;
}

export function JobCardSkeleton() { return <div className="job-card skeleton-card" aria-label="Loading listing"><span className="skeleton-line skeleton-short"/><span className="skeleton-line skeleton-title"/><span className="skeleton-line"/><span className="skeleton-line skeleton-medium"/></div>; }
