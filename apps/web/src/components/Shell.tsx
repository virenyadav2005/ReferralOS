import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { api } from '../api';

export function Shell() {
  const { user, loading, demoMode, signOut } = useAuth();
  const navigate = useNavigate();
  const location=useLocation();const [unread,setUnread]=useState(0);
  useEffect(()=>{if(!user){setUnread(0);return;}let active=true;const refresh=()=>{void api<{unread:number}>('/notifications/unread-count').then((r)=>{if(active)setUnread(r.unread);}).catch(()=>{});};refresh();const timer=window.setInterval(refresh,30000);window.addEventListener('referralos:notifications-updated',refresh);return()=>{active=false;window.clearInterval(timer);window.removeEventListener('referralos:notifications-updated',refresh);};},[user?.id,location.pathname]);
  const logOut = async () => { try { await signOut(); navigate('/'); } catch { /* keep the current page; a refresh can retry */ } };
  return <div className="app-frame">
    <header className="topbar">
      <div className="topbar-inner">
        <Link className="brand" to="/" aria-label="ReferralOS home"><span className="brand-mark">R</span><span>Referral<span className="brand-light">OS</span></span></Link>
        <nav className="main-nav" aria-label="Main navigation">
          <NavLink to="/jobs">Explore jobs</NavLink><NavLink to="/companies">Companies</NavLink>
          {user&&(user.roles.includes('candidate')||user.roles.includes('employee')) && <NavLink to="/dashboard">My dashboard</NavLink>}
          {user?.roles.includes('employee') && <NavLink to="/employee">For referrers</NavLink>}
          {user?.roles.includes('admin') && <NavLink to="/admin">Admin</NavLink>}
          {user&&<NavLink className="notification-nav" to="/notifications" aria-label={unread>0?`Notifications, ${unread} unread`:'Notifications'}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg><span className="notification-nav-label">Notifications</span>{unread>0&&<span className="notification-count" aria-label={`${unread} unread`}>{unread>99?'99+':unread}</span>}</NavLink>}
        </nav>
        <div className="topbar-actions">
          {loading ? <span className="nav-skeleton" /> : user ? <><span className="user-chip"><span className="avatar">{user.displayName.slice(0,1).toUpperCase()}</span><span className="user-chip-name">{user.displayName}</span></span><button className="button button-quiet button-small" onClick={() => void logOut()}>Sign out</button></> : <><Link className="button button-quiet button-small hide-mobile" to="/login">Sign in</Link><Link className="button button-primary button-small" to="/register">Join ReferralOS</Link></>}
        </div>
      </div>
    </header>
    {demoMode&&<div className="demo-banner pilot-banner" role="status"><span>READ-ONLY PILOT</span><p>Sample listings are fictional. Applications, referrals, uploads, and account changes are disabled.</p></div>}
    <main><Outlet /></main>
    <footer className="footer"><div className="footer-inner"><Link className="brand footer-brand" to="/"><span className="brand-mark">R</span><span>Referral<span className="brand-light">OS</span></span></Link><span>One Platform. Every Referral Path.</span><nav className="footer-links" aria-label="Footer"><Link to="/about">About</Link><Link to="/contact">Contact</Link><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link></nav><span className="footer-note">Independent platform · Employee-provided instructions · No employer submissions through ReferralOS.</span></div></footer>
  </div>;
}

export function Protected({ role, children }: { role: 'candidate'|'employee'|'admin'; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-wrap"><div className="loading-card"><span className="spinner" />Loading your account…</div></div>;
  if (!user) return <div className="page-wrap"><div className="notice-card"><h2>Sign in to continue</h2><p>This area is available to your ReferralOS account.</p><Link className="button button-primary" to="/login">Sign in</Link></div></div>;
  if (!(role==='candidate'?(user.roles.includes('candidate')||user.roles.includes('employee')):user.roles.includes(role))) return <div className="page-wrap"><div className="notice-card"><h2>This area isn’t available for this account</h2><p>Your account does not have the {role} role.</p><Link to="/jobs" className="button button-secondary">Explore jobs</Link></div></div>;
  return children;
}
