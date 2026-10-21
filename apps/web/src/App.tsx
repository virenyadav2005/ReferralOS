import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth';
import { Shell, Protected } from './components/Shell';
import { AboutPage, AdminDashboard, AuthPage, CandidateDashboard, CandidateInboxPage, CompaniesPage, CompanyDetailPage, ContactPage, EmployeeDashboard, EmployeeJobApplicantsPage, HomePage, JobDetailPage, JobsPage, LegalPage, NotificationsPage, ReferralRequestPage, WorkEmailVerificationPage } from './Pages';

function NotFound() {
  return <div className="page-wrap not-found"><span className="eyebrow">404 · LOST THE THREAD?</span><h1>This page isn’t here.</h1><p>The link may have changed or the listing may have expired.</p><a className="button button-primary" href="/jobs">Explore jobs</a></div>;
}

export default function App() {
  return <BrowserRouter><AuthProvider><Routes><Route element={<Shell/>}>
    <Route index element={<HomePage/>}/><Route path="jobs" element={<JobsPage/>}/><Route path="jobs/:jobId" element={<JobDetailPage/>}/><Route path="companies" element={<CompaniesPage/>}/><Route path="companies/:companyId" element={<CompanyDetailPage/>}/>
    <Route path="login" element={<AuthPage mode="login"/>}/><Route path="register" element={<AuthPage mode="register"/>}/>
    <Route path="verify-work-email" element={<WorkEmailVerificationPage/>}/>
    <Route path="referral-requests/:requestId" element={<ReferralRequestPage/>}/>
    <Route path="applications" element={<Protected role="candidate"><CandidateInboxPage/></Protected>}/>
    <Route path="notifications" element={<NotificationsPage/>}/>
    <Route path="about" element={<AboutPage/>}/><Route path="contact" element={<ContactPage/>}/><Route path="terms" element={<LegalPage kind="terms"/>}/><Route path="privacy" element={<LegalPage kind="privacy"/>}/>
    <Route path="dashboard" element={<Protected role="candidate"><CandidateDashboard/></Protected>}/>
    <Route path="employee" element={<Protected role="employee"><EmployeeDashboard/></Protected>}/>
    <Route path="employee/jobs/:jobId/applicants" element={<Protected role="employee"><EmployeeJobApplicantsPage/></Protected>}/>
    {/* Temporarily disabled while screenshot-based job import is being fixed.
    <Route path="employee/job-imports" element={<Protected role="employee"><ScreenshotImportPage/></Protected>}/>
    */}
    <Route path="admin" element={<Protected role="admin"><AdminDashboard/></Protected>}/>
    <Route path="*" element={<NotFound/>}/>
  </Route></Routes></AuthProvider></BrowserRouter>;
}
