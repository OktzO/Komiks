export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-secondary">Halaman tidak ditemukan.</p>
      <a href="/" className="px-4 py-2 rounded bg-white/10 hover:bg-white/20">
        Kembali ke beranda
      </a>
    </div>
  );
}
