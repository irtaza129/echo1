import { useState } from 'react';

interface LoginResponse {
  token?:    string;
  jwtToken?: string;
  role?:     string;
  slug?:     string;
  error?:    string;
}

interface Props {
  onLogin:         (token: string, jwtToken?: string, role?: string, slug?: string) => void;
  onCreateAccount: () => void;
}

export default function LoginScreen({ onLogin, onCreateAccount }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // Support both legacy username and email-based login
        body: JSON.stringify({ username, email: username, password }),
      });
      const body = await r.json() as LoginResponse;
      if (!r.ok) {
        setError(body.error || 'Invalid credentials');
        return;
      }
      if (body.jwtToken) sessionStorage.setItem('sf_jwt', body.jwtToken);
      onLogin(body.token!, body.jwtToken, body.role, body.slug);
    } catch {
      setError('Connection error — please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-[#F8F7F2]">
      <div className="w-full max-w-sm px-6">

        {/* Branding */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-serif font-bold text-[#5A5A40]">Voice Kiosk</h1>
          <p className="text-[10px] tracking-widest uppercase opacity-40 mt-1.5">
            Staff Portal
          </p>
        </div>

        {/* Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-white/60 backdrop-blur-sm border border-white/80 rounded-2xl shadow-sm p-8 flex flex-col gap-5"
        >
          <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold -mb-1">
            Sign In
          </p>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="sf-username"
              className="text-[11px] uppercase tracking-widest opacity-50 font-semibold"
            >
              Username or Email
            </label>
            <input
              id="sf-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              placeholder="Enter username or email"
              className="w-full bg-white/80 border border-[#5A5A40]/15 rounded-xl px-4 py-3 text-sm text-[#3D3D33] placeholder:opacity-30 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/25 transition"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="sf-password"
              className="text-[11px] uppercase tracking-widest opacity-50 font-semibold"
            >
              Password
            </label>
            <input
              id="sf-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="Enter password"
              className="w-full bg-white/80 border border-[#5A5A40]/15 rounded-xl px-4 py-3 text-sm text-[#3D3D33] placeholder:opacity-30 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/25 transition"
            />
          </div>

          {error && (
            <p className="text-xs text-red-600 text-center -mt-1">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-1 py-3 bg-[#5A5A40] text-[#F8F7F2] rounded-xl font-bold uppercase tracking-widest text-xs hover:bg-[#4a4a33] active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>

          <p className="text-center text-xs opacity-50">
            Don't have an account?{' '}
            <button
              type="button"
              onClick={onCreateAccount}
              className="underline cursor-pointer hover:opacity-80"
            >
              Create one
            </button>
          </p>
        </form>

      </div>
    </div>
  );
}
