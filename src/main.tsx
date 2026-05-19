import { useState, useEffect, useCallback, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import OrdersDashboard from './OrdersDashboard.tsx';
import LoginScreen from './LoginScreen.tsx';
import SignupScreen from './SignupScreen.tsx';
import OnboardingWizard from './OnboardingWizard.tsx';
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
  | 'onboarding'
  | 'kiosk'
  | 'dashboard'
  | 'transcripts'
  | 'admin'
  | 'super_admin';

// ── Root ──────────────────────────────────────────────────────────────────────

function Root() {
  const [screen,      setScreen]      = useState<Screen>('loading');
  const [jwtToken,    setJwtToken]    = useState<string>('');
  const [jwtClaims,   setJwtClaims]   = useState<JwtClaims | null>(null);
  // Transient state set after signup before onboarding saves to Redis
  const [pendingSlug, setPendingSlug] = useState('');
  const [pendingName, setPendingName] = useState('');

  const [conversationLog, setConversationLog] = useState<TranscriptTurn[]>([]);

  // ── Session restore on load ───────────────────────────────────────────────

  useEffect(() => {
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
    setPendingName(claims?.sub ?? slug);   // sub is the email; name is set properly in onboarding
    setScreen('onboarding');
  };

  const handleOnboardingComplete = (kioskUrl: string) => {
    // kioskUrl is e.g. "/kiosk/my-restaurant" — push slug into claims
    const slug = kioskUrl.replace('/kiosk/', '');
    setJwtClaims(prev => prev ? { ...prev, slug } : prev);
    setScreen('admin');
  };

  const handleLogout = () => {
    sessionStorage.clear();
    setJwtToken('');
    setJwtClaims(null);
    setConversationLog([]);
    setScreen('login');
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

  if (screen === 'onboarding') {
    return (
      <OnboardingWizard
        jwtToken={jwtToken}
        initialSlug={pendingSlug}
        initialName={pendingName || pendingSlug}
        onComplete={handleOnboardingComplete}
        onLogout={handleLogout}
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
      />
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
