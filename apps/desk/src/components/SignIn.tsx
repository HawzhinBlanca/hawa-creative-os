import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client.js';
import { useDesk } from '../DeskProviders.js';

/**
 * The sign-in prompt, shown by the App in place of any screen while the tab is signed out (ADR-037).
 * It lived inside the Work screen's queue, so a session that ended on another screen never reached it.
 */
export const SignIn: React.FC<{ reason: string | null }> = ({ reason }) => {
  const { session } = useDesk();
  const [key, setKey] = useState('');
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => apiClient.auth.providers() });
  const login = useMutation({
    mutationFn: (accessKey: string) => apiClient.auth.login({ key: accessKey }),
    onSuccess: () => {
      setKey('');
      session.signedIn();
    },
  });

  return (
    <div className="auth-prompt-card" role="region" aria-label="Sign In Required">
      <span style={{ fontSize: 24 }}>🔒</span>
      <h4>Authentication Required</h4>
      <p>{reason || 'Sign in with a valid reviewer or operator key to access the Desk.'}</p>
      {providers.data?.googleWorkspace && (
        <button type="button" className="btn primary" onClick={() => window.location.assign('/v1/auth/google/start')}>
          Sign in with Google Workspace
        </button>
      )}
      <form
        className="auth-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim() && !login.isPending) login.mutate(key.trim());
        }}
      >
        <input
          type="password"
          placeholder="Enter your office access key"
          aria-label="Office access key"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className="input-field"
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
        />
        <div className="auth-form-actions">
          <button type="submit" className="btn primary btn-sm" disabled={!key.trim() || login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign In'}
          </button>
        </div>
        {login.error && <div className="auth-error-msg">{login.error.message || 'Authentication failed'}</div>}
      </form>
    </div>
  );
};
