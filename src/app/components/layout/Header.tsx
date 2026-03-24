'use client'

import Link from 'next/link'
import { Sun, Moon, Shield } from 'lucide-react'
import { useTheme } from '@/app/hooks/useTheme'
import { cn } from '@/lib/utils'

interface HeaderProps {
  onTitleClick?: () => void
}

export function Header({ onTitleClick }: HeaderProps) {
  const { theme, toggleTheme } = useTheme()

  return (
    <header
      className="border-b px-4 py-3 bg-[var(--color-surface)] border-[var(--color-border)]"
    >
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        <Link
          href="/"
          onClick={onTitleClick}
          className="flex items-center gap-3"
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--color-primary)] text-white">
            <Shield className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-bold text-[var(--color-text-primary)]">
            Multisig Security
          </h1>
        </Link>

        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className={cn(
              'rounded-lg p-2.5 transition-colors touch-target',
              'text-[var(--color-text-secondary)]',
              'hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)]'
            )}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <Sun className="h-5 w-5" />
            ) : (
              <Moon className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>
    </header>
  )
}
