'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${API_URL}/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || `HTTP ${res.status}`);
      return;
    }
    router.push('/');
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="max-w-sm mx-auto mt-12 space-y-4">
      <h1 className="text-xl font-semibold">{mode === 'login' ? 'Masuk' : 'Daftar'}</h1>
      {error && <div className="text-error text-sm border border-border-default rounded p-2 bg-card">{error}</div>}
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full bg-card border border-border-default rounded px-3 py-2 text-primary focus:outline-none focus:border-accent" />
      <input type="password" placeholder="Password (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} className="w-full bg-card border border-border-default rounded px-3 py-2 text-primary focus:outline-none focus:border-accent" />
      <button type="submit" className="w-full px-4 py-2 border border-border-default rounded text-sm hover:bg-elevated">{mode === 'login' ? 'Masuk' : 'Daftar'}</button>
    </form>
  );
}
