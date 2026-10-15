export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-screen items-start justify-center bg-muted/40 p-4 pt-16 sm:pt-24">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-lg font-semibold">HR Virtual Office</p>
        {children}
      </div>
    </main>
  );
}
