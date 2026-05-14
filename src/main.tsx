import { useState, useEffect, useCallback, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import OrdersDashboard from './OrdersDashboard.tsx';
import LoginScreen from './LoginScreen.tsx';
import TranscriptScreen from './TranscriptScreen.tsx';
import type { TranscriptTurn } from './lib/types';
import './index.css';

type Screen = 'loading' | 'login' | 'kiosk' | 'dashboard' | 'transcripts';

const TOKEN_KEY = 'sf_auth_token';

function Root() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [conversationLog, setConversationLog] = useState<TranscriptTurn[]>([]);

  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      setScreen('login');
      return;
    }
    // Verify the stored token is still valid (not expired / not tampered)
    fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(r => setScreen(r.ok ? 'kiosk' : 'login'))
      .catch(() => setScreen('login'));
  }, []);

  const handleLogin = (token: string) => {
    sessionStorage.setItem(TOKEN_KEY, token);
    setScreen('kiosk');
  };

  const handleTurnComplete = useCallback((turn: TranscriptTurn) => {
    setConversationLog(prev => [...prev, turn]);
  }, []);

  if (screen === 'loading') {
    // Brief validation check — render nothing to avoid flash
    return null;
  }
  if (screen === 'login') {
    return <LoginScreen onLogin={handleLogin} />;
  }
  if (screen === 'dashboard') {
    return <OrdersDashboard onBack={() => setScreen('kiosk')} />;
  }
  if (screen === 'transcripts') {
    return <TranscriptScreen turns={conversationLog} onBack={() => setScreen('kiosk')} />;
  }
  return (
    <App
      onNavigateToDashboard={() => setScreen('dashboard')}
      onNavigateToTranscripts={() => setScreen('transcripts')}
      onTurnComplete={handleTurnComplete}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
