import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, jsonBody } from './api';
import type { User } from './types';

type AuthContextValue = { user: User | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void>; setUser: (user: User | null) => void };
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { const result = await api<{ user: User }>('/auth/me'); setUser(result.user); }
    catch { setUser(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const signOut = useCallback(async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); }, []);
  const value = useMemo(() => ({ user, loading, refresh, signOut, setUser }), [user, loading, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export async function signIn(email: string, password: string) {
  return api<{ user: User }>('/auth/login', { method: 'POST', body: jsonBody({ email, password }) });
}

export async function signUp(payload: { email: string; password: string; displayName: string; roles: ('candidate'|'employee')[]; companyName?: string; jobTitle?: string; workEmail?: string }) {
  return api<{ user: User; emailVerification?: { status:string; message?:string } }>('/auth/register', { method: 'POST', body: jsonBody(payload) });
}
