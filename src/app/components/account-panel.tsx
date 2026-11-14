"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseBrowserConfigured } from "@/lib/supabase/browser";

export default function AccountPanel() {
  const client = getSupabaseBrowserClient();
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client) return;

    let active = true;
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError("Could not read the current account session.");
      setSession(data.session);
    });
    const { data: authListener } = client.auth.onAuthStateChange((_event, currentSession) => {
      if (active) setSession(currentSession);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [client]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) {
      setError("Configure the public Supabase URL and anon key before signing in.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");

    const result = mode === "sign-in"
      ? await client.auth.signInWithPassword({ email, password })
      : await client.auth.signUp({ email, password });

    setBusy(false);
    if (result.error) {
      setError(result.error.message);
    } else if (mode === "sign-up" && !result.data.session) {
      setMessage("Account created. Confirm your email, then sign in.");
      setMode("sign-in");
    } else {
      setMessage("Account connected.");
      setPassword("");
    }
  }

  async function signOut() {
    if (!client) return;
    setBusy(true);
    setError("");
    const { error: signOutError } = await client.auth.signOut();
    setBusy(false);
    if (signOutError) setError(signOutError.message);
    else setMessage("Signed out.");
  }

  return (
    <section className="account-panel" aria-label="Supabase account">
      <div className="account-panel-heading">
        <div>
          <strong>Database account</strong>
          <span>
            {session?.user.email ?? (isSupabaseBrowserConfigured() ? "Sign in to view your sensor data" : "Supabase is not configured")}
          </span>
        </div>
        {session && <span className="account-status">CONNECTED</span>}
      </div>

      {!isSupabaseBrowserConfigured() ? (
        <p className="account-help">Add the public Supabase URL and anon key to your local environment file to enable authentication.</p>
      ) : session ? (
        <button className="button button-secondary small" type="button" onClick={signOut} disabled={busy}>
          {busy ? "Signing out…" : "Sign out"}
        </button>
      ) : (
        <form className="account-form" onSubmit={submit}>
          <label className="form-field">
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="form-field">
            Password
            <input
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <div className="account-actions">
            <button className="button button-primary small" type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setMode(mode === "sign-in" ? "sign-up" : "sign-in");
                setError("");
                setMessage("");
              }}
            >
              {mode === "sign-in" ? "Create an account" : "I already have an account"}
            </button>
          </div>
        </form>
      )}

      {message && <p className="account-message" role="status">{message}</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  );
}
