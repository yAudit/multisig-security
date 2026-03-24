'use client';

import MultisigChecker from '@/components/MultisigChecker';
import { Header } from './components/layout/Header';

export default function Home() {
  const handleTitleClick = () => {
    // Reload the page to reset all state
    window.location.href = '/';
  };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-app)]">
      <Header onTitleClick={handleTitleClick} />

      <main className="flex-1">
        {/* Hero Section */}
        <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="mx-auto max-w-7xl px-4 py-12 sm:py-16">
            <div className="text-center">
              <h1 className="mb-4 text-3xl font-bold tracking-tight text-[var(--color-text-primary)] sm:text-4xl lg:text-5xl">
                Multisig Security Checker
              </h1>
              <p className="mx-auto max-w-2xl text-lg text-[var(--color-text-secondary)]">
                Analyze your Safe multisig contract for security best practices.
                Enter an address to get started. More info in{' '}
                <a
                  href="https://blog.electisec.com/multisig-security"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-primary)] hover:underline"
                >
                  the blog
                </a>.
              </p>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm sm:p-8">
            <MultisigChecker />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <div className="flex flex-col items-center justify-between gap-4 text-sm text-[var(--color-text-tertiary)] sm:flex-row">
            <p>
              Built by{' '}
              <a
                href="https://x.com/bl4ckb1rd71"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-primary)] hover:underline"
              >
                engn33r
              </a>
            </p>
            <p>
              <a
                href="https://github.com/electisec/multisig-security"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-primary)] hover:underline"
              >
                GitHub Repo
              </a>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
