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

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const ZERO_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

export function extractAddressFromSlot(slot: string | undefined): string | null {
  if (!slot || slot === ZERO_SLOT || slot.length < 66) return null;
  return `0x${slot.slice(-40)}`;
}

export function isContractRevertError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes('revert') || msg.includes('execution reverted')) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = error as any;
  if (anyErr.shortMessage?.toLowerCase().includes('revert')) return true;
  if (typeof anyErr.name === 'string' && anyErr.name.includes('ContractFunction')) return true;
  return false;
}

export const FETCH_TIMEOUT_MS = 15000;

export const ETHERSCAN_API_KEY_PLACEHOLDER = 'YourApiKeyToken';

export function getEtherscanApiKey(): string | null {
  const key = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY;
  if (!key || key === ETHERSCAN_API_KEY_PLACEHOLDER) return null;
  return key;
}
