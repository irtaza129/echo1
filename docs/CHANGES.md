# Changes — Two-Phase Sign-Up & Setup Wizard Refactor

> Session date: 2026-07-22

---

## Overview

The sign-up flow was restructured from a single heavy multi-step wizard into two lighter phases:

1. **Sign-up collects only the minimum** (name, email, password, restaurant name)
2. **Full restaurant configuration** is moved inside the Admin Dashboard as an optional resumable wizard

---

## Files Changed

### `src/lib/tenantConfig.ts`

**What changed:** Added two new fields to `TenantConfigSchema`.

```ts
setupComplete: z.boolean().default(false),
setupStep:     z.number().min(0).max(7).default(0),
```

**Why:** Every new tenant now starts with `setupComplete: false` and `setupStep: 0`. The wizard reads and writes these to track progress. Because they have Zod defaults, all existing tenants parse without error — no migration needed.

---

### `src/main.tsx`

**What changed:**

- Removed `'onboarding'` from the `Screen` union type
- Removed `OnboardingWizard` import
- Removed `handleOnboardingComplete` callback
- Changed `handleSignedUp` to route to `'admin'` instead of `'onboarding'`
- Removed the `if (screen === 'onboarding')` render block

**Before:**
```ts
type Screen = 'loading' | 'login' | 'signup' | 'onboarding' | ...

const handleSignedUp = (jwt, slug) => {
  ...
  setScreen('onboarding');   // sent user to full-page wizard
};
```

**After:**
```ts
type Screen = 'loading' | 'login' | 'signup' | ...  // onboarding gone

const handleSignedUp = (jwt, slug) => {
  ...
  setScreen('admin');        // lands on Admin Dashboard immediately
};
```

**Why:** New users now land on the Admin Dashboard right after sign-up. The dashboard shows a blue "Setup incomplete" banner instead of forcing users through an 8-step wizard before they can see anything.

---

### `src/SetupWizard.tsx` *(new file)*

**What it is:** The 8-step configuration wizard extracted from `OnboardingWizard.tsx` and adapted to run inside the Admin Dashboard rather than as a standalone screen.

**Key differences from `OnboardingWizard.tsx`:**

| | OnboardingWizard (old) | SetupWizard (new) |
|---|---|---|
| Location | Full-page screen, standalone routing | Rendered inside AdminDashboard |
| Entry point | Immediately after sign-up | User-triggered from Admin |
| Exit | No exit — must complete | "Back to Dashboard" on every step |
| Save | Only at final "Launch" step | `💾 Save` button on every step |
| Resume | Always starts at Step 1 | Resumes at last saved step |
| Data | Starts with defaults | Pre-populated from backend config |
| Completion | Redirected to Admin | Returns to Admin tabs, banner gone |

**Props:**
```ts
interface Props {
  jwtToken:       string;
  initialSlug:    string;
  initialName:    string;
  initialConfig?: Record<string, any>;  // full saved config from backend
  initialStep?:   number;               // 0-7, where to resume
  onComplete:     () => void;
  onExit:         () => void;           // "Back to Dashboard"
  onLogout:       () => void;
}
```

**On mount — resume logic (`useEffect`):**
```ts
useEffect(() => {
  if (!initialConfig) return;
  setCfg(prev => ({
    ...prev,
    restaurantName: initialConfig.restaurantName ?? prev.restaurantName,
    slug:           initialConfig.slug ?? prev.slug,
    // ... all other saved fields
  }));
  setStep(initialConfig.setupStep ?? 0);
}, []);
```

This runs once when the wizard opens, hydrates all form fields from the backend config, and jumps to the last saved step.

**Per-step save (`saveStep`):**

Each step has a `💾 Save` button that:
1. POSTs current form state to `/api/admin/save-config` with `setupComplete: false` and the current `setupStep` number
2. Saves credentials separately via `/api/admin/save-credentials` if the adapter step has a URL/key
3. Shows a confirmation message: `Saved step X/8 — resuming from here`

**Final completion (`saveAndLaunch`):**

Called from the Launch step (Step 8). Saves config with `setupComplete: true` and `setupStep: 7`, then calls `onComplete()` which refreshes the Admin Dashboard.

**Progress indicator:**
```
Step 3 of 8 — 5 steps remaining
```

---

### `src/AdminDashboard.tsx`

**What changed:**

1. **Added import** for `SetupWizard`
2. **Added `setupComplete` and `setupStep`** to the local `FullConfig` interface
3. **Added `showSetupWizard` state** (boolean, default `false`)
4. **Removed auto-show logic** — wizard no longer launches automatically on load; user controls it
5. **Added `handleSetupComplete`** — reloads config from backend when wizard finishes, then hides wizard
6. **Added setup incomplete banner** — shown when `!config.setupComplete`:

```tsx
{!config?.setupComplete && (
  <div className="shrink-0 flex items-center justify-between ... bg-blue-50 border-blue-200">
    <p>Setup incomplete — Complete restaurant setup to enable kiosk features</p>
    <button onClick={() => setShowSetupWizard(true)}>Continue Setup →</button>
  </div>
)}
```

7. **Added `SetupWizard` conditional render** — shown when `showSetupWizard` is true, replaces the normal dashboard tabs:

```tsx
if (showSetupWizard && config) {
  return (
    <SetupWizard
      jwtToken={jwtToken}
      initialSlug={config.slug}
      initialName={config.restaurantName}
      initialConfig={config}
      initialStep={config.setupStep ?? 0}
      onComplete={handleSetupComplete}
      onExit={() => setShowSetupWizard(false)}
      onLogout={onLogout}
    />
  );
}
```

8. **Added "Edit Setup" button** in the Overview tab under the Kiosk URL card — allows revisiting wizard after setup is complete.

**Sign-out button:** Already existed in the header — no change needed.

---

### `src/lib/PromptBuilder.ts`

**What changed:** Rewrote the `LANGUAGE` section of the Gemini system instruction.

**Before:**
```
LANGUAGE:
- Understand and respond in: English, Urdu, Roman Urdu.
- Match the customer's language naturally within the same turn.
```

**After:**
```
LANGUAGE — CRITICAL:
For EVERY message from the customer:
1. Detect the language they used (English, Urdu, Roman Urdu, or other)
2. Respond ONLY in that detected language for that message
3. Do NOT use configured languages — detect and match EACH message independently
4. Examples:
   - Customer says "Hello, what do you have?" → Respond in English
   - Next message "Kya khana hai?" → Respond in Urdu
   - Next message "Kya items hain?" → Respond in Roman Urdu
5. Switch languages mid-conversation without hesitation or explanation
```

**Why:** The old instruction told Gemini which languages to support, but didn't tell it to switch per-message. Gemini would often stay in one language or mix them. The new instruction explicitly tells it to detect and match each message independently.

---

### `src/lib/repo.ts`

**What changed (two fixes):**

1. **Removed `updated_at` from `tenantConfigsRepo.upsert`** — Postgres has a trigger to auto-set this on update. Passing it explicitly caused a 400 from the Supabase API.

2. **Removed `updated_at` from `credentialsRepo.upsert`** — same reason.

3. **Changed `dualWrite` logging level** — Postgres dual-write failures are now logged only in development (`NODE_ENV !== 'production'`) at debug level. Redis is the primary store; Postgres is a secondary sync. The `[DB] dual-write failed` noise in the terminal is gone.

---

### `src/lib/supabaseAdmin.ts`

**What changed:**

1. **Better error messages in `upsert`** — wraps the axios call and throws a descriptive error including `response.data.message` / `response.data.details` so dual-write failures show the actual Supabase reason.

2. **Updated `EXPECTED_COLUMNS`** — schema assertion table corrected to match the actual live DB columns (added `created_at`, `updated_at` to `tenants` and `platform_users`; corrected `audit_log`).

---

### `.claude/` directory *(new)*

**What was added:** The ECC (Everything Claude Code) harness from `github.com/affaan-m/ECC`.

```
.claude/
├── commands/
│   ├── add-language-rules.md    # workflow for adding new language rules
│   ├── database-migration.md    # DB migration workflow
│   └── feature-development.md  # feature dev scaffold
├── rules/
│   ├── everything-claude-code-guardrails.md  # prompt defense & code guardrails
│   └── node.md                               # Node.js conventions for this repo
├── skills/
│   └── everything-claude-code/SKILL.md       # master skill reference
├── identity.json
└── package-manager.json
```

**Why:** Gives Claude Code context about project conventions, Node.js patterns, commit style, and code quality rules — reducing drift between sessions.

---

## Summary Table

| File | Type | Why |
|---|---|---|
| `src/lib/tenantConfig.ts` | Schema change | Track setup state per tenant |
| `src/main.tsx` | Routing change | Skip onboarding, go to admin directly |
| `src/SetupWizard.tsx` | New component | Wizard embedded in admin, resumable |
| `src/AdminDashboard.tsx` | Feature addition | Banner + conditional wizard render |
| `src/lib/PromptBuilder.ts` | Prompt fix | Per-message language detection |
| `src/lib/repo.ts` | Bug fix | Remove bad `updated_at` / silence noise |
| `src/lib/supabaseAdmin.ts` | Bug fix | Better error details + schema assertion |
| `.claude/` | Tooling | ECC harness for better dev experience |
