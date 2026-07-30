import { useState, useEffect, useCallback, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import OrdersDashboard from './OrdersDashboard.tsx';
import LoginScreen from './LoginScreen.tsx';
import SignupScreen from './SignupScreen.tsx';
import AdminDashboard from './AdminDashboard.tsx';
import SuperAdminDashboard from './SuperAdminDashboard.tsx';
import TranscriptScreen from './TranscriptScreen.tsx';
import type { TranscriptTurn } from './lib/types';
import './index.css';

// ── Auth helpers ──────────────────────────────────────────────────────────────

const TOKEN_KEY  = 'sf_auth_token';
const JWT_KEY    = 'sf_jwt';

interface JwtClaims { role: string; slug: string; tenantId: string; sub: string }

function decodeJwt(token: string): JwtClaims | null {
  try {
    const part    = token.split('.')[1];
    if (!part) return null;
    const pad     = (4 - part.length % 4) % 4;
    const decoded = JSON.parse(atob(part + '='.repeat(pad)));
    return { role: decoded.role ?? '', slug: decoded.slug ?? '', tenantId: decoded.tenantId ?? '', sub: decoded.sub ?? '' };
  } catch {
    return null;
  }
}

function isAdmin(role: string) {
  return role === 'tenant_admin' || role === 'super_admin';
}

// ── Screen type ───────────────────────────────────────────────────────────────

type Screen =
  | 'loading'
  | 'login'
  | 'signup'
  | 'kiosk'
  | 'dashboard'
  | 'transcripts'
  | 'admin'
  | 'super_admin'
  | 'impersonate';

// ── Root ──────────────────────────────────────────────────────────────────────

function Root() {
  const [screen,      setScreen]      = useState<Screen>('loading');
  const [jwtToken,    setJwtToken]    = useState<string>('');
  const [jwtClaims,   setJwtClaims]   = useState<JwtClaims | null>(null);
  // Transient state set after signup before onboarding saves to Redis
  const [pendingSlug, setPendingSlug] = useState('');
  const [pendingName, setPendingName] = useState('');
  // Impersonation state — set when super admin manages a tenant in-app
  const [impJwt,      setImpJwt]      = useState('');
  const [impSlug,     setImpSlug]     = useState('');
  const [impSubScreen, setImpSubScreen] = useState<'admin' | 'orders'>('admin');

  const [conversationLog, setConversationLog] = useState<TranscriptTurn[]>([]);

  // ── Session restore on load ───────────────────────────────────────────────

  useEffect(() => {
    // Handle the /admin-impersonate?token=...&slug=... URL that older super-admin
    // code opened in a new tab. Install the token and redirect into the impersonate
    // screen so the new tab works correctly.
    const params   = new URLSearchParams(window.location.search);
    const impToken = params.get('token');
    const impSlugParam = params.get('slug');
    if (window.location.pathname === '/admin-impersonate' && impToken) {
      window.history.replaceState({}, '', '/admin');
      sessionStorage.setItem(JWT_KEY,    impToken);
      sessionStorage.setItem(TOKEN_KEY,  impToken);
      const claims = decodeJwt(impToken);
      setJwtToken(impToken);
      setJwtClaims(claims);
      setImpJwt(impToken);
      setImpSlug(impSlugParam ?? claims?.slug ?? '');
      setImpSubScreen('admin');
      setScreen('impersonate');
      return;
    }

    const token = sessionStorage.getItem(TOKEN_KEY);
    const jwt   = sessionStorage.getItem(JWT_KEY);
    if (!token) { setScreen('login'); return; }

    fetch('/api/auth/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    })
      .then(r => {
        if (!r.ok) { setScreen('login'); return; }
        if (jwt) {
          const claims = decodeJwt(jwt);
          setJwtToken(jwt);
          setJwtClaims(claims);
          setScreen(claims?.role === 'super_admin' ? 'super_admin' : 'kiosk');
        } else {
          setScreen('kiosk');
        }
      })
      .catch(() => setScreen('login'));
  }, []);

  // ── Auth actions ─────────────────────────────────────────────────────────

  const handleLogin = (token: string, jwt?: string, role?: string, slug?: string) => {
    sessionStorage.setItem(TOKEN_KEY, token);
    let effectiveRole = role;
    if (jwt) {
      sessionStorage.setItem(JWT_KEY, jwt);
      const claims = decodeJwt(jwt);
      setJwtToken(jwt);
      setJwtClaims(claims ?? { role: role ?? '', slug: slug ?? '', tenantId: '', sub: '' });
      effectiveRole = claims?.role ?? role;
    }
    setScreen(effectiveRole === 'super_admin' ? 'super_admin' : 'kiosk');
  };

  const handleSignedUp = (jwt: string, slug: string) => {
    sessionStorage.setItem(JWT_KEY, jwt);
    const claims = decodeJwt(jwt);
    setJwtToken(jwt);
    setJwtClaims(claims);
    setPendingSlug(slug);
    setPendingName(claims?.sub ?? slug);
    setScreen('admin');
  };

  const handleLogout = () => {
    sessionStorage.clear();
    setJwtToken('');
    setJwtClaims(null);
    setConversationLog([]);
    setScreen('login');
  };

  // ── Impersonation ─────────────────────────────────────────────────────────
  // When the super admin clicks "Manage →" we install the tenant's JWT into
  // sessionStorage so every tenantFetch call in child components (AdminDashboard,
  // OrdersDashboard) picks up the right tenant automatically.
  const handleManageTenant = (jwt: string, slug: string) => {
    sessionStorage.setItem('sf_imp_backup_jwt',   sessionStorage.getItem('sf_jwt')        ?? '');
    sessionStorage.setItem('sf_imp_backup_token', sessionStorage.getItem('sf_auth_token') ?? '');
    sessionStorage.setItem('sf_jwt',        jwt);
    sessionStorage.setItem('sf_auth_token', jwt);
    setImpJwt(jwt);
    setImpSlug(slug);
    setImpSubScreen('admin');
    setScreen('impersonate');
  };

  const handleExitImpersonate = () => {
    const backupJwt   = sessionStorage.getItem('sf_imp_backup_jwt')   ?? '';
    const backupToken = sessionStorage.getItem('sf_imp_backup_token') ?? '';
    sessionStorage.setItem('sf_jwt',        backupJwt);
    sessionStorage.setItem('sf_auth_token', backupToken);
    sessionStorage.removeItem('sf_imp_backup_jwt');
    sessionStorage.removeItem('sf_imp_backup_token');
    setImpJwt('');
    setImpSlug('');
    setScreen('super_admin');
  };

  // ── URL sync ─────────────────────────────────────────────────────────────
  // Keep the browser URL aligned with the logged-in tenant's kiosk slug.
  // Without this, a stale URL like /kiosk/johnny-jugnu left from a previous
  // session would feed the wrong slug to App when the Savour admin logs in.
  useEffect(() => {
    if (screen === 'kiosk' && jwtClaims?.slug && jwtClaims.slug !== 'super') {
      const target = `/kiosk/${jwtClaims.slug}`;
      if (window.location.pathname !== target) {
        window.history.replaceState({}, '', target);
      }
    }
  }, [screen, jwtClaims?.slug]);

  // ── Transcript ────────────────────────────────────────────────────────────

  const handleTurnComplete = useCallback((turn: TranscriptTurn) => {
    setConversationLog(prev => [...prev, turn]);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (screen === 'loading') return null;

  if (screen === 'login') {
    return (
      <LoginScreen
        onLogin={handleLogin}
        onCreateAccount={() => setScreen('signup')}
      />
    );
  }

  if (screen === 'signup') {
    return (
      <SignupScreen
        onSignedUp={handleSignedUp}
        onBackToLogin={() => setScreen('login')}
      />
    );
  }

  if (screen === 'admin') {
    return (
      <AdminDashboard
        jwtToken={jwtToken}
        onLogout={handleLogout}
        onNavigateToKiosk={() => setScreen('kiosk')}
        onNavigateToDashboard={() => setScreen('dashboard')}
      />
    );
  }

  if (screen === 'super_admin') {
    return (
      <SuperAdminDashboard
        jwtToken={jwtToken}
        onLogout={handleLogout}
        onManageTenant={handleManageTenant}
      />
    );
  }

  if (screen === 'impersonate') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Impersonation banner */}
        <div className="shrink-0 flex items-center justify-between px-5 py-2.5 bg-amber-50 border-b-2 border-amber-300">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
            <span className="text-xs font-bold text-amber-800 uppercase tracking-widest">Impersonating</span>
            <span className="text-xs font-mono text-amber-700 bg-amber-100 px-2 py-0.5 rounded-lg border border-amber-200">
              {impSlug}
            </span>
            <span className="text-[10px] text-amber-600 opacity-70 hidden sm:block">
              Changes you make here affect this tenant's live configuration
            </span>
          </div>
          <button
            onClick={handleExitImpersonate}
            className="text-xs font-semibold text-amber-800 hover:text-amber-900 border border-amber-300 rounded-lg px-3 py-1.5 hover:bg-amber-100 transition cursor-pointer shrink-0"
          >
            ← Exit to Super Admin
          </button>
        </div>

        {/* Impersonated sub-screen */}
        <div className="flex-1 overflow-hidden">
          {impSubScreen === 'orders' ? (
            <OrdersDashboard
              onBack={() => setImpSubScreen('admin')}
              onLogout={handleExitImpersonate}
            />
          ) : (
            <AdminDashboard
              jwtToken={impJwt}
              onLogout={handleExitImpersonate}
              onNavigateToKiosk={() => window.open(`/kiosk/${impSlug}`, '_blank')}
              onNavigateToDashboard={() => setImpSubScreen('orders')}
            />
          )}
        </div>
      </div>
    );
  }

  if (screen === 'dashboard') {
    return (
      <OrdersDashboard
        onBack={() => setScreen('kiosk')}
        onLogout={handleLogout}
      />
    );
  }

  if (screen === 'transcripts') {
    return (
      <TranscriptScreen
        turns={conversationLog}
        onBack={() => setScreen('kiosk')}
      />
    );
  }

  // Default: kiosk
  const adminRole = jwtClaims ? isAdmin(jwtClaims.role) : false;
  // Pass slug so the kiosk loads the correct tenant config when accessed via the admin panel
  // (URL may still be "/" rather than "/kiosk/{slug}" during in-app navigation)
  return (
    <App
      tenantSlug={jwtClaims?.slug || undefined}
      onNavigateToDashboard={() => setScreen('dashboard')}
      onNavigateToTranscripts={() => setScreen('transcripts')}
      onNavigateToAdmin={adminRole ? () => setScreen('admin') : undefined}
      onLogout={handleLogout}
      onTurnComplete={handleTurnComplete}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
