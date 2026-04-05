import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function truncateHash(hash: string, start = 6, end = 4): string {
  if (!hash || hash === "Unknown") return "N/A"
  if (hash.length <= start + end + 3) return hash
  return `${hash.substring(0, start)}...${hash.substring(hash.length - end)}`
}
