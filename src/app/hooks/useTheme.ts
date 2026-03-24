'use client'

import { useState, useEffect, useCallback } from 'react'

type Theme = 'light' | 'dark'

interface UseThemeResult {
  theme: Theme
  toggleTheme: () => void
}

const STORAGE_KEY = 'multisig-security-theme'

export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme>('light')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    
    // Check for stored preference
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
    if (stored) {
      setThemeState(stored)
      document.documentElement.setAttribute('data-theme', stored)
    } else {
      // Check system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const initialTheme = prefersDark ? 'dark' : 'light'
      setThemeState(initialTheme)
      document.documentElement.setAttribute('data-theme', initialTheme)
    }
  }, [])

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme)
    localStorage.setItem(STORAGE_KEY, newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }, [])

  const toggleTheme = useCallback(() => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
  }, [theme, setTheme])

  // Prevent hydration mismatch
  if (!mounted) {
    return {
      theme: 'light',
      toggleTheme: () => {},
    }
  }

  return {
    theme,
    toggleTheme,
  }
}
