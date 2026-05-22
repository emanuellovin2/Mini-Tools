import Link from "next/link";

export default function RootPage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-8 text-center bg-white">
      <h1 className="text-4xl font-bold tracking-tight mb-3">[PLATFORM]</h1>
      <p className="text-lg text-gray-500 mb-8 max-w-md">
        Discover and subscribe to independent SaaS tools — billing, access, and
        distribution all in one place.
      </p>
      <div className="flex gap-3">
        <Link
          href="/marketplace"
          className="bg-black text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors"
        >
          Browse Marketplace
        </Link>
        <Link
          href="/login"
          className="border border-gray-300 px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          Sign In
        </Link>
      </div>
    </main>
  );
}
