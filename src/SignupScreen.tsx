import { useState } from 'react';

interface Props {
  onSignedUp: (jwtToken: string, slug: string) => void;
  onBackToLogin: () => void;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function SignupScreen({ onSignedUp, onBackToLogin }: Props) {
  const [email,          setEmail]          = useState('');
  const [password,       setPassword]       = useState('');
  const [restaurantName, setRestaurantName] = useState('');
  const [slug,           setSlug]           = useState('');
  const [slugTouched,    setSlugTouched]    = useState(false);
  const [error,          setError]          = useState('');
  const [loading,        setLoading]        = useState(false);

  const handleNameChange = (v: string) => {
    setRestaurantName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const handleSlugChange = (v: string) => {
    setSlugTouched(true);
    setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, ''));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No plan is sent: the tier is whatever the tenant actually pays for in
        // the wizard, written by save-config after checkout. The server defaults
        // this to 'starter' as a placeholder, which grants no paid features.
        body: JSON.stringify({ email, password, restaurantName, slug }),
      });
      const body = await r.json() as { jwtToken?: string; slug?: string; error?: string };
      if (!r.ok) { setError(body.error || 'Registration failed'); return; }
      if (!body.jwtToken) { setError('Server error — no token returned'); return; }
      onSignedUp(body.jwtToken, body.slug ?? slug);
    } catch {
      setError('Connection error — please try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-[#F8F7F2] overflow-y-auto py-8">
      <div className="w-full max-w-md px-6">

        <div className="text-center mb-8">
          <h1 className="text-3xl font-serif font-bold text-[#5A5A40]">Create Account</h1>
          <p className="text-[10px] tracking-widest uppercase opacity-40 mt-1.5">
            Voice Kiosk Platform
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white/60 backdrop-blur-sm border border-white/80 rounded-2xl shadow-sm p-8 flex flex-col gap-5"
        >
          <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold -mb-1">
            Account Details
          </p>

          {/* Email */}
          <Field label="Email">
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required autoFocus placeholder="you@restaurant.com"
              className={INPUT}
            />
          </Field>

          {/* Password */}
          <Field label="Password">
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              required minLength={8} placeholder="8+ characters"
              className={INPUT}
            />
          </Field>

          <div className="border-t border-[#5A5A40]/10 pt-1">
            <p className="text-[10px] uppercase tracking-widest opacity-40 font-semibold mb-4">
              Restaurant Info
            </p>

            {/* Restaurant name */}
            <Field label="Restaurant Name">
              <input
                type="text" value={restaurantName} onChange={e => handleNameChange(e.target.value)}
                required placeholder="Savour Foods"
                className={INPUT}
              />
            </Field>

            {/* Slug */}
            <Field label="Kiosk Identifier" hint={`Your kiosk URL: /kiosk/${slug || '…'}`}>
              <input
                type="text" value={slug} onChange={e => handleSlugChange(e.target.value)}
                required placeholder="my-restaurant"
                className={INPUT}
              />
            </Field>
          </div>

          {/* Plan selection deliberately does NOT live here.
              It used to, with its own tier list and no checkout — so a visitor
              picked a plan, was charged nothing, and then met a second, different
              plan list in the setup wizard. Choosing and paying now happen once,
              in the wizard, against the real Paddle catalogue. */}
          <div className="border-t border-[#5A5A40]/10 pt-3">
            <p className="text-[11px] opacity-50 leading-relaxed">
              You'll choose your plan and set up payment next.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-600 text-center -mt-1">{error}</p>
          )}

          <button
            type="submit" disabled={loading || !slug}
            className="w-full mt-1 py-3 bg-[#5A5A40] text-[#F8F7F2] rounded-xl font-bold uppercase tracking-widest text-xs hover:bg-[#4a4a33] active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
          >
            {loading ? 'Creating account…' : 'Create Account →'}
          </button>

          <p className="text-center text-xs opacity-50">
            Already have an account?{' '}
            <button type="button" onClick={onBackToLogin} className="underline cursor-pointer hover:opacity-80">
              Sign in
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────

const INPUT = 'w-full bg-white/80 border border-[#5A5A40]/15 rounded-xl px-4 py-3 text-sm text-[#3D3D33] placeholder:opacity-30 focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/25 transition';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] uppercase tracking-widest opacity-50 font-semibold">{label}</label>
      {children}
      {hint && <p className="text-[10px] opacity-40 font-mono">{hint}</p>}
    </div>
  );
}
