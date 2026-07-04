import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <main className="flex flex-col items-center gap-8 text-center px-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Interview Agent
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 text-lg">
            AI-powered mock coding interviews with voice
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 mt-4">
          <Link
            href="/normal"
            className="flex h-14 min-w-[200px] items-center justify-center rounded-xl bg-zinc-900 px-8 text-base font-semibold text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Normal Mode
          </Link>
          <Link
            href="/interview"
            className="flex h-14 min-w-[200px] items-center justify-center rounded-xl border border-zinc-300 bg-white px-8 text-base font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
          >
            Interview Mode
          </Link>
        </div>
      </main>
    </div>
  );
}
