import { useState, type FormEvent } from "react";

interface SignInScreenProps {
  configured: boolean;
  /** Set when the browser auth variables are present but unusable. */
  configError?: string | null;
  busy: boolean;
  error: string | null;
  onSignIn: (email: string, password: string) => Promise<void>;
}

export function SignInScreen({ configured, configError = null, busy, error, onSignIn }: SignInScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const canSubmit = configured && email.trim().length > 0 && password.length > 0 && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSignIn(email, password);
  }

  return (
    <section className="panel auth-panel" aria-labelledby="signin-heading">
      <div className="panel-heading">
        <h2 id="signin-heading">Sign in</h2>
        <span className="status status-dev">Supabase Auth</span>
      </div>

      {!configured ? (
        configError ? (
          <>
            <p className="muted">Browser-side Supabase Auth configuration is invalid.</p>
            <div className="alert" role="alert">
              <strong>Fix the browser auth configuration.</strong>
              <p>{configError}</p>
              <p>
                Correct the value in <code>storyframe/.env</code>, then restart <code>npm run dev</code>. Use only the
                publishable (or legacy anon) key here; never the service-role key.
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="muted">Browser-side Supabase Auth is not configured.</p>
            <div className="callout">
              <strong>Set the browser auth variables.</strong>
              <p>
                Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to{" "}
                <code>storyframe/.env</code>, then restart <code>npm run dev</code>. Use only the publishable (or legacy
                anon) key here; never the service-role key.
              </p>
            </div>
          </>
        )
      ) : (
        <>
          <p className="muted">
            Use the email and password for your Supabase account. The session is stored by the Supabase client and
            refreshed automatically.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            <label className="field" htmlFor="email">
              <span className="field-label">Email</span>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                spellCheck={false}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
                placeholder="you@example.com"
              />
            </label>

            <label className="field" htmlFor="password">
              <span className="field-label">Password</span>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                placeholder="Supabase password"
              />
            </label>

            <button type="submit" disabled={!canSubmit} aria-busy={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>

          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}

          <p className="hint signin-hint">
            There is no sign-up or password-reset flow yet. Ask the project owner for an account.
          </p>
        </>
      )}
    </section>
  );
}
