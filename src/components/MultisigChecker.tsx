'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { createPublicClient, http, isAddress, getAddress } from 'viem';
import { multicall } from 'viem/actions';
import Safe from '@safe-global/protocol-kit';
import { GNOSIS_SAFE_ABI, OFFICIAL_SAFE_FALLBACK_HANDLERS, OFFICIAL_SAFE_PROXY_FACTORIES, OFFICIAL_SAFE_SINGLETONS, SENTINEL_MODULES_ADDRESS, GUARD_STORAGE_SLOT, FALLBACK_HANDLER_STORAGE_SLOT } from '../constants/contracts';
import { SUPPORTED_CHAINS, DEFAULT_CHAIN, CHAIN_ID_MAP, CHAIN_EXAMPLES, SAFE_TX_SERVICE_URLS, SAFE_GITHUB_RELEASES_URL, type ChainConfig, isBlockscout, buildExplorerApiUrl } from '../constants/chains';
import { getTooltipInfo } from '../constants/tooltips';
import { Search, Share2, Info, CheckCircle, AlertTriangle, XCircle, Loader2, ChevronDown, ShieldAlert, Shield, HelpCircle } from 'lucide-react';
import { cn, truncateHash } from '@/lib/utils';
import { calculateSecurityScore, PENALTY_CONFIG, DEFAULT_PENALTY, INFORMATIONAL_CHECKS } from '@/lib/scoring';
import { SpeedTest, fetchAndAnalyzeSafe } from './SpeedTest';
import type { AnalysisResult } from './SpeedTest';

// Extended Error type for RPC failures
interface RpcError extends Error {
  isRpcFailure: boolean;
  originalErrors: { primaryError: unknown; backupError: unknown };
}

// Helper to detect if an error is a contract revert (not an RPC issue)
const isContractRevertError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes('revert') || msg.includes('execution reverted')) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = error as any;
  if (anyErr.shortMessage?.toLowerCase().includes('revert')) return true;
  if (typeof anyErr.name === 'string' && anyErr.name.includes('ContractFunction')) return true;
  return false;
};

// Rate limiter for API calls

interface SecurityCheck {
  title: string;
  status: 'success' | 'warning' | 'error' | 'loading' | 'unavailable';
  message: string | React.ReactNode;
}


// App version — displayed in analysis header so screenshots pin the score to a release
const APP_VERSION = 'v2.0.0';

// Safe Transaction Service API URLs
// Cache for Safe version info fetched from GitHub (shared across analyses)
const safeVersionCache: {
  data: { latestVersion: string | null; secondLatestVersion: string | null; latestReleaseDate: Date | null } | null;
  fetchedAt: number;
} = { data: null, fetchedAt: 0 };

// Global Etherscan API rate limiter - 5 requests per second limit
class EtherscanRateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;
  private readonly requestsPerSecond = 5;
  private readonly intervalMs = 1000 / this.requestsPerSecond; // 200ms between requests

  async makeRequest<T>(requestFn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await requestFn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (request) {
        await request();
        // Wait between requests to respect rate limit
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.intervalMs));
        }
      }
    }

    this.isProcessing = false;
  }
}

// Global instance to be used across all Etherscan API calls
const etherscanRateLimiter = new EtherscanRateLimiter();



interface MultisigCheckerProps {
  initialChainId?: number;
  initialAddress?: string;
  autoAnalyze?: boolean;
}

export default function MultisigChecker({ initialChainId, initialAddress, autoAnalyze }: MultisigCheckerProps = {}) {
  // Find initial chain from chainId or use default
  const initialChain = initialChainId
    ? SUPPORTED_CHAINS.find(chain => chain.id === initialChainId) || DEFAULT_CHAIN
    : DEFAULT_CHAIN;

  const [address, setAddress] = useState(initialAddress || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<SecurityCheck[]>([]);
  const [selectedChain, setSelectedChain] = useState<ChainConfig>(initialChain);
  const [openTooltip, setOpenTooltip] = useState<number | string | null>(null);
  const [showShareToast, setShowShareToast] = useState(false);
  const [isToastFading, setIsToastFading] = useState(false);
  const [chainChanged, setChainChanged] = useState(false);
  const [selectedExample, setSelectedExample] = useState('');

  // Ref to track API-authoritative statuses so frontend async callbacks don't overwrite them
  const apiStatusRef = React.useRef<Record<string, 'success' | 'warning' | 'error' | 'unavailable'>>({});

  // Analysis generation counter to prevent stale async callbacks from corrupting state
  const analysisGenRef = React.useRef(0);

  // Reconcile frontend statuses with the API-authoritative statuses.
  // The API overrides the frontend unless the frontend already determined data was unavailable
  // (the API may default failed reads to "success" via zero-address fallbacks).
  React.useEffect(() => {
    const apiStatuses = apiStatusRef.current;
    if (Object.keys(apiStatuses).length === 0) return;

    setResults(prevResults => {
      let needsUpdate = false;
      const newResults = prevResults.map(r => {
        const apiStatus = apiStatuses[r.title];
        if (apiStatus && r.status !== 'loading' && r.status !== 'unavailable' && r.status !== apiStatus) {
          needsUpdate = true;
          return { ...r, status: apiStatus };
        }
        return r;
      });
      return needsUpdate ? newResults : prevResults;
    });
  }, [results]);

  // Memoize security score calculation
  const securityScore = useMemo(() => {
    return calculateSecurityScore(results);
  }, [results]);

  // Memoize client creation to avoid recreating for same chain
  const createClient = useCallback((chain: ChainConfig, useBackup: boolean = false) => {
    const rpcUrl = useBackup ? chain.backupRpcUrl : chain.rpcUrl;
    return createPublicClient({
      chain: chain.viemChain,
      transport: http(rpcUrl)
    });
  }, []);

  // Helper function to execute RPC calls with automatic backup fallback
  const executeWithBackup = async <T,>(
    chain: ChainConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operation: (client: any) => Promise<T>
  ): Promise<T> => {
    try {
      const client = createClient(chain);
      return await operation(client);
    } catch (primaryError) {
      try {
        console.warn(`Primary RPC failed for ${chain.name}, trying backup RPC`);
        const backupClient = createClient(chain, true);
        return await operation(backupClient);
      } catch (backupError) {
        // If both errors are contract reverts, the RPC is fine — the contract just doesn't support the call
        const bothReverts = isContractRevertError(primaryError) || isContractRevertError(backupError);
        if (bothReverts) {
          throw primaryError;
        }
        console.error(`Both primary and backup RPC failed for ${chain.name}:`, primaryError, backupError);
        // Create a specific error type to distinguish RPC failures from contract issues
        const rpcError = new Error(`RPC failure: Unable to connect to ${chain.name} network. Both primary and backup RPC endpoints are unavailable.`) as RpcError;
        rpcError.isRpcFailure = true;
        rpcError.originalErrors = { primaryError, backupError };
        throw rpcError;
      }
    }
  };

  const validateEthereumAddress = (addr: string): boolean => {
    return isAddress(addr);
  };

  const checkContractCode = async (addr: string, chain: ChainConfig): Promise<boolean> => {
    try {
      const code = await executeWithBackup(chain, async (client) => {
        return await client.getBytecode({ address: addr as `0x${string}` });
      });
      return code !== undefined && code !== '0x';
    } catch (error) {
      // Re-throw RPC failures — they should not be masked as "not a contract"
      if (error && (error as RpcError).isRpcFailure) {
        throw error;
      }
      return false;
    }
  };

  const checkVersionFormat = (version: string): boolean => {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    return versionRegex.test(version);
  };

  const getSafeVersionInfo = async (): Promise<{
    latestVersion: string | null;
    secondLatestVersion: string | null;
    latestReleaseDate: Date | null;
  }> => {
    // Return cached result if still fresh (24 hours)
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    if (
      safeVersionCache.data &&
      Date.now() - safeVersionCache.fetchedAt < CACHE_TTL_MS
    ) {
      return safeVersionCache.data;
    }

    try {
      const response = await fetch(SAFE_GITHUB_RELEASES_URL, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        console.error('GitHub API error:', response.status, response.statusText);
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const releases = await response.json();

      if (!Array.isArray(releases) || releases.length === 0) {
        return { latestVersion: null, secondLatestVersion: null, latestReleaseDate: null };
      }

      // Filter and sort valid releases
      const validReleases = releases
        .filter(release => {
          if (!release.tag_name) return false;
          const version = release.tag_name.replace(/^v/, '');
          return checkVersionFormat(version);
        })
        .sort((a, b) => {
          const versionA = a.tag_name.replace(/^v/, '');
          const versionB = b.tag_name.replace(/^v/, '');
          return compareVersionStrings(versionB, versionA); // Sort descending
        });

      const latestVersion = validReleases[0] ? validReleases[0].tag_name.replace(/^v/, '') : null;
      const secondLatestVersion = validReleases[1] ? validReleases[1].tag_name.replace(/^v/, '') : null;
      const latestReleaseDate = validReleases[0] ? new Date(validReleases[0].published_at) : null;

      const result = { latestVersion, secondLatestVersion, latestReleaseDate };
      safeVersionCache.data = result;
      safeVersionCache.fetchedAt = Date.now();
      return result;
    } catch (error) {
      console.error('Error fetching Safe version info:', error);
      return { latestVersion: null, secondLatestVersion: null, latestReleaseDate: null };
    }
  };

  const compareVersionStrings = (versionA: string, versionB: string): number => {
    const [majorA, minorA, patchA] = versionA.split('.').map(Number);
    const [majorB, minorB, patchB] = versionB.split('.').map(Number);

    if (majorA !== majorB) return majorA - majorB;
    if (minorA !== minorB) return minorA - minorB;
    return patchA - patchB;
  };

  const compareVersions = (
    version: string,
    latestVersion: string | null,
    secondLatestVersion: string | null = null,
    latestReleaseDate: Date | null = null
  ): 'latest' | 'second-latest' | 'old' | 'very-old' | 'future' => {
    // If we couldn't fetch the latest version, fall back to hardcoded logic
    if (!latestVersion) {
      if (version === '1.4.1') return 'latest';
      const [major, minor] = version.split('.').map(Number);
      if (major === 1 && minor >= 3 && minor <= 4) return 'old';
      return 'very-old';
    }

    // Check if version matches latest
    if (version === latestVersion) return 'latest';

    // Check if version matches second latest AND latest release is less than 365 days old
    if (secondLatestVersion && version === secondLatestVersion && latestReleaseDate) {
      const daysSinceLatestRelease = (Date.now() - latestReleaseDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLatestRelease < 365) {
        return 'second-latest'; // Return distinct status for second latest
      }
    }

    const [major, minor, patch] = version.split('.').map(Number);
    const [latestMajor, latestMinor, latestPatch] = latestVersion.split('.').map(Number);

    // Compare versions numerically
    if (major < latestMajor) return 'very-old';
    if (major > latestMajor) return 'future'; // Future version

    if (minor < latestMinor) {
      // If it's a recent minor version (within 1-2 versions), it's "old", otherwise "very-old"
      if (latestMinor - minor <= 2) return 'old';
      return 'very-old';
    }
    if (minor > latestMinor) return 'future'; // Future version

    if (patch < latestPatch) return 'old';
    if (patch > latestPatch) return 'future'; // Future version

    return 'latest'; // Should not reach here, but default to latest
  };

  const readSafeCoreIndividually = async (address: string, chain: ChainConfig) => {
    const version = await executeWithBackup(chain, async (client) => {
      return await client.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: 'VERSION',
      });
    });

    const threshold = await executeWithBackup(chain, async (client) => {
      return await client.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: 'getThreshold',
      });
    });

    const owners = await executeWithBackup(chain, async (client) => {
      return await client.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: 'getOwners',
      });
    });

    const nonce = await executeWithBackup(chain, async (client) => {
      return await client.readContract({
        address: address as `0x${string}`,
        abi: GNOSIS_SAFE_ABI,
        functionName: 'nonce',
      });
    });

    let modules: readonly string[] = [];
    try {
      const [moduleArray] = await executeWithBackup(chain, async (client) => {
        return await client.readContract({
          address: address as `0x${string}`,
          abi: GNOSIS_SAFE_ABI,
          functionName: 'getModulesPaginated',
          args: [SENTINEL_MODULES_ADDRESS, 10],
        });
      });
      modules = moduleArray;
    } catch {
      // Optional modules are not available on older Safe versions. Leave empty.
    }

    const zeroSlot = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const extractAddress = (slot: string | undefined): string | null => {
      if (!slot || slot === zeroSlot || slot.length < 66) return null;
      return `0x${slot.slice(-40)}`;
    };

    let guard: string | { error: string } | null = null;
    try {
      const guardSlot = await executeWithBackup(chain, async (client) => {
        return await client.getStorageAt({
          address: address as `0x${string}`,
          slot: GUARD_STORAGE_SLOT as `0x${string}`,
        });
      });
      const guardAddress = extractAddress(guardSlot) || '0x0000000000000000000000000000000000000000';
      guard = guardAddress;
      const [, minor] = (version as string).split('.').map(Number);
      if (guardAddress === '0x0000000000000000000000000000000000000000' && minor < 3) {
        guard = { error: 'UNSUPPORTED_VERSION' };
      }
    } catch {
      const [, minor] = (version as string).split('.').map(Number);
      guard = minor < 3 ? { error: 'UNSUPPORTED_VERSION' } : null;
    }

    let fallbackHandler: string | null = null;
    try {
      const fallbackSlot = await executeWithBackup(chain, async (client) => {
        return await client.getStorageAt({
          address: address as `0x${string}`,
          slot: FALLBACK_HANDLER_STORAGE_SLOT as `0x${string}`,
        });
      });
      fallbackHandler = extractAddress(fallbackSlot);
    } catch {
      fallbackHandler = null;
    }

    // Validate version format
    if (!checkVersionFormat(version)) {
      throw new Error('Contract does not appear to be a Safe multisig (invalid VERSION format)');
    }

    return {
      version: version as string,
      threshold: threshold as bigint,
      owners: owners as readonly string[],
      nonce: nonce as bigint,
      modules,
      guard,
      fallbackHandler,
    };
  };

  const batchGnosisSafeCalls = async (address: string, chain: ChainConfig) => {
    try {
      const [results, guardSlotValue, fallbackSlotValue] = await executeWithBackup(chain, async (client) => {
        const calls = [
          {
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'VERSION',
          },
          {
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'getThreshold',
          },
          {
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'getOwners',
          },
          {
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'nonce',
          },
          {
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'getModulesPaginated',
            args: [SENTINEL_MODULES_ADDRESS, 10],
          },
        ];

        const multicallResults = await multicall(client, {
          contracts: calls,
          allowFailure: true,
        });

        const guardSlot = await client.getStorageAt({
          address: address as `0x${string}`,
          slot: GUARD_STORAGE_SLOT as `0x${string}`,
        });
        const fallbackSlot = await client.getStorageAt({
          address: address as `0x${string}`,
          slot: FALLBACK_HANDLER_STORAGE_SLOT as `0x${string}`,
        });

        return [multicallResults, guardSlot, fallbackSlot] as const;
      });

      // Process results and handle potential errors
      const [versionResult, thresholdResult, ownersResult, nonceResult, modulesResult] = results;

      if (
        versionResult.status === 'failure' ||
        thresholdResult.status === 'failure' ||
        ownersResult.status === 'failure' ||
        nonceResult.status === 'failure'
      ) {
        return await readSafeCoreIndividually(address, chain);
      }

      const version = versionResult.result as string;
      const threshold = thresholdResult.result as bigint;
      const owners = ownersResult.result as readonly string[];
      const nonce = nonceResult.result as bigint;

      // Handle modules result - getModulesPaginated might not exist on older Safe versions
      let modules: readonly string[] = [];
      if (modulesResult.status === 'success') {
        const [moduleArray] = modulesResult.result as [readonly string[], string];
        modules = moduleArray;
      }

      // Read guard from storage slot (Safe v1.4.1 removed public getGuard())
      const zeroSlot = '0x0000000000000000000000000000000000000000000000000000000000000000';
      const extractAddress = (slot: string | undefined): string | null => {
        if (!slot || slot === zeroSlot || slot.length < 66) return null;
        return `0x${slot.slice(-40)}`;
      };
      const guardAddress = extractAddress(guardSlotValue) || '0x0000000000000000000000000000000000000000';
      let guard: string | { error: string } | null = guardAddress;
      const [, minor] = version.split('.').map(Number);
      if (guardAddress === '0x0000000000000000000000000000000000000000' && minor < 3) {
        guard = { error: 'UNSUPPORTED_VERSION' };
      }

      // Read fallback handler from storage slot (Safe v1.4.1 has no getFallbackHandler())
      let fallbackHandler: string | null = null;
      fallbackHandler = extractAddress(fallbackSlotValue);

      // Validate version format
      if (!checkVersionFormat(version)) {
        throw new Error('Contract does not appear to be a Safe multisig (invalid VERSION format)');
      }

      return {
        version,
        threshold,
        owners,
        nonce,
        modules,
        guard,
        fallbackHandler,
      };
    } catch (error) {
      // Check if this is an RPC failure rather than a contract issue
      if (error && (error as RpcError).isRpcFailure) {
        throw error; // Re-throw RPC failure with the original message
      }

      try {
        return await readSafeCoreIndividually(address, chain);
      } catch (fallbackError) {
        if (isContractRevertError(fallbackError)) {
          throw new Error('This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.');
        }
        if (fallbackError instanceof Error) {
          throw fallbackError;
        }
      }

      // If not an RPC failure, it's likely a contract issue
      if (isContractRevertError(error)) {
        throw new Error('This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.');
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Contract does not appear to be a Safe multisig or network error occurred');
    }
  };

  const getContractCreationDate = async (addr: string, chain: ChainConfig): Promise<Date | null> => {
    // 1. Try Safe Transaction Service first (free, no API key needed on most chains)
    if (chain.safeTransactionServiceUrl) {
      try {
        const checksummedAddr = getAddress(addr);
        const url = `${chain.safeTransactionServiceUrl}/api/v1/safes/${checksummedAddr}/creation/`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timeoutId);
          if (response.ok) {
            const data = await response.json();
            if (data.created) {
              return new Date(data.created);
            }
          }
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          throw fetchErr;
        }
      } catch (err) {
        console.error('Safe Transaction Service creation date fetch failed:', err);
        // Fall through to Etherscan fallback
      }
    }

    // 2. Fallback: Etherscan/Blockscout explorer API (requires API key for Etherscan)
    try {
      const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';
      if (!isBlockscout(chain.explorerApiUrl) && (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken')) {
        return null;
      }

      const apikeyParam = isBlockscout(chain.explorerApiUrl) ? '' : `&apikey=${ETHERSCAN_API_KEY}`;
      const apiUrl = buildExplorerApiUrl(chain.explorerApiUrl, chain.id, {
        module: 'account', action: 'txlist', address: addr,
        startblock: '0', endblock: '99999999', page: '1', offset: '20', sort: 'asc',
      }) + apikeyParam;

      const response = await etherscanRateLimiter.makeRequest(() =>
        fetch(apiUrl, {
          headers: {
            'Accept': 'application/json',
          },
        })
      );

      if (!response.ok) {
        console.error(`Explorer creation date API error for ${chain.name}:`, response.status, response.statusText);
        throw new Error(`Explorer API error: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === '1' && data.result && data.result.length > 0) {
        // Look for contract creation transaction (where 'to' field is empty)
        const creationTx = data.result.find((tx: {to: string | null}) => tx.to === '' || tx.to === null);

        if (creationTx) {
          return new Date(parseInt(creationTx.timeStamp) * 1000);
        }

        // If no creation transaction found, use the first transaction as approximation
        // (This handles cases where contract was created by another contract)
        return new Date(parseInt(data.result[0].timeStamp) * 1000);
      } else {
        return null;
      }

    } catch (error) {
      console.error('Error getting contract creation date:', error);
      return null;
    }
  };

  const getLastTransactionDate = async (addr: string, chain: ChainConfig): Promise<Date | null> => {
    // 1. Try Safe Transaction Service first (free, no API key needed on most chains)
    if (chain.safeTransactionServiceUrl) {
      try {
        const checksummedAddr = getAddress(addr);
        const url = `${chain.safeTransactionServiceUrl}/api/v1/safes/${checksummedAddr}/multisig-transactions/?limit=1&ordering=-nonce`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
          clearTimeout(timeoutId);
          if (response.ok) {
            const data = await response.json();
            if (data.results && data.results.length > 0 && data.results[0].executionDate) {
              return new Date(data.results[0].executionDate);
            }
            // No transactions found in Safe — fall through to Etherscan to catch on-chain txs
          }
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          throw fetchErr;
        }
      } catch (err) {
        console.error('Safe Transaction Service last tx date fetch failed:', err);
        // Fall through to Etherscan fallback
      }
    }

    // 2. Fallback: Etherscan/Blockscout explorer API (requires API key for Etherscan)
    try {
      const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';
      if (!isBlockscout(chain.explorerApiUrl) && (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken')) {
        return null;
      }

      const apikeyParam = isBlockscout(chain.explorerApiUrl) ? '' : `&apikey=${ETHERSCAN_API_KEY}`;
      const apiUrl = buildExplorerApiUrl(chain.explorerApiUrl, chain.id, {
        module: 'account', action: 'txlist', address: addr,
        startblock: '0', endblock: '99999999', page: '1', offset: '1', sort: 'desc',
      }) + apikeyParam;

      try {
        const response = await etherscanRateLimiter.makeRequest(() =>
          fetch(apiUrl, {
            headers: {
              'Accept': 'application/json',
            },
          })
        );

        if (!response.ok) {
          console.error(`Explorer last transaction API error for ${chain.name}:`, response.status, response.statusText);
          throw new Error(`Explorer API error: ${response.status}`);
        }
        const data = await response.json();

        if (data.status === '1' && data.result && data.result.length > 0) {
          const lastTx = data.result[0]; // First result when sorted desc is the most recent
          return new Date(parseInt(lastTx.timeStamp) * 1000);
        } else {
            return null;
        }
      } catch (apiError) {
        console.error('Explorer API error for last transaction:', apiError);
        return null;
      }

    } catch (error) {
      console.error('Error getting last transaction date:', error);
      return null;
    }
  };

  const getOwnerLastTransactions = async (ownerAddresses: readonly string[], chain: ChainConfig): Promise<{
    activeOwners: string[];
    inactiveOwners: string[];
    errorOwners: string[];
  }> => {
    const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';

    if (!isBlockscout(chain.explorerApiUrl) && (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken')) {
      // Explorer API key not configured for owner transaction lookup
      return {
        activeOwners: [],
        inactiveOwners: [],
        errorOwners: [...ownerAddresses]
      };
    }


    const results = await Promise.allSettled(
      ownerAddresses.map(async (ownerAddr) => {
        try {
          // Get recent transactions to check for non-multisig activity
          const apikeyParam = isBlockscout(chain.explorerApiUrl) ? '' : `&apikey=${ETHERSCAN_API_KEY}`;
          const apiUrl = buildExplorerApiUrl(chain.explorerApiUrl, chain.id, {
            module: 'account', action: 'txlist', address: ownerAddr,
            startblock: '0', endblock: '99999999', page: '1', offset: '10', sort: 'desc',
          }) + apikeyParam;

          // Add timeout to prevent hanging requests
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

          let response;
          try {
            response = await etherscanRateLimiter.makeRequest(() =>
              fetch(apiUrl, {
                headers: {
                  'Accept': 'application/json',
                },
                signal: controller.signal,
              })
            );
          } finally {
            clearTimeout(timeoutId);
          }

          if (!response.ok) {
            console.error(`Explorer owner transactions API error for ${ownerAddr}:`, response.status, response.statusText);
            throw new Error(`Explorer API error: ${response.status}`);
          }

          const data = await response.json();

          if (data.status === '1' && data.result && data.result.length > 0) {
            // Filter out transactions with methodID 0x6a761202 (acceptable transactions)
            const nonMultisigTxs = data.result.filter((tx: { input?: string; timeStamp: string }) => {
              const methodId = tx.input ? tx.input.slice(0, 10) : '';
              return methodId !== '0x6a761202';
            });

            if (nonMultisigTxs.length === 0) {
              // All transactions are multisig-related, this is good
              return { address: ownerAddr, status: 'inactive', lastTxDate: null };
            }

            // Check the most recent non-multisig transaction
            const lastNonMultisigTx = nonMultisigTxs[0];
            const lastTxDate = new Date(parseInt(lastNonMultisigTx.timeStamp) * 1000);
            const daysSinceLastTx = (Date.now() - lastTxDate.getTime()) / (1000 * 60 * 60 * 24);

            return {
              address: ownerAddr,
              status: daysSinceLastTx > 90 ? 'inactive' : 'active',
              lastTxDate
            };
          } else {
            // No transactions found, consider this good (owner only used for multisig)
            return { address: ownerAddr, status: 'inactive', lastTxDate: null };
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            console.error(`Timeout checking owner ${ownerAddr}:`, error);
            return { address: ownerAddr, status: 'error', lastTxDate: null };
          }
          console.error(`Error checking owner ${ownerAddr}:`, error);
          return { address: ownerAddr, status: 'error', lastTxDate: null };
        }
      })
    );

    const activeOwners: string[] = [];
    const inactiveOwners: string[] = [];
    const errorOwners: string[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const { address, status } = result.value;
        if (status === 'active') {
          activeOwners.push(address);
        } else if (status === 'inactive') {
          inactiveOwners.push(address);
        } else {
          errorOwners.push(address);
        }
      } else {
        errorOwners.push(ownerAddresses[index]);
      }
    });

    return { activeOwners, inactiveOwners, errorOwners };
  };

  const getContractName = async (address: string, chain: ChainConfig, retryCount = 0): Promise<string> => {
    try {
      const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';

      if (!isBlockscout(chain.explorerApiUrl) && (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken')) {
        // No API key configured, returning address
        return address;
      }

      // Add progressive delay for retries to back off more aggressively
      if (retryCount > 0) {
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 10000); // Exponential backoff, max 10 seconds
        // Waiting before retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Try to make the request directly to explorer API
      const apikeyParam = isBlockscout(chain.explorerApiUrl) ? '' : `&apikey=${ETHERSCAN_API_KEY}`;
      const apiUrl = buildExplorerApiUrl(chain.explorerApiUrl, chain.id, {
        module: 'contract', action: 'getsourcecode', address: address,
      }) + apikeyParam;

      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 second timeout

      let response;
      try {
        response = await etherscanRateLimiter.makeRequest(() =>
          fetch(apiUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            },
            signal: controller.signal,
          })
        );
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        console.error(`Contract name API error for ${address}:`, response.status, response.statusText);

        // More aggressive retry logic for rate limiting and server errors
        if ((response.status === 429 || response.status >= 500) && retryCount < 5) {
          // Retrying contract name fetch
          return await getContractName(address, chain, retryCount + 1);
        }

        // For other HTTP errors, also retry a few times
        if (response.status >= 400 && retryCount < 2) {
          // Retrying contract name fetch after HTTP error
          return await getContractName(address, chain, retryCount + 1);
        }

        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      // Processing contract name API response

      // More robust checking of the response
      if (data && data.status === '1' && data.result && Array.isArray(data.result) && data.result.length > 0) {
        const contractInfo = data.result[0];
        if (contractInfo && contractInfo.ContractName && typeof contractInfo.ContractName === 'string' && contractInfo.ContractName.trim() !== '') {
          // Successfully found contract name
          return contractInfo.ContractName.trim();
        }
      }

      // If we get here, the API response was successful but didn't contain a contract name
      // No contract name found in API response

      // For contracts without verified source code, this is expected behavior
      return address;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error(`Timeout fetching contract name for ${address}`);
        // Retry on timeout if we haven't exceeded retry limit
        if (retryCount < 3) {
          // Retrying after timeout
          return await getContractName(address, chain, retryCount + 1);
        }
      } else {
        console.error(`Error fetching contract name for ${address}:`, error);
        // Retry on network errors too
        if (retryCount < 2) {
          // Retrying after error
          return await getContractName(address, chain, retryCount + 1);
        }
      }

      // Failed to get contract name after retries
      return address;
    }
  };

  const checkContractSigners = async (owners: readonly string[], chain: ChainConfig): Promise<string[]> => {
    const contractSigners: string[] = [];

    try {
      const client = createClient(chain);
      // Check each owner address to see if it has contract code
      const codeChecks = await Promise.all(
        owners.map(async (ownerAddress) => {
          try {
            const code = await client.getBytecode({ address: ownerAddress as `0x${string}` });
            return {
              address: ownerAddress,
              hasCode: code !== undefined && code !== '0x' && code.length > 2
            };
          } catch (error) {
            console.error(`Error checking code for owner ${ownerAddress}:`, error);
            return {
              address: ownerAddress,
              hasCode: false
            };
          }
        })
      );

      // Collect addresses that have contract code
      codeChecks.forEach(({ address, hasCode }) => {
        if (hasCode) {
          contractSigners.push(address);
        }
      });

      return contractSigners;
    } catch (error) {
      console.error('Error checking contract signers:', error);
      return [];
    }
  };


  const checkMultiChainSignerReuse = async (address: string, deployedChains: ChainConfig[]): Promise<{ reusedSigners: string[], allChainOwners: { [chainName: string]: string[] }, signerChains: { [signer: string]: string[] } }> => {
    try {
      const allChainOwners: { [chainName: string]: string[] } = {};
      const signerCounts: { [signer: string]: string[] } = {};

      const chainResults = await Promise.allSettled(
        deployedChains.map(async (chain) => {
          const maxRetries = 3;
          let owners: string[] | null = null;

          for (let retryCount = 0; retryCount < maxRetries && owners === null; retryCount++) {
            try {
              const client = createPublicClient({
                chain: {
                  id: CHAIN_ID_MAP[chain.name as keyof typeof CHAIN_ID_MAP] || 1,
                  name: chain.name,
                  rpcUrls: { default: { http: [chain.rpcUrl] } },
                  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                },
                transport: http(chain.rpcUrl)
              });

              const contractCode = await client.getCode({ address: address as `0x${string}` });
              if (!contractCode || contractCode === '0x') {
                return { chainName: chain.name, owners: [] as string[] };
              }

              let fetchedOwners: string[];

              try {
                const safe = await Safe.init({
                  provider: chain.rpcUrl,
                  safeAddress: address,
                });
                fetchedOwners = await safe.getOwners();
              } catch (initError) {
                const initErrorMessage = initError instanceof Error ? initError.message : String(initError);
                if (initErrorMessage.includes('Invalid multiSend contract address')) {
                  const fallbackClient = createPublicClient({
                    chain: {
                      id: CHAIN_ID_MAP[chain.name as keyof typeof CHAIN_ID_MAP] || 1,
                      name: chain.name,
                      rpcUrls: { default: { http: [chain.rpcUrl] } },
                      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                    },
                    transport: http(chain.rpcUrl)
                  });

                  fetchedOwners = await fallbackClient.readContract({
                    address: address as `0x${string}`,
                    abi: GNOSIS_SAFE_ABI,
                    functionName: 'getOwners',
                  }) as string[];
                } else {
                  throw initError;
                }
              }

              return { chainName: chain.name, owners: fetchedOwners };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`Error getting owners for ${address} on ${chain.name} (attempt ${retryCount + 1}):`, errorMessage);
              if (retryCount >= maxRetries - 1) {
                console.error(`Failed to get owners after ${maxRetries} attempts on ${chain.name}`);
                return { chainName: chain.name, owners: [] as string[] };
              }
            }
          }
          return { chainName: chain.name, owners: [] as string[] };
        })
      );

      for (const result of chainResults) {
        if (result.status === 'fulfilled') {
          const { chainName, owners: chainOwners } = result.value;
          allChainOwners[chainName] = chainOwners;
          chainOwners.forEach(owner => {
            const ownerLower = owner.toLowerCase();
            if (!signerCounts[ownerLower]) {
              signerCounts[ownerLower] = [];
            }
            signerCounts[ownerLower].push(chainName);
          });
        }
      }

      const reusedSigners = Object.keys(signerCounts).filter(signer => signerCounts[signer].length > 1);

      return { reusedSigners, allChainOwners, signerChains: signerCounts };
    } catch (error) {
      console.error('Error in multi-chain signer reuse check:', error);
      return { reusedSigners: [], allChainOwners: {}, signerChains: {} };
    }
  };

  const checkRecoveryMechanisms = async (address: string, chain: ChainConfig, modules: readonly string[], threshold: bigint): Promise<{
    hasRecoveryModule: boolean;
    recoveryModules: string[];
    recoveryThreshold: number | null;
    normalThreshold: number;
    thresholdComparison: 'lower' | 'equal' | 'higher' | 'unknown';
  }> => {
    const recoveryModules: string[] = [];
    let recoveryThreshold: number | null = null;

    // Common recovery module patterns and addresses
    const KNOWN_RECOVERY_MODULES = [
      'social recovery',
      'recovery',
      'guardian',
      'allowance',
      'delay'
    ];

    try {
      // Check if any modules are recovery-related
      for (const moduleAddr of modules) {
        try {
          // Try to get contract name to identify recovery modules
          const moduleName = await getContractName(moduleAddr, chain);
          const lowerName = moduleName.toLowerCase();

          // Check if module name contains recovery-related keywords
          const isRecoveryModule = KNOWN_RECOVERY_MODULES.some(keyword =>
            lowerName.includes(keyword)
          );

          if (isRecoveryModule) {
            recoveryModules.push(moduleAddr);

            // Try to read recovery threshold if the module has one
            // Common recovery module interfaces have a threshold() or getThreshold() function
            try {
              const client = createClient(chain);
              const result = await client.readContract({
                address: moduleAddr as `0x${string}`,
                abi: [{
                  "inputs": [],
                  "name": "threshold",
                  "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
                  "stateMutability": "view",
                  "type": "function"
                }],
                functionName: 'threshold'
              });
              recoveryThreshold = Number(result);
            } catch {
              // Module might not have a threshold function, that's okay
            }
          }
        } catch (error) {
          console.error(`Error checking module ${moduleAddr}:`, error);
        }
      }

      const normalThresholdNum = Number(threshold);
      let thresholdComparison: 'lower' | 'equal' | 'higher' | 'unknown' = 'unknown';

      if (recoveryThreshold !== null) {
        if (recoveryThreshold < normalThresholdNum) {
          thresholdComparison = 'lower';
        } else if (recoveryThreshold === normalThresholdNum) {
          thresholdComparison = 'equal';
        } else {
          thresholdComparison = 'higher';
        }
      }

      return {
        hasRecoveryModule: recoveryModules.length > 0,
        recoveryModules,
        recoveryThreshold,
        normalThreshold: normalThresholdNum,
        thresholdComparison
      };
    } catch (error) {
      console.error('Error checking recovery mechanisms:', error);
      return {
        hasRecoveryModule: false,
        recoveryModules: [],
        recoveryThreshold: null,
        normalThreshold: Number(threshold),
        thresholdComparison: 'unknown'
      };
    }
  };

  const checkChainConfiguration = async (address: string): Promise<{
    deployedChains: ChainConfig[];
    isMultiChain: boolean;
    totalDeployments: number;
  }> => {
    // Check if Safe exists on each supported chain
    const chainCheckPromises = SUPPORTED_CHAINS.map(async (chain) => {
      try {
        const hasCode = await checkContractCode(address, chain);
        if (hasCode) {
          // Double-check it's actually a Safe by trying to call VERSION()
          try {
            const client = createClient(chain);
            await client.readContract({
              address: address as `0x${string}`,
              abi: GNOSIS_SAFE_ABI,
              functionName: 'VERSION'
            });
            return chain;
          } catch {
            // Not a Safe contract, ignore
            return null;
          }
        }
        return null;
      } catch {
        // Network error or other issue, ignore this chain
        return null;
      }
    });

    const results = await Promise.all(chainCheckPromises);
    const validChains = results.filter((chain): chain is ChainConfig => chain !== null);

    return {
      deployedChains: validChains,
      isMultiChain: validChains.length > 1,
      totalDeployments: validChains.length
    };
  };

  // Helper function to check if the Safe was deployed by an official factory
  const checkSingletonIntegrity = async (address: string, chainId: number): Promise<{
    masterCopy: string | null;
    singletonName: string | null;
    isOfficial: boolean | null;
    factoryAddress?: string | null;
    factoryNote?: string;
    error?: string;
  }> => {
    const baseUrl = SAFE_TX_SERVICE_URLS[chainId];
    if (!baseUrl) {
      return { masterCopy: null, singletonName: null, isOfficial: null, error: 'Unsupported chain' };
    }

    try {
      const checksummedAddress = getAddress(address);
      const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/creation/`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        return { masterCopy: null, singletonName: null, isOfficial: null, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const masterCopy = data.masterCopy;
      const factoryAddress = data.factoryAddress || null;

      if (!masterCopy) {
        return { masterCopy: null, singletonName: null, isOfficial: null, factoryAddress, error: 'No masterCopy address returned' };
      }

      const chainSingletons = OFFICIAL_SAFE_SINGLETONS[chainId];
      if (!chainSingletons) {
        return { masterCopy, singletonName: null, isOfficial: null, factoryAddress, error: 'No singleton registry for this chain' };
      }

      const singletonName = chainSingletons[masterCopy.toLowerCase()] || null;
      if (singletonName) {
        return { masterCopy, singletonName, isOfficial: true, factoryAddress };
      }

      const factoryInfo = factoryAddress ? OFFICIAL_SAFE_PROXY_FACTORIES?.[factoryAddress.toLowerCase()] : null;
      const factoryNote = factoryInfo
        ? ` (deployed by official factory: ${factoryInfo.name}, but singleton is unrecognized)`
        : '';

      return { masterCopy, singletonName: null, isOfficial: false, factoryAddress, factoryNote };
    } catch (error) {
      return { masterCopy: null, singletonName: null, isOfficial: null, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  };

  const performAnalysis = useCallback(async (addressToAnalyze: string) => {
    const currentGen = ++analysisGenRef.current;
    apiStatusRef.current = {};
    setLoading(true);
    setError('');
    setResults([]);

    // Helper: only call setResults if this is still the current analysis generation
    const safeSetResults = (updater: React.SetStateAction<SecurityCheck[]>) => {
      if (analysisGenRef.current === currentGen) {
        setResults(updater);
      }
    };

    try {
      const hasCode = await checkContractCode(addressToAnalyze, selectedChain);
      if (!hasCode) {
        setError('Address is not a contract');
        setLoading(false);
        return;
      }

      // Verify the contract is actually a Safe multisig by trying to call VERSION()
      try {
        await executeWithBackup(selectedChain, async (client) => {
          return await client.readContract({
            address: addressToAnalyze as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'VERSION',
          });
        });
      } catch (versionError) {
        if (isContractRevertError(versionError) || (versionError instanceof Error && /revert|does not appear/i.test(versionError.message))) {
          setError('This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.');
          setLoading(false);
          return;
        }
        // If it's not a revert, it might be a real RPC error — let it propagate to the full analysis attempt
      }

      // Use multicall to batch all Safe multisig function calls
      const { version, threshold, owners, nonce, modules, guard: guardFromBatch, fallbackHandler: fallbackHandlerFromBatch } = await batchGnosisSafeCalls(addressToAnalyze, selectedChain);

      // Initialize all sections with loading status
      const initialResults: SecurityCheck[] = [
        { title: 'Signing Speed Analysis', status: 'loading', message: 'Analyzing transaction signing patterns...' },
        { title: 'Signer Threshold', status: 'loading', message: 'Loading threshold information...' },
        { title: 'Signer Threshold Percentage', status: 'loading', message: 'Loading threshold percentage...' },
        { title: 'Safe Version', status: 'loading', message: 'Loading version information...' },
        { title: 'Contract Creation Date', status: 'loading', message: 'Loading creation date...' },
        { title: 'Multisig Nonce', status: 'loading', message: 'Loading nonce information...' },
        { title: 'Last Transaction Date', status: 'loading', message: 'Loading last transaction date...' },
        { title: 'Singleton Integrity', status: 'loading', message: 'Checking singleton integrity...' },
        { title: 'Optional Modules', status: 'loading', message: 'Loading module information...' },
        { title: 'Owner Activity Analysis', status: 'loading', message: 'Analyzing owner transaction activity...' },
        { title: 'Contract Signers', status: 'loading', message: 'Checking if signers are contracts...' },
        { title: 'Multi-Chain Signer Analysis', status: 'loading', message: 'Multi-chain deployment not detected' },
        { title: 'Transaction Guard', status: 'loading', message: 'Checking transaction guard configuration...' },
        { title: 'Fallback Handler', status: 'loading', message: 'Checking fallback handler configuration...' },
        { title: 'Chain Configuration', status: 'loading', message: 'Checking multi-chain deployment...' },
        { title: 'Emergency Recovery Mechanisms', status: 'loading', message: 'Checking recovery module configuration...' },
      ];

      safeSetResults(initialResults);
      
      // Show results immediately while individual checks load in background
      setLoading(false);

      // Fetch API results to use as authoritative status source
      // This ensures the frontend and API always produce the same scores
      fetch(`/api/${selectedChain.id}/${addressToAnalyze}`)
        .then(res => res.ok ? res.json() : null)
        .then(apiData => {
          if (!apiData || !apiData.success || !apiData.checks) return;

          // Map API checks by title for easy lookup
          const apiChecksByTitle: Record<string, { status: string; message: string }> = {};
          for (const check of apiData.checks) {
            apiChecksByTitle[check.title] = { status: check.status, message: check.message };
          }

          // Skip if a newer analysis has started since this fetch began
          if (analysisGenRef.current !== currentGen) return;

          // Store API statuses in ref so frontend async callbacks can reference them
          apiStatusRef.current = {};
          for (const [title, apiCheck] of Object.entries(apiChecksByTitle)) {
            apiStatusRef.current[title] = apiCheck.status as 'success' | 'warning' | 'error' | 'unavailable';
          }

          safeSetResults(currentResults => {
            const newResults = [...currentResults];
            const titleToIndex: Record<string, number> = {
              'Signing Speed Analysis': 0,
              'Signer Threshold': 1,
              'Signer Threshold Percentage': 2,
              'Safe Version': 3,
              'Contract Creation Date': 4,
              'Multisig Nonce': 5,
              'Last Transaction Date': 6,
              'Singleton Integrity': 7,
              'Optional Modules': 8,
              'Owner Activity Analysis': 9,
              'Contract Signers': 10,
              'Multi-Chain Signer Analysis': 11,
              'Transaction Guard': 12,
              'Fallback Handler': 13,
              'Chain Configuration': 14,
              'Emergency Recovery Mechanisms': 15,
            };

            for (const [title, index] of Object.entries(titleToIndex)) {
              const apiCheck = apiChecksByTitle[title];
              if (apiCheck && newResults[index]) {
                // Only override status if the frontend hasn't finished its own check yet (still loading)
                // or if we want to force consistency — always use the API status
                const currentResult = newResults[index];
                // Only override status from API; keep the existing message (which may contain rich React UI)
                // unless the frontend check hasn't completed yet
                if (currentResult.status === 'loading') {
                  newResults[index] = {
                    ...currentResult,
                    status: apiCheck.status as 'success' | 'warning' | 'error' | 'unavailable',
                    message: apiCheck.message,
                  };
                } else if (currentResult.status !== 'unavailable') {
                  newResults[index] = {
                    ...currentResult,
                    status: apiCheck.status as 'success' | 'warning' | 'error' | 'unavailable',
                  };
                }
              }
            }
            return newResults;
          });
        })
        .catch(() => {
          // API call failed — frontend checks still run independently
        });

      // Fetch latest Safe version info and update Safe Version status
      const versionInfoPromise = getSafeVersionInfo();
      const updatedResults = [...initialResults];

      // Update Safe Version when version info is fetched
      versionInfoPromise.then(({ latestVersion, secondLatestVersion, latestReleaseDate }) => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];
          const versionStatus = compareVersions(version, latestVersion, secondLatestVersion, latestReleaseDate);
          newResults[3] = {
            title: 'Safe Version',
            status: versionStatus === 'latest' || versionStatus === 'second-latest' ? 'success' : versionStatus === 'old' ? 'warning' : 'error',
            message: versionStatus === 'latest'
              ? `Latest version: ${version}${latestVersion ? ` (current latest: ${latestVersion})` : ''}`
              : versionStatus === 'second-latest'
                ? (() => {
                    const daysSinceLatestRelease = latestReleaseDate ? Math.floor((Date.now() - latestReleaseDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
                    return `Second latest version: ${version}. Newest version (${latestVersion}) released ${daysSinceLatestRelease} days ago.`;
                  })()
              : versionStatus === 'future'
                ? `Unknown future Safe version detected! Version: ${version}${latestVersion ? ` (current latest: ${latestVersion})` : ''}`
              : versionStatus === 'old'
                ? `Outdated version: ${version}${latestVersion ? ` (latest: ${latestVersion})` : ''}`
                : `Very outdated version: ${version}${latestVersion ? ` (latest: ${latestVersion})` : ''}`
          };
          return newResults;
        });
      });

      // Update Signer Threshold (using already validated threshold)
      const thresholdNum = Number(threshold);
      const ownerCount = owners.length;
      const thresholdPct = ownerCount > 0 ? (thresholdNum / ownerCount) * 100 : 0;
      const thresholdStatus: 'error' | 'warning' | 'success' =
        thresholdNum === 0 || thresholdNum === 1 ? 'error'
        : thresholdNum <= 3 && thresholdPct < 51 ? 'warning'
        : 'success';
      updatedResults[1] = {
        title: 'Signer Threshold',
        status: thresholdStatus,
        message: thresholdNum === 0
          ? `No signatures required — anyone can execute transactions. Threshold is set to 0.`
          : thresholdNum === 1
            ? `Single signature requirement is insecure. Only ${thresholdNum} signature is required to execute transactions.`
            : thresholdStatus === 'warning'
              ? `Low signature threshold detected. ${thresholdNum} of ${ownerCount} signatures required to execute transactions.`
              : `Good signature threshold. ${thresholdNum} of ${ownerCount} signatures required to execute transactions.`
      };
      safeSetResults([...updatedResults]);

      // Update Signer threshold percentage (using already validated owners)
      const thresholdPercentage = (thresholdNum / ownerCount) * 100;
      updatedResults[2] = {
        title: 'Signer Threshold Percentage',
        status: thresholdPercentage < 34 ? 'error' : thresholdPercentage < 51 ? 'warning' : 'success',
        message: thresholdPercentage < 34
          ? `Low threshold percentage: only ${thresholdPercentage.toFixed(1)}% of owners (${thresholdNum}/${ownerCount}) required. Consider increasing signer threshold or reducing owners.`
          : thresholdPercentage < 51
            ? `Moderate threshold: ${thresholdPercentage.toFixed(1)}% of owners (${thresholdNum}/${ownerCount}) required for transactions.`
            : `Strong threshold: ${thresholdPercentage.toFixed(1)}% of owners (${thresholdNum}/${ownerCount}) required for transactions.`
      };
      safeSetResults([...updatedResults]);

      // Start API calls in parallel for better performance
      const creationDatePromise = getContractCreationDate(addressToAnalyze, selectedChain);
      const lastTxDatePromise = getLastTransactionDate(addressToAnalyze, selectedChain);
      const ownerActivityPromise = getOwnerLastTransactions(owners, selectedChain);
      const contractSignersPromise = checkContractSigners(owners, selectedChain);
      const guardPromise = Promise.resolve(guardFromBatch);
      const fallbackHandlerPromise = Promise.resolve(fallbackHandlerFromBatch);
      const chainConfigPromise = checkChainConfiguration(addressToAnalyze);
      const recoveryPromise = checkRecoveryMechanisms(addressToAnalyze, selectedChain, modules, threshold);
      const singletonPromise = checkSingletonIntegrity(addressToAnalyze, selectedChain.id);

      // Update Contract Creation Date when ready
      creationDatePromise.then(creationDate => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];
          if (creationDate) {
            const daysSinceCreation = (Date.now() - creationDate.getTime()) / (1000 * 60 * 60 * 24);
            const formattedDate = creationDate.toLocaleDateString();
            newResults[4] = {
              title: 'Contract Creation Date',
              status: daysSinceCreation <= 7 ? 'error' : daysSinceCreation <= 60 ? 'warning' : 'success',
              message: daysSinceCreation <= 7
                ? `Very recently deployed (${Math.floor(daysSinceCreation)} days ago on ${formattedDate}). New contracts carry higher risk.`
                : daysSinceCreation <= 60
                  ? `Recently deployed (${Math.floor(daysSinceCreation)} days ago on ${formattedDate}). Relatively new contract.`
                  : `Established contract deployed ${Math.floor(daysSinceCreation)} days ago on ${formattedDate}.`
            };
          } else {
            newResults[4] = {
              title: 'Contract Creation Date',
              status: 'unavailable',
              message: 'Could not determine contract creation date'
            };
          }
          return newResults;
        });
      });

      // Update Multisig nonce (using multicall result)
      const nonceNum = Number(nonce);
      updatedResults[5] = {
        title: 'Multisig Nonce',
        status: nonceNum <= 3 ? 'error' : nonceNum <= 10 ? 'warning' : 'success',
        message: nonceNum <= 3
          ? `Very low usage: only ${nonceNum} transaction${nonceNum === 1 ? '' : 's'} executed.`
          : nonceNum <= 10
            ? `Low usage: ${nonceNum} transactions executed.`
            : `Active usage: ${nonceNum} transactions executed.`
      };
      safeSetResults([...updatedResults]);

      // Update Singleton Integrity when ready
      singletonPromise.then(({ masterCopy, singletonName, isOfficial, factoryAddress, factoryNote, error }) => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (error || isOfficial === null) {
            newResults[7] = {
              title: 'Singleton Integrity',
              status: 'unavailable',
              message: 'Could not determine singleton integrity.'
            };
          } else if (isOfficial) {
            newResults[7] = {
              title: 'Singleton Integrity',
              status: 'success',
              message: (
                <div className="min-w-0">
                  <div>Delegates to official singleton: <strong>{singletonName}</strong></div>
                  <div className="mt-1 sm:mt-2">
                    <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                      <a
                        href={`${selectedChain.explorerUrl}/address/${masterCopy}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline block"
                      >
                        {masterCopy}
                      </a>
                    </div>
                  </div>
                </div>
              )
            };
          } else {
            newResults[7] = {
              title: 'Singleton Integrity',
              status: 'error',
              message: (
                <div className="min-w-0">
                  <div>Unrecognized singleton address.{factoryNote || ''} Verify this Safe was not created with modified code.</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Singleton Address:</div>
                    <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                      <a
                        href={`${selectedChain.explorerUrl}/address/${masterCopy}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline block"
                      >
                        {masterCopy}
                      </a>
                    </div>
                  </div>
                </div>
              )
            };
          }

          return newResults;
        });
      });

      // Update Optional Modules (using multicall result) with loading state initially
      updatedResults[8] = {
        title: 'Optional Modules',
        status: modules.length === 0 ? 'success' : 'loading',
        message: modules.length === 0
          ? 'No optional modules are enabled. Uses standard Safe functionality only.'
          : `Loading ${modules.length} module${modules.length === 1 ? '' : 's'}...`
      };
      safeSetResults([...updatedResults]);

      // Fetch module names and update modules display
      if (modules.length > 0) {
        const modulesToFetch = modules.slice(0, 3);

        Promise.all(modulesToFetch.map(async (moduleAddr) => {
          const name = await getContractName(moduleAddr, selectedChain);
          return { address: moduleAddr, name };
        })).then(moduleDetails => {
          safeSetResults(currentResults => {
            const newResults = [...currentResults];
            newResults[8] = {
              title: 'Optional Modules',
              status: 'warning',
              message: (
                <div className="min-w-0">
                  <div>{modules.length} module{modules.length === 1 ? '' : 's'} enabled. Review module security.</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Modules:</div>
                    {moduleDetails.map((module) => (
                      <div key={module.address} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                        <a
                          href={`${selectedChain.explorerUrl}/address/${module.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 underline block"
                        >
                          {module.name}
                        </a>
                      </div>
                    ))}
                    {modules.length > 3 && (
                      <div className="ml-1 sm:ml-2 text-gray-600 text-sm">
                        ... and {modules.length - 3} more module{modules.length - 3 === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                </div>
              )
            };
            return newResults;
          });
        }).catch(error => {
          console.error('Error fetching module names:', error);
          safeSetResults(currentResults => {
            const newResults = [...currentResults];
            newResults[8] = {
              title: 'Optional Modules',
              status: 'warning',
              message: `${modules.length} module${modules.length === 1 ? '' : 's'} enabled. Review module security. Could not load module names.`
            };
            return newResults;
          });
        });
      }

      // Update Last transaction date when ready
      lastTxDatePromise.then(lastTxDate => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          // Check nonce first - if it's 0, this Safe has never executed a transaction
          const nonceNum = Number(nonce);
          if (nonceNum === 0) {
            newResults[6] = {
              title: 'Last Transaction Date',
              status: 'warning',
              message: 'No transactions found. This Safe has never been used.'
            };
          } else if (lastTxDate) {
            const daysSinceLastTx = (Date.now() - lastTxDate.getTime()) / (1000 * 60 * 60 * 24);
            const formattedLastTxDate = lastTxDate.toLocaleDateString();
            newResults[6] = {
              title: 'Last Transaction Date',
              status: daysSinceLastTx >= 90 ? 'error' : daysSinceLastTx > 30 ? 'warning' : 'success',
              message: daysSinceLastTx >= 90
                ? `Inactive for ${Math.floor(daysSinceLastTx)} days. Last transaction: ${formattedLastTxDate}.`
                : daysSinceLastTx > 30
                  ? `Last used ${Math.floor(daysSinceLastTx)} days ago on ${formattedLastTxDate}.`
                  : `Recently active. Last transaction: ${formattedLastTxDate} (${Math.floor(daysSinceLastTx)} days ago).`
            };
          } else {
            // API error or other issue - nonce > 0 but couldn't get transaction date
            newResults[6] = {
              title: 'Last Transaction Date',
              status: 'unavailable',
              message: 'Could not determine last transaction date'
            };
          }
          return newResults;
        });
      });

      // Update Owner Activity Analysis when ready
      ownerActivityPromise.then(({ activeOwners, inactiveOwners, errorOwners }) => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (errorOwners.length === owners.length) {
            // All owners had errors, likely due to missing API key or unsupported chain
            newResults[9] = {
              title: 'Owner Activity Analysis',
              status: 'unavailable',
              message: 'Could not analyze owner activity (Explorer API key required)'
            };
          } else if (activeOwners.length === 0) {
            // All owners are inactive (good)
            newResults[9] = {
              title: 'Owner Activity Analysis',
              status: 'success',
              message: `All ${inactiveOwners.length} owner${inactiveOwners.length === 1 ? '' : 's'} may be used exclusively for multisig signing (no recent non-multisig transactions).`
            };
          } else {
            // Some owners are active (not ideal)
            newResults[9] = {
              title: 'Owner Activity Analysis',
              status: 'warning',
              message: (
                <div className="min-w-0">
                  <div>{activeOwners.length} owner{activeOwners.length === 1 ? '' : 's'} potentially ha{activeOwners.length === 1 ? 's' : 've'} recent non-multisig activity. Consider using dedicated signing addresses.</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Active owner{activeOwners.length === 1 ? '' : 's'}:</div>
                    {activeOwners.slice(0, 3).map((owner) => (
                      <div key={owner} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                        <a
                          href={`${selectedChain.explorerUrl}/address/${owner}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 underline block"
                        >
                          {owner}
                        </a>
                      </div>
                    ))}
                    {activeOwners.length > 3 && (
                      <div className="ml-1 sm:ml-2 text-gray-600 text-sm">
                        ... and {activeOwners.length - 3} more owner{activeOwners.length - 3 === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                </div>
              )
            };
          }

          return newResults;
        });
      });

      // Update Transaction Guard when ready
      guardPromise.then(guardResult => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (!guardResult) {
            newResults[12] = {
              title: 'Transaction Guard',
              status: 'unavailable',
              message: 'Could not check transaction guard status'
            };
          } else if (typeof guardResult === 'object' && 'error' in guardResult) {
            newResults[12] = {
              title: 'Transaction Guard',
              status: 'unavailable',
              message: 'Could not check transaction guard status (Safe version too old for guard support)'
            };
          } else if (guardResult === '0x0000000000000000000000000000000000000000' || guardResult === '') {
            // No guard enabled (good)
            newResults[12] = {
              title: 'Transaction Guard',
              status: 'success',
              message: 'No transaction guard enabled. Uses standard Safe transaction execution.'
            };
          } else {
            // Guard enabled (warning - requires review)
            newResults[12] = {
              title: 'Transaction Guard',
              status: 'warning',
              message: (
                <div className="min-w-0">
                  <div>Transaction guard is enabled. Review guard contract security.</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Guard Address:</div>
                    <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                      <a
                        href={`${selectedChain.explorerUrl}/address/${guardResult}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline block"
                      >
                        {guardResult}
                      </a>
                    </div>
                  </div>
                </div>
              )
            };
          }

          return newResults;
        });
      });

      // Update Fallback Handler when ready
      fallbackHandlerPromise.then(fallbackHandlerResult => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (!fallbackHandlerResult) {
            newResults[13] = {
              title: 'Fallback Handler',
              status: 'unavailable',
              message: 'Could not check fallback handler status'
            };
          } else if (fallbackHandlerResult === '0x0000000000000000000000000000000000000000' || fallbackHandlerResult === '') {
            // No fallback handler enabled (good)
            newResults[13] = {
              title: 'Fallback Handler',
              status: 'success',
              message: 'No fallback handler enabled. Uses standard Safe functionality only.'
            };
          } else {
            // Check if it's a known official Safe fallback handler
            const handlerName = OFFICIAL_SAFE_FALLBACK_HANDLERS[fallbackHandlerResult.toLowerCase()];

            if (handlerName) {
              // Known official fallback handler (good)
              newResults[13] = {
                title: 'Fallback Handler',
                status: 'success',
                message: (
                  <div className="min-w-0">
                    <div className="break-words min-w-0" style={{ overflowWrap: 'anywhere' }}>✅ Known Safe fallback handler enabled: <strong className="break-all" style={{ overflowWrap: 'anywhere' }}>{handlerName}</strong></div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Handler Address:</div>
                      <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                        <a
                          href={`${selectedChain.explorerUrl}/address/${fallbackHandlerResult}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 underline block"
                        >
                          {fallbackHandlerResult}
                        </a>
                      </div>
                    </div>
                  </div>
                )
              };
            } else {
              // Unknown fallback handler (warning - requires review)
              newResults[13] = {
                title: 'Fallback Handler',
                status: 'warning',
                message: (
                  <div className="min-w-0">
                    <div className="break-words min-w-0" style={{ overflowWrap: 'anywhere' }}>⚠️ Custom fallback handler enabled. Review handler contract security.</div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Handler Address:</div>
                      <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                        <a
                          href={`${selectedChain.explorerUrl}/address/${fallbackHandlerResult}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 underline block"
                        >
                          {fallbackHandlerResult}
                        </a>
                      </div>
                    </div>
                  </div>
                )
              };
            }
          }

          return newResults;
        });
      });

      // Update Chain Configuration when ready
      chainConfigPromise.then(({ deployedChains, totalDeployments }) => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (totalDeployments === 0) {
            // Should not happen as we already verified the contract exists
            newResults[14] = {
              title: 'Chain Configuration',
              status: 'unavailable',
              message: 'Could not verify Safe deployment on any chain'
            };
          } else if (totalDeployments === 1) {
            // Safe only deployed on one chain (good)
            newResults[14] = {
              title: 'Chain Configuration',
              status: 'success',
              message: `Safe is deployed only on ${selectedChain.name}. No multi-chain deployment detected.`
            };

            // Skip Multi-Chain Signer Analysis for single-chain deployments
            newResults[11] = {
              title: 'Multi-Chain Signer Analysis',
              status: 'success',
              message: 'Not applicable - Safe is only deployed on one chain.'
            };
          } else {
            // Safe deployed on multiple chains (informational)
            const chainNames = deployedChains.map(chain => chain.name).join(', ');
            newResults[14] = {
              title: 'Chain Configuration',
              status: 'success',
              message: (
                <div>
                  <div>Multi-chain deployment detected. This Safe exists on {totalDeployments} chains with the same address.</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Deployed on:</div>
                    <div className="ml-1 sm:ml-2 text-sm sm:text-base">{chainNames}</div>
                  </div>
                </div>
              )
            };

            // Trigger multi-chain signer reuse analysis
            newResults[11] = {
              title: 'Multi-Chain Signer Analysis',
              status: 'loading',
              message: 'Analyzing signer reuse across chains...'
            };

            // Perform multi-chain signer analysis
            checkMultiChainSignerReuse(addressToAnalyze, deployedChains).then(({ reusedSigners, signerChains }) => {
              safeSetResults(currentResults => {
                const updatedResults = [...currentResults];

                if (reusedSigners.length === 0) {
                  // No signer reuse detected (good)
                  updatedResults[11] = {
                    title: 'Multi-Chain Signer Analysis',
                    status: 'success',
                    message: '✅ No signer address appears on different chains. Each chain has unique signers.'
                  };
                } else {
                  // Signer reuse detected (warning)
                  updatedResults[11] = {
                    title: 'Multi-Chain Signer Analysis',
                    status: 'warning',
                    message: (
                      <div className="min-w-0">
                        <div>⚠️ Signer reused between chains. This may increase key compromise risk.</div>
                        <div className="mt-1 sm:mt-2">
                          <div className="font-medium text-sm sm:text-base">Reused signers:</div>
                          {reusedSigners.map((signer) => (
                            <div key={signer} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                              <a
                                href={`${selectedChain.explorerUrl}/address/${signer}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:text-blue-800 underline block"
                              >
                                {signer}
                              </a>
                              <span className="text-gray-600 ml-1">
                                ({signerChains[signer.toLowerCase()]?.join(', ')})
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  };
                }

                return updatedResults;
              });
            }).catch(error => {
              console.error('Multi-chain signer analysis failed:', error);
              safeSetResults(currentResults => {
                const updatedResults = [...currentResults];
                updatedResults[11] = {
                  title: 'Multi-Chain Signer Analysis',
                  status: 'unavailable',
                  message: 'Could not analyze signer reuse across chains'
                };
                return updatedResults;
              });
            });
          }

          return newResults;
        });
      }).catch(error => {
        console.error('Error checking chain configuration:', error);
        safeSetResults(currentResults => {
          const newResults = [...currentResults];
          newResults[14] = {
            title: 'Chain Configuration',
            status: 'unavailable',
            message: 'Could not complete multi-chain deployment check'
          };
          return newResults;
        });
      });

      // Update Signing Speed Analysis (skip for 1-of-N — single signer always has zero
      // duration, and the threshold check already penalizes this configuration)
      if (thresholdNum > 1) {
        fetchAndAnalyzeSafe(addressToAnalyze, selectedChain.id).then(speedAnalysis => {
          safeSetResults(currentResults => {
            const newResults = [...currentResults];

            const status = speedAnalysis.average_duration_seconds < 600 ? 'error' :
                          speedAnalysis.average_duration_seconds < 21600 ? 'warning' : 'success';

            newResults[0] = {
              title: 'Signing Speed Analysis',
              status,
              message: (
                <SpeedTest
                  address={addressToAnalyze}
                  chainId={selectedChain.id}
                  chainName={selectedChain.name}
                  explorerUrl={selectedChain.explorerUrl}
                  initialData={speedAnalysis}
                />
              )
            };

            return newResults;
          });
        }).catch(() => {
          safeSetResults(currentResults => {
            const newResults = [...currentResults];
            newResults[0] = {
              title: 'Signing Speed Analysis',
              status: 'unavailable',
              message: 'No transaction data available for signing speed analysis'
            };
            return newResults;
          });
        });
      } else {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];
          newResults[0] = {
            title: 'Signing Speed Analysis',
            status: 'success',
            message: 'Signing speed analysis skipped for single-signer Safe (threshold is 1).'
          };
          return newResults;
        });
      }

      // Update Emergency Recovery Mechanisms when ready
      recoveryPromise.then(({ hasRecoveryModule, recoveryModules, recoveryThreshold, normalThreshold, thresholdComparison }) => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (!hasRecoveryModule) {
            // No recovery module (neutral - not necessarily bad)
            newResults[15] = {
              title: 'Emergency Recovery Mechanisms',
              status: 'warning',
              message: 'No recovery module detected. Consider implementing social recovery or guardian mechanisms for emergency access.'
            };
          } else {
            // Recovery module exists - assess configuration
            if (thresholdComparison === 'lower') {
              // Recovery threshold is lower than normal - potential security risk
              newResults[15] = {
                title: 'Emergency Recovery Mechanisms',
                status: 'error',
                message: (
                  <div className="min-w-0">
                    <div>⚠️ Recovery module detected with LOWER threshold than normal operations!</div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Configuration:</div>
                      <div className="ml-1 sm:ml-2 text-sm sm:text-base">Normal threshold: {normalThreshold} signatures</div>
                      <div className="ml-1 sm:ml-2 text-sm sm:text-base">Recovery threshold: {recoveryThreshold} signatures</div>
                    </div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Recovery Modules:</div>
                      {recoveryModules.slice(0, 2).map((module) => (
                        <div key={module} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                          <a
                            href={`${selectedChain.explorerUrl}/address/${module}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 underline block"
                          >
                            {module}
                          </a>
                        </div>
                      ))}
                      {recoveryModules.length > 2 && (
                        <div className="ml-1 sm:ml-2 text-gray-600 text-sm">
                          ... and {recoveryModules.length - 2} more
                        </div>
                      )}
                    </div>
                    <div className="mt-2 text-sm">
                      <strong>Security Risk:</strong> Lower recovery threshold could allow easier unauthorized access.
                    </div>
                  </div>
                )
              };
            } else if (thresholdComparison === 'equal') {
              // Recovery threshold equals normal - reasonable
              newResults[15] = {
                title: 'Emergency Recovery Mechanisms',
                status: 'success',
                message: (
                  <div className="min-w-0">
                    <div>Recovery module detected with equal threshold to normal operations.</div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Configuration:</div>
                      <div className="ml-1 sm:ml-2 text-sm sm:text-base">Threshold: {normalThreshold} signatures (both normal and recovery)</div>
                    </div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Recovery Modules:</div>
                      {recoveryModules.slice(0, 2).map((module) => (
                        <div key={module} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                          <a
                            href={`${selectedChain.explorerUrl}/address/${module}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 underline block"
                          >
                            {module}
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              };
            } else if (thresholdComparison === 'higher') {
              // Recovery threshold is higher - very secure
              newResults[15] = {
                title: 'Emergency Recovery Mechanisms',
                status: 'success',
                message: (
                  <div className="min-w-0">
                    <div>Recovery module detected with HIGHER threshold than normal operations (very secure).</div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Configuration:</div>
                      <div className="ml-1 sm:ml-2 text-sm sm:text-base">Normal threshold: {normalThreshold} signatures</div>
                      <div className="ml-1 sm:ml-2 text-sm sm:text-base">Recovery threshold: {recoveryThreshold} signatures</div>
                    </div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Recovery Modules:</div>
                      {recoveryModules.slice(0, 2).map((module) => (
                        <div key={module} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                          <a
                            href={`${selectedChain.explorerUrl}/address/${module}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 underline block"
                          >
                            {module}
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              };
            } else {
              // Unknown threshold comparison
              newResults[15] = {
                title: 'Emergency Recovery Mechanisms',
                status: 'warning',
                message: (
                  <div className="min-w-0">
                    <div>Recovery module detected. Review configuration carefully.</div>
                    <div className="mt-1 sm:mt-2">
                      <div className="font-medium text-sm sm:text-base">Recovery Modules ({recoveryModules.length}):</div>
                      {recoveryModules.slice(0, 2).map((module) => (
                        <div key={module} className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                          <a
                            href={`${selectedChain.explorerUrl}/address/${module}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 underline block"
                          >
                            {module}
                          </a>
                        </div>
                      ))}
                      {recoveryModules.length > 2 && (
                        <div className="ml-1 sm:ml-2 text-gray-600 text-sm">
                          ... and {recoveryModules.length - 2} more
                        </div>
                      )}
                    </div>
                    <div className="mt-2 text-sm">
                      Could not determine recovery threshold. Manual review recommended.
                    </div>
                  </div>
                )
              };
            }
          }

          return newResults;
        });
      }).catch(error => {
        console.error('Error checking recovery mechanisms:', error);
        safeSetResults(currentResults => {
          const newResults = [...currentResults];
          newResults[15] = {
            title: 'Emergency Recovery Mechanisms',
            status: 'unavailable',
            message: 'Could not check recovery mechanisms'
          };
          return newResults;
        });
      });

      // Update Contract Signers when ready
      contractSignersPromise.then(contractSigners => {
        safeSetResults(currentResults => {
          const newResults = [...currentResults];

          if (contractSigners.length === 0) {
            // All signers are EOAs (good)
            newResults[10] = {
              title: 'Contract Signers',
              status: 'success',
              message: 'No multisig signers are contracts. All signers are externally owned accounts (EOAs).'
            };
          } else {
            // Some signers are contracts (warning)
            const contractList = contractSigners.length > 3
              ? contractSigners.slice(0, 3).join(', ') + ` and ${contractSigners.length - 3} more`
              : contractSigners.join(', ');

            newResults[10] = {
              title: 'Contract Signers',
              status: 'warning',
              message: `${contractSigners.length} signer${contractSigners.length === 1 ? '' : 's'} ${contractSigners.length === 1 ? 'is a contract' : 'are contracts'}, not EOA${contractSigners.length === 1 ? '' : 's'}. Need to recursively check those signers. Contract signers: ${contractList}`
            };
          }

          return newResults;
        });
      });

    } catch (err) {
      // Check if this is an RPC failure
      if (err && (err as RpcError).isRpcFailure) {
        setError(err instanceof Error ? err.message : 'RPC failure: Unable to connect to network');
      } else if (isContractRevertError(err) || (err instanceof Error && /revert|does not appear/i.test(err.message))) {
        setError('This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.');
      } else {
        setError(`Error analyzing contract: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedChain]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-analyze when component mounts with initial values
  useEffect(() => {
    if (autoAnalyze && initialAddress && !loading && results.length === 0 && !error && !chainChanged) {
      const validateAndAnalyze = async () => {
        if (!validateEthereumAddress(initialAddress)) {
          setError('Invalid Ethereum address format');
          return;
        }
        await performAnalysis(initialAddress);
      };
      validateAndAnalyze();
    }
    // Reset chainChanged flag after processing
    if (chainChanged) {
      setChainChanged(false);
    }
  }, [autoAnalyze, initialAddress, loading, results.length, error, performAnalysis, chainChanged]);

  const analyzeMultisig = async () => {
    if (!address) {
      setError('Please enter an Ethereum address');
      return;
    }

    if (!validateEthereumAddress(address)) {
      setError('Invalid Ethereum address format');
      return;
    }

    await performAnalysis(address);
  };

  const handleShare = () => {
    if (!address || !validateEthereumAddress(address)) {
      setError('Please enter a valid Ethereum address to share');
      return;
    }

    const shareUrl = `${window.location.origin}/${selectedChain.id}/${address}`;

    // Try to use the Web Share API if available
    if (navigator.share) {
      navigator.share({
        title: 'Multisig Security Analysis',
        text: `Check out this multisig security analysis for ${address}`,
        url: shareUrl,
      }).then(() => {
        // Successfully shared via native share
        showToast();
      }).catch((error) => {
        console.error('Error sharing:', error);
        // Fallback to clipboard
        fallbackShare(shareUrl);
      });
    } else {
      // Fallback to clipboard
      fallbackShare(shareUrl);
    }
  };

  const fallbackShare = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      showToast();
    }).catch(() => {
      // Final fallback - select the URL for manual copying
      const textArea = document.createElement('textarea');
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      showToast();
    });
  };

  const toastTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastFadeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = () => {
    // Clear any pending timeouts from a previous toast to prevent race conditions
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    if (toastFadeTimeoutRef.current) clearTimeout(toastFadeTimeoutRef.current);

    setShowShareToast(true);
    setIsToastFading(false);

    // Start fade out after 1 second
    toastFadeTimeoutRef.current = setTimeout(() => {
      setIsToastFading(true);
    }, 1000);

    // Completely hide after fade completes
    toastTimeoutRef.current = setTimeout(() => {
      setShowShareToast(false);
      setIsToastFading(false);
    }, 1500);
  };

  // Clean up toast timeouts on unmount to prevent memory leaks
  React.useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      if (toastFadeTimeoutRef.current) clearTimeout(toastFadeTimeoutRef.current);
    };
  }, []);



  const handleExampleClick = useCallback(async (exampleAddress: string) => {
    setAddress(exampleAddress);
    setResults([]); // Clear any existing results
    setError('');

    if (!validateEthereumAddress(exampleAddress)) {
      setError('Invalid Ethereum address format');
      return;
    }

    await performAnalysis(exampleAddress);
  }, [performAnalysis]);

  const showExamples = useMemo(() =>
    !loading && results.length === 0 && !error,
    [loading, results.length, error]
  );


  return (
    <div>
      <div className="mb-4 sm:mb-8 space-y-6">
        <div className="grid gap-6 sm:grid-cols-[1fr,auto]">
          <div className="space-y-2">
            <label htmlFor="address" className="block text-sm font-medium text-[var(--color-text-primary)]">
              Multisig Address
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
              <input
                type="text"
                id="address"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (chainChanged) setChainChanged(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) {
                    analyzeMultisig();
                  }
                }}
                placeholder="0x..."
                className={cn(
                  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-10 pr-4 py-3 shadow-sm",
                  "text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]",
                  "focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:shadow-md",
                  "hover:border-[var(--color-border-hover)]",
                  "font-mono text-sm transition-all duration-200"
                )}
              />
            </div>
          </div>
          <div className="space-y-2 sm:w-48">
            <label htmlFor="chain" className="block text-sm font-medium text-[var(--color-text-primary)]">
              Chain
            </label>
            <div className="relative">
              <select
                id="chain"
                value={selectedChain.id}
                onChange={(e) => {
                  const chainId = parseInt(e.target.value);
                  const chain = SUPPORTED_CHAINS.find(c => c.id === chainId);
                  if (chain) {
                    setChainChanged(true);
                    setSelectedChain(chain);
                    setResults([]);
                    setError('');
                    setAddress('');
                    setSelectedExample('');
                  }
                }}
                className={cn(
                  "w-full appearance-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 pr-10 shadow-sm",
                  "text-[var(--color-text-primary)]",
                  "focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:shadow-md",
                  "hover:border-[var(--color-border-hover)]",
                  "transition-all duration-200 cursor-pointer"
                )}
              >
                {SUPPORTED_CHAINS.map((chain) => (
                  <option key={chain.id} value={chain.id}>
                    {chain.name}
                  </option>
                ))}
              </select>
              <svg 
                className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--color-text-tertiary)] pointer-events-none" 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>

        {/* Example Select */}
        {CHAIN_EXAMPLES[selectedChain.id] && CHAIN_EXAMPLES[selectedChain.id].length > 0 && (
          <div className="space-y-2">
            <label
              htmlFor="exampleSelect"
              className="block text-sm font-medium text-[var(--color-text-primary)]"
            >
              Or select an example Safe
            </label>
            <div className="relative">
              <select
                id="exampleSelect"
                value={selectedExample}
                onChange={(e) => {
                  const value = e.target.value;
                  setSelectedExample(value);
                  if (value) {
                    setAddress(value);
                  }
                }}
                className={cn(
                  "w-full appearance-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 pr-10 shadow-sm",
                  "text-[var(--color-text-primary)]",
                  "focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:shadow-md",
                  "hover:border-[var(--color-border-hover)]",
                  "transition-all duration-200 cursor-pointer"
                )}
              >
                <option value="">Choose an example...</option>
                {CHAIN_EXAMPLES[selectedChain.id].map((example) => (
                  <option key={example.address} value={example.address}>
                    {example.name} ({truncateHash(example.address)})
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--color-text-tertiary)] pointer-events-none" />
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={analyzeMultisig}
            disabled={loading}
            className={cn(
              "flex-1 rounded-lg px-6 py-3 text-base font-semibold text-white shadow-sm",
              "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)]",
              "hover:shadow-md active:scale-[0.98]",
              "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[var(--color-primary)] disabled:hover:shadow-sm",
              "transition-all duration-200"
            )}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Analyzing...
              </span>
            ) : (
              "Analyze Safe"
            )}
          </button>
          <button
            onClick={handleShare}
            disabled={!address || loading}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-4 py-3 text-base font-medium",
              "border border-[var(--color-border)] bg-[var(--color-surface)]",
              "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)] hover:text-[var(--color-text-primary)]",
              "hover:border-[var(--color-border-hover)] active:scale-[0.98]",
              "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "transition-all duration-200"
            )}
            title="Share analysis link"
          >
            <Share2 className="h-4 w-4" />
            <span className="hidden sm:inline">Share</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error-bg)] p-4">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-error)]" />
            <p className="text-[var(--color-error)]">{error}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="mt-8 text-center py-12">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--color-primary)]" />
          <p className="mt-4 text-[var(--color-text-secondary)]">Analyzing multisig contract...</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-8 space-y-6">
          {/* Score Card */}
          {securityScore && (
            <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
              <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-6 py-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
                    Security Analysis Results
                  </h2>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-medium text-[var(--color-text-tertiary)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-2.5 py-0.5">
                      {APP_VERSION}
                    </span>
                    {results.some(r => r.status === 'loading') && (
                      <div className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Analyzing...</span>
                      </div>
                    )}
                    {!results.some(r => r.status === 'loading') && (securityScore.unavailableChecks > 0) && (
                      <div className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
                        <HelpCircle className="h-4 w-4" />
                        <span>Incomplete</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="p-6 sm:p-8">
                <div className="text-center">
                  <p className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
                    Overall Security Rating
                  </p>
                  <div className="flex items-center justify-center gap-3 mb-6">
                    <div className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${
                      securityScore.rating === 'Low Risk' ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]' :
                      securityScore.rating === 'Medium Risk' ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]' :
                      'bg-[var(--color-error-bg)] text-[var(--color-error)]'
                    }`}>
                      {securityScore.rating === 'Low Risk' && <CheckCircle className="h-4 w-4" />}
                      {securityScore.rating === 'Medium Risk' && <AlertTriangle className="h-4 w-4" />}
                      {securityScore.rating === 'High Risk' && <XCircle className="h-4 w-4" />}
                      {securityScore.rating}
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-secondary)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)]">
                      <span className="text-[var(--color-text-tertiary)]">Score:</span>
                      <span className={cn(
                        securityScore.rawScore >= 65 && "text-[var(--color-success)]",
                        securityScore.rawScore >= 40 && securityScore.rawScore < 65 && "text-[var(--color-warning)]",
                        securityScore.rawScore < 40 && "text-[var(--color-error)]"
                      )}>
                        {securityScore.rawScore}/100
                      </span>
                    </div>
                  </div>

                  {(results.some(r => r.status === 'loading') || securityScore.unavailableChecks > 0) && (
                    <div className="mb-4 flex items-center justify-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
                      {results.some(r => r.status === 'loading') ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Score based on {securityScore.completedChecks} of {securityScore.totalChecks} checks — analysis in progress</span>
                        </>
                      ) : (
                        <>
                          <HelpCircle className="h-3 w-3" />
                          <span>Score based on {securityScore.completedChecks} of {securityScore.totalChecks} checks — {securityScore.unavailableChecks} check{securityScore.unavailableChecks !== 1 ? 's' : ''} could not be completed</span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Security Bar */}
                  <div className="mx-auto max-w-md">
                    <div className="relative h-3 rounded-full bg-gradient-to-r from-[var(--color-error)] via-[var(--color-warning)] to-[var(--color-success)]">
                      <div
                        className="absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--color-surface)] shadow-md transition-all duration-500"
                        style={{ left: `${securityScore.position}%` }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-xs text-[var(--color-text-tertiary)]">
                      <span>High Risk</span>
                      <span>Medium</span>
                      <span>Low Risk</span>
                    </div>
                  </div>

                  {/* Score Breakdown */}
                  {securityScore.penalties.length > 0 && (
                    <div className="mt-6 border-t border-[var(--color-border)] pt-4">
                      <details className="group">
                        <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                          <span>Score Breakdown</span>
                          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="mt-3 space-y-3">
                          {/* Base Score */}
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-[var(--color-text-secondary)]">Base Score</span>
                            <span className="font-medium text-[var(--color-text-primary)]">100</span>
                          </div>
                          
                          {/* Penalties */}
                          {securityScore.penalties.map((penalty, idx) => (
                            <div key={idx} className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-2">
                                <span className="text-[var(--color-text-secondary)]">{penalty.title}</span>
                              </div>
                              <span className="font-medium text-[var(--color-error)]">-{penalty.points}</span>
                            </div>
                          ))}
                          
                          {/* Final Score */}
                          <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2 text-sm font-semibold">
                            <span className="text-[var(--color-text-primary)]">Final Score</span>
                            <span className={cn(
                              securityScore.rawScore >= 80 && "text-[var(--color-success)]",
                              securityScore.rawScore >= 50 && securityScore.rawScore < 80 && "text-[var(--color-warning)]",
                              securityScore.rawScore < 50 && "text-[var(--color-error)]"
                            )}>
                              {securityScore.rawScore}/100
                            </span>
                          </div>
                          
                          {/* Legend */}
                          <div className="mt-3 rounded-lg bg-[var(--color-surface-secondary)] p-3 text-xs text-[var(--color-text-secondary)]">
                            <details>
                              <summary className="cursor-pointer font-medium text-[var(--color-text-primary)] select-none">
                                How scoring works
                                <ChevronDown className="ml-1 inline h-3 w-3 transition-transform group-open:rotate-180" />
                              </summary>
                              <p className="mt-1 mb-2">Check penalties range from 1-20 points depending on severity.</p>
                              <table className="w-full border-collapse text-xs">
                                <thead>
                                  <tr className="border-b border-[var(--color-border)]">
                                    <th className="py-1 pr-2 text-left font-medium text-[var(--color-text-primary)]">Check</th>
                                    <th className="py-1 px-2 text-right font-medium text-[var(--color-warning)]">Warning</th>
                                    <th className="py-1 pl-2 text-right font-medium text-[var(--color-error)]">Error</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.entries(PENALTY_CONFIG)
                                    .sort(([, a], [, b]) => b.error - a.error)
                                    .map(([title, config]) => (
                                      <tr key={title} className="border-b border-[var(--color-border)]/50 last:border-0">
                                        <td className="py-1 pr-2">{title}</td>
                                        <td className="py-1 px-2 text-right">-{config.warning}</td>
                                        <td className="py-1 pl-2 text-right">-{config.error}</td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </details>
                          </div>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Scored Checks */}
          <div className="space-y-3">
            {results
            .filter(result => result && result.status && result.title && !INFORMATIONAL_CHECKS.has(result.title))
            .map((result, index) => {

              // Special rendering for Signing Speed Analysis - it renders its own container
              if (result.title === 'Signing Speed Analysis') {
                const speedPenaltyConfig = PENALTY_CONFIG[result.title] || DEFAULT_PENALTY;
                return (
                  <div key={index}>
                    {result.status === 'loading' ? (
                      <div className="flex items-center gap-3 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" />
                        <span className="text-sm text-[var(--color-text-secondary)]">Analyzing signing speed...</span>
                      </div>
                    ) : (
                      <div className={cn(
                          "rounded-lg border p-4",
                          result.status === 'success' && "bg-[var(--color-success-bg)] border-[var(--color-success)]/30",
                          result.status === 'warning' && "bg-[var(--color-warning-bg)] border-[var(--color-warning)]/30",
                          result.status === 'error' && "bg-[var(--color-error-bg)] border-[var(--color-error)]/30",
                          result.status === 'unavailable' && "bg-[var(--color-surface-secondary)] border-[var(--color-border)]"
                        )}>
                        {result.status !== 'success' && result.status !== 'unavailable' && (
                          <div className="mb-2">
                            <span className="text-xs text-[var(--color-text-tertiary)]">
                              Score impact: -{result.status === 'error' ? speedPenaltyConfig.error : speedPenaltyConfig.warning} points (Heavily weighted)
                            </span>
                          </div>
                        )}
                        <div className="flex items-start gap-3">
                          {result.status === 'unavailable' && <HelpCircle className="h-5 w-5 shrink-0 text-[var(--color-text-tertiary)]" />}
                          <span>{result.message}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

            const tooltipInfo = getTooltipInfo(result.title);
            const isTooltipOpen = openTooltip === index;

            const penaltyConfig = PENALTY_CONFIG[result.title] || DEFAULT_PENALTY;

            return (
              <div
                key={index}
                className={cn(
                  "rounded-lg border p-4 relative",
                  result.status === 'success' && "bg-[var(--color-success-bg)] border-[var(--color-success)]/30",
                  result.status === 'warning' && "bg-[var(--color-warning-bg)] border-[var(--color-warning)]/30",
                  result.status === 'error' && "bg-[var(--color-error-bg)] border-[var(--color-error)]/30",
                  result.status === 'loading' && "bg-[var(--color-primary-100)] border-[var(--color-primary)]/30",
                  result.status === 'unavailable' && "bg-[var(--color-surface-secondary)] border-[var(--color-border)]"
                )}
              >
                <div className="flex items-start gap-4">
                  <div className="flex items-center justify-center w-6 h-6 shrink-0">
                    {result.status === 'success' && <CheckCircle className="h-5 w-5 text-[var(--color-success)]" />}
                    {result.status === 'warning' && <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" />}
                    {result.status === 'error' && <XCircle className="h-5 w-5 text-[var(--color-error)]" />}
                    {result.status === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" />}
                    {result.status === 'unavailable' && <HelpCircle className="h-5 w-5 text-[var(--color-text-tertiary)]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={cn(
                        "font-semibold",
                        result.status === 'success' && "text-[var(--color-success)]",
                        result.status === 'warning' && "text-[var(--color-warning)]",
                        result.status === 'error' && "text-[var(--color-error)]",
                        result.status === 'loading' && "text-[var(--color-primary)]",
                        result.status === 'unavailable' && "text-[var(--color-text-tertiary)]"
                      )}>{result.title}</h3>
                      
                      <button
                        onClick={() => setOpenTooltip(isTooltipOpen ? null : index)}
                        className={cn(
                          "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 rounded-full p-1 transition-colors",
                          result.status === 'success' && "text-[var(--color-success)]/70 hover:text-[var(--color-success)]",
                          result.status === 'warning' && "text-[var(--color-warning)]/70 hover:text-[var(--color-warning)]",
                          result.status === 'error' && "text-[var(--color-error)]/70 hover:text-[var(--color-error)]",
                          result.status === 'loading' && "text-[var(--color-primary)]/70 hover:text-[var(--color-primary)]",
                          result.status === 'unavailable' && "text-[var(--color-text-tertiary)]/70 hover:text-[var(--color-text-tertiary)]"
                        )}
                        aria-label="Show information"
                      >
                        <Info className="h-4 w-4" />
                      </button>
                    </div>
                    
                    {/* Show penalty info for non-success results */}
                    {result.status !== 'success' && result.status !== 'loading' && result.status !== 'unavailable' && (
                      <div className="mt-1.5 text-xs text-[var(--color-text-tertiary)]">
                        Score impact: -{result.status === 'error' ? penaltyConfig.error : penaltyConfig.warning} points
                      </div>
                    )}
                    
                    <div className="mt-1 text-sm text-[var(--color-text-primary)]">{result.message}</div>

                    {isTooltipOpen && (
                      <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
                        <div className="space-y-3">
                          <div>
                            <h4 className="font-semibold text-[var(--color-text-primary)] mb-1">About this check:</h4>
                            <p className="text-sm text-[var(--color-text-secondary)]">{tooltipInfo.description}</p>
                          </div>

                          {tooltipInfo.thresholds.length > 0 && (
                            <div>
                              <h4 className="font-semibold text-[var(--color-text-primary)] mb-2">Status Thresholds:</h4>
                              <div className="space-y-1">
                                {tooltipInfo.thresholds.map((threshold, idx) => (
                                  <div key={idx} className="text-sm text-[var(--color-text-secondary)]">
                                    <span className="font-medium">{threshold.status}:</span>
                                    <span className="ml-1">{threshold.condition}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="pt-2 border-t border-[var(--color-border)]">
                            <a
                              href={tooltipInfo.learnMoreUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-[var(--color-primary)] hover:underline font-medium inline-flex items-center gap-1"
                            >
                              Learn more
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Informational Checks */}
          {results.some(r => r && r.title && INFORMATIONAL_CHECKS.has(r.title) && r.status && r.status !== 'loading') && (
            <div className="mt-6 pt-6 border-t border-[var(--color-border)]">
              <h3 className="text-sm font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">Informational</h3>
              <div className="space-y-3">
                {results
                  .filter(result => result && result.status && result.title && INFORMATIONAL_CHECKS.has(result.title))
                  .map((result, index) => {

              const tooltipInfo = getTooltipInfo(result.title);
              const isTooltipOpen = openTooltip === `info-${index}`;

              return (
                <div
                  key={`info-${index}`}
                  className={cn(
                    "rounded-lg border p-4 relative",
                    result.status === 'success' && "bg-[var(--color-surface-secondary)] border-[var(--color-border)]",
                    result.status === 'warning' && "bg-[var(--color-warning-bg)] border-[var(--color-warning)]/30",
                    result.status === 'error' && "bg-[var(--color-error-bg)] border-[var(--color-error)]/30",
                    result.status === 'unavailable' && "bg-[var(--color-surface-secondary)] border-[var(--color-border)]"
                  )}
                >
                  <div className="flex items-start gap-4">
                    <div className="flex items-center justify-center w-6 h-6 shrink-0">
                      {result.status === 'success' && <CheckCircle className="h-5 w-5 text-[var(--color-text-tertiary)]" />}
                      {result.status === 'warning' && <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" />}
                      {result.status === 'error' && <XCircle className="h-5 w-5 text-[var(--color-error)]" />}
                      {result.status === 'unavailable' && <HelpCircle className="h-5 w-5 text-[var(--color-text-tertiary)]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className={cn(
                          "font-semibold",
                          result.status === 'success' && "text-[var(--color-text-secondary)]",
                          result.status === 'warning' && "text-[var(--color-warning)]",
                          result.status === 'error' && "text-[var(--color-error)]",
                          result.status === 'unavailable' && "text-[var(--color-text-tertiary)]"
                        )}>{result.title}</h3>
                        <span className="text-xs text-[var(--color-text-tertiary)] bg-[var(--color-surface-secondary)] px-1.5 py-0.5 rounded">Informational</span>
                        
                        <button
                          onClick={() => setOpenTooltip(isTooltipOpen ? null : `info-${index}`)}
                          className="focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 rounded-full p-1 transition-colors text-[var(--color-text-tertiary)]/70 hover:text-[var(--color-text-tertiary)]"
                          aria-label="Show information"
                        >
                          <Info className="h-4 w-4" />
                        </button>
                      </div>
                      
                      <div className="mt-1 text-sm text-[var(--color-text-primary)]">{result.message}</div>

                      {isTooltipOpen && (
                        <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
                          <div className="space-y-3">
                            <div>
                              <h4 className="font-semibold text-[var(--color-text-primary)] mb-1">About this check:</h4>
                              <p className="text-sm text-[var(--color-text-secondary)]">{tooltipInfo.description}</p>
                            </div>

                            {tooltipInfo.thresholds.length > 0 && (
                              <div>
                                <h4 className="font-semibold text-[var(--color-text-primary)] mb-2">Status Thresholds:</h4>
                                <div className="space-y-1">
                                  {tooltipInfo.thresholds.map((threshold, idx) => (
                                    <div key={idx} className="text-sm text-[var(--color-text-secondary)]">
                                      <span className="font-medium">{threshold.status}:</span>
                                      <span className="ml-1">{threshold.condition}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="pt-2 border-t border-[var(--color-border)]">
                              <a
                                href={tooltipInfo.learnMoreUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-[var(--color-primary)] hover:underline font-medium inline-flex items-center gap-1"
                              >
                                Learn more
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
              </div>
            </div>
          )}
        </div>
        </div>
      )}

      {/* Share Toast Notification */}
      {showShareToast && (
        <div className={cn(
          "fixed bottom-6 left-1/2 z-50 -translate-x-1/2",
          "flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg",
          "bg-[var(--color-text-primary)] text-white",
          "transform transition-all duration-500 ease-in-out",
          isToastFading ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'
        )}>
          <CheckCircle className="h-4 w-4 text-[var(--color-success)]" />
          Link copied to clipboard!
        </div>
      )}
    </div>
  );
}
