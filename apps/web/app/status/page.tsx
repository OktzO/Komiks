import { getSourceStatus } from '@/lib/api';

export const revalidate = 600;

export default async function StatusPage() {
  let sources: any[] = [];
  let error: string | null = null;
  try {
    const res = await getSourceStatus();
    sources = res.data;
  } catch (e: any) {
    error = String(e.message || e);
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-1">Status Sumber Data</h1>
      <p className="text-secondary text-sm mb-6">Ketersediaan dan latensi sumber manga (Komiku, MangaDex)</p>

      {error && <div className="text-error text-sm border border-border-default rounded p-3 bg-card mb-4">Gagal memuat: {error}</div>}

      <div className="space-y-3">
        {sources.map((s: any) => (
          <div key={s.source} className="border border-subtle rounded p-4 bg-card">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-primary capitalize">{s.source}</span>
              <span className={`text-xs px-2 py-1 rounded border ${s.healthy ? 'bg-green-900 text-green-200 border-green-700' : 'bg-red-900 text-red-200 border-red-700'}`}>
                {s.healthy ? 'Sehat' : 'Tidak Sehat'}
              </span>
            </div>
            <div className="mt-2 text-sm text-muted">
              Latency: {s.latency_ms}ms · Terakhir dicek: {new Date(s.last_checked_at).toLocaleString('id-ID')}
            </div>
            {s.error && <div className="mt-1 text-xs text-error">{s.error}</div>}
          </div>
        ))}
        {sources.length === 0 && !error && <div className="text-muted text-sm">Tidak ada data status sumber.</div>}
      </div>
    </main>
  );
}
