'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { createPublicClient, http, isAddress, getAddress } from 'viem';
import { multicall } from 'viem/actions';
import Safe from '@safe-global/protocol-kit';
import { GNOSIS_SAFE_ABI, OFFICIAL_SAFE_FALLBACK_HANDLERS, OFFICIAL_SAFE_PROXY_FACTORIES, SAFE_VERSIONS_WITH_KNOWN_FACTORIES, SENTINEL_MODULES_ADDRESS } from '../constants/contracts';
import { SUPPORTED_CHAINS, DEFAULT_CHAIN, CHAIN_ID_MAP, CHAIN_EXAMPLES, type ChainConfig } from '../constants/chains';
import { getTooltipInfo } from '../constants/tooltips';
import { Search, Share2, Info, CheckCircle, AlertTriangle, XCircle, Loader2, Zap, ChevronDown, ShieldAlert, Shield } from 'lucide-react';
import { cn, truncateHash } from '@/lib/utils';
import { calculateSecurityScore, PENALTY_CONFIG, DEFAULT_PENALTY } from '@/lib/scoring';
import { SpeedTest } from './SpeedTest';

// Extended Error type for RPC failures
interface RpcError extends Error {
  isRpcFailure: boolean;
  originalErrors: { primaryError: unknown; backupError: unknown };
}

// Rate limiter for API calls

interface SecurityCheck {
  title: string;
  status: 'success' | 'warning' | 'error' | 'loading';
  message: string | React.ReactNode;
}


// Safe Transaction Service API URLs
const SAFE_API_URLS: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global',
  56: 'https://safe-transaction-bsc.safe.global',
  137: 'https://safe-transaction-polygon.safe.global',
  42161: 'https://safe-transaction-arbitrum.safe.global',
  10: 'https://safe-transaction-optimism.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  747474: 'https://safe-transaction-katana.safe.global',
};

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
  const [openTooltip, setOpenTooltip] = useState<number | null>(null);
  const [showShareToast, setShowShareToast] = useState(false);
  const [isToastFading, setIsToastFading] = useState(false);
  const [chainChanged, setChainChanged] = useState(false);
  const [selectedExample, setSelectedExample] = useState('');

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
    } catch {
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
      const response = await fetch('https://api.github.com/repos/safe-global/safe-smart-account/releases', {
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
      const [major, minor, patch] = version.split('.').map(Number);
      if (major === 1 && minor >= 3 && minor <= 4) {
        if (minor === 4 && patch === 0) return 'old';
        if (minor === 3) return 'old';
        return 'old';
      }
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
    };
  };

  const batchGnosisSafeCalls = async (address: string, chain: ChainConfig) => {
    try {
      const results = await executeWithBackup(chain, async (client) => {
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

        return await multicall(client, {
          contracts: calls,
          allowFailure: true,
        });
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
      };
    } catch (error) {
      // Check if this is an RPC failure rather than a contract issue
      if (error && (error as RpcError).isRpcFailure) {
        throw error; // Re-throw RPC failure with the original message
      }

      try {
        return await readSafeCoreIndividually(address, chain);
      } catch (fallbackError) {
        if (fallbackError instanceof Error) {
          throw fallbackError;
        }
      }

      // If not an RPC failure, it might be a contract issue
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Contract does not appear to be a Safe multisig or network error occurred');
    }
  };

  const getContractCreationDate = async (addr: string, chain: ChainConfig): Promise<Date | null> => {
    try {
      // Use explorer API to get contract creation information
      // This requires an Etherscan API key to be set
      const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';

      if (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken') {
        return null;
      }


      // Get first 20 transactions in one call to find contract creation efficiently
      // All chains now use Etherscan V2 unified API with chainid parameter
      const apiUrl = `${chain.explorerApiUrl}?chainid=${chain.id}&module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=20&sort=asc&apikey=${ETHERSCAN_API_KEY}`;

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
    try {
      // Use explorer API to get the most recent transaction
      const ETHERSCAN_API_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || 'YourApiKeyToken';

      if (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken') {
        return null;
      }


      // Get the most recent transaction by sorting in descending order and taking the first result
      // All chains now use Etherscan V2 unified API with chainid parameter
      const apiUrl = `${chain.explorerApiUrl}?chainid=${chain.id}&module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=1&sort=desc&apikey=${ETHERSCAN_API_KEY}`;

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

    if (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken') {
      // Explorer API key not configured for owner transaction lookup
      return {
        activeOwners: [],
        inactiveOwners: [],
        errorOwners: [...ownerAddresses]
      };
    }


    const results = await Promise.allSettled(
      ownerAddresses.map(async (ownerAddr, index) => {
        try {
          // Add staggered delay to prevent rate limiting
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000 * index));
          }

          // Get recent transactions to check for non-multisig activity
          // All chains now use Etherscan V2 unified API with chainid parameter
          const apiUrl = `${chain.explorerApiUrl}?chainid=${chain.id}&module=account&action=txlist&address=${ownerAddr}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=${ETHERSCAN_API_KEY}`;

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

      if (!ETHERSCAN_API_KEY || ETHERSCAN_API_KEY === 'YourApiKeyToken') {
        // No API key configured, returning address
        return address;
      }

      // Add progressive delay for retries to back off more aggressively
      if (retryCount > 0) {
        const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 10000); // Exponential backoff, max 10 seconds
        // Waiting before retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Try to make the request directly to Etherscan API
      const apiUrl = `${chain.explorerApiUrl}?chainid=${chain.id}&module=contract&action=getsourcecode&address=${address}&apikey=${ETHERSCAN_API_KEY}`;

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

  const checkSafeGuard = async (address: string, chain: ChainConfig): Promise<string | { error: string }> => {
    try {
      // Try Safe Protocol Kit first
      const safe = await Safe.init({
        provider: chain.rpcUrl,
        safeAddress: address,
      });

      const guardAddress = await safe.getGuard();
      return guardAddress;
    } catch (error) {
      console.error('Error checking Safe guard with SDK:', error);

      // Check if the error is specifically about unsupported Safe version
      if (error instanceof Error && error.message.includes('does not support Safe transaction guards')) {
        return { error: 'UNSUPPORTED_VERSION' };
      }

      // If SDK fails (e.g., multiSend contract address error), try direct viem fallback
      if (error instanceof Error && error.message.includes('Invalid multiSend contract address')) {
        // Falling back to direct viem call for getGuard
        try {
          const client = createClient(chain);
          const guardAddress = await client.readContract({
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'getGuard',
          });
          return guardAddress as string;
        } catch (viemError) {
          console.error('Direct viem fallback failed for getGuard:', viemError);
          if (viemError instanceof Error && viemError.message.includes('function does not exist')) {
            return { error: 'UNSUPPORTED_VERSION' };
          }
          return { error: 'GENERAL_ERROR' };
        }
      }

      // Other types of errors (network, invalid address, etc.)
      return { error: 'GENERAL_ERROR' };
    }
  };


  const checkMultiChainSignerReuse = async (address: string, deployedChains: ChainConfig[]): Promise<{ reusedSigners: string[], allChainOwners: { [chainName: string]: string[] }, signerChains: { [signer: string]: string[] } }> => {
    try {
      // Checking signer reuse across multiple chains

      const allChainOwners: { [chainName: string]: string[] } = {};
      const signerCounts: { [signer: string]: string[] } = {};

      // Get owners from each chain with rate limiting and retry logic
      for (const chain of deployedChains) {
        let retryCount = 0;
        const maxRetries = 3;
        let success = false;

        while (retryCount < maxRetries && !success) {
          try {
            // Getting owners with retry

            // Rate limiting: wait 400ms before each request
            if (retryCount > 0) {
              // Retrying after delay
            }
            await new Promise(resolve => setTimeout(resolve, 400));

            // First check if the contract exists on this chain
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
              // Contract does not exist on this chain
              allChainOwners[chain.name] = [];
              success = true;
              continue;
            }

            let owners: string[];

            try {
              // Try Safe Protocol Kit first
              const safe = await Safe.init({
                provider: chain.rpcUrl,
                safeAddress: address,
              });
              owners = await safe.getOwners();
            } catch (initError) {
              const initErrorMessage = initError instanceof Error ? initError.message : String(initError);
              if (initErrorMessage.includes('Invalid multiSend contract address')) {
                // Safe SDK failed, falling back to direct viem calls
                // Fallback to direct viem call
                const client = createPublicClient({
                  chain: {
                    id: CHAIN_ID_MAP[chain.name as keyof typeof CHAIN_ID_MAP] || 1,
                    name: chain.name,
                    rpcUrls: { default: { http: [chain.rpcUrl] } },
                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }
                  },
                  transport: http(chain.rpcUrl)
                });

                owners = await client.readContract({
                  address: address as `0x${string}`,
                  abi: GNOSIS_SAFE_ABI,
                  functionName: 'getOwners',
                }) as string[];
              } else {
                throw initError;
              }
            }
            allChainOwners[chain.name] = owners;

            // Track which chains each signer appears on
            owners.forEach(owner => {
              const ownerLower = owner.toLowerCase();
              if (!signerCounts[ownerLower]) {
                signerCounts[ownerLower] = [];
              }
              signerCounts[ownerLower].push(chain.name);
            });

            // Found owners on chain
            success = true;
          } catch (error) {
            retryCount++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Error getting owners for ${address} on ${chain.name} (attempt ${retryCount}):`, errorMessage);

            // Handle specific multiSend contract errors
            if (errorMessage.includes('Invalid multiSend contract address')) {
              console.warn(`MultiSend contract error on ${chain.name} - possible Safe version compatibility issue`);
            }

            if (retryCount >= maxRetries) {
              console.error(`Failed to get owners after ${maxRetries} attempts on ${chain.name}`);
              // Final error details logged
              // Skip this chain if we can't get owners after all retries
              allChainOwners[chain.name] = [];
            } else {
              // Add extra delay for multiSend errors before retry
              if (errorMessage.includes('Invalid multiSend contract address')) {
                // Adding delay for multiSend error before retry
                await new Promise(resolve => setTimeout(resolve, 200));
              }
            }
          }
        }
      }

      // Find signers that appear on multiple chains
      const reusedSigners = Object.keys(signerCounts).filter(signer => signerCounts[signer].length > 1);

      // Signer reuse analysis completed

      return { reusedSigners, allChainOwners, signerChains: signerCounts };
    } catch (error) {
      console.error('Error in multi-chain signer reuse check:', error);
      return { reusedSigners: [], allChainOwners: {}, signerChains: {} };
    }
  };

  const checkSafeFallbackHandler = async (address: string, chain: ChainConfig): Promise<string | { error: string }> => {
    try {
      // Try Safe Protocol Kit first
      const safe = await Safe.init({
        provider: chain.rpcUrl,
        safeAddress: address,
      });

      const fallbackHandlerAddress = await safe.getFallbackHandler();
      return fallbackHandlerAddress;
    } catch (error) {
      console.error('Error checking Safe fallback handler with SDK:', error);

      // Check if the error is specifically about unsupported Safe version
      if (error instanceof Error && error.message.includes('does not support')) {
        return { error: 'UNSUPPORTED_VERSION' };
      }

      // If SDK fails (e.g., multiSend contract address error), try direct viem fallback
      if (error instanceof Error && error.message.includes('Invalid multiSend contract address')) {
        // Falling back to direct viem call for getFallbackHandler
        try {
          const client = createClient(chain);
          const fallbackHandlerAddress = await client.readContract({
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'getFallbackHandler',
          });
          return fallbackHandlerAddress as string;
        } catch (viemError) {
          console.error('Direct viem fallback failed for getFallbackHandler:', viemError);
          if (viemError instanceof Error && viemError.message.includes('function does not exist')) {
            return { error: 'UNSUPPORTED_VERSION' };
          }
          return { error: 'GENERAL_ERROR' };
        }
      }

      // Other types of errors (network, invalid address, etc.)
      return { error: 'GENERAL_ERROR' };
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

  // Helper function to fetch signing speed data for status determination
  const fetchSigningSpeedData = async (address: string, chainId: number): Promise<{ avgDuration: number | null; error?: string }> => {
    const baseUrl = SAFE_API_URLS[chainId];
    if (!baseUrl) {
      return { avgDuration: null, error: 'Unsupported chain' };
    }

    try {
      // Properly checksum the address for Safe API
      const checksummedAddress = getAddress(address);
      const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/multisig-transactions/?executed=true&limit=10&ordering=-executionDate`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      
      if (!response.ok) {
        return { avgDuration: null, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const transactions = data.results || [];

      if (!transactions.length) {
        return { avgDuration: null, error: 'No executed transactions found' };
      }

      let totalDuration = 0;
      let validTxCount = 0;

      for (const tx of transactions) {
        const confirmations = tx.confirmations || [];
        if (!confirmations.length) continue;

        const sorted = [...confirmations].sort((a, b) => 
          (a.submissionDate || '').localeCompare(b.submissionDate || '')
        );

        const firstTime = sorted[0].submissionDate ? new Date(sorted[0].submissionDate).getTime() : null;
        const lastTime = sorted[sorted.length - 1].submissionDate ? new Date(sorted[sorted.length - 1].submissionDate).getTime() : null;
        
        if (firstTime && lastTime && !isNaN(firstTime) && !isNaN(lastTime)) {
          const durationSeconds = (lastTime - firstTime) / 1000;
          totalDuration += durationSeconds;
          validTxCount++;
        }
      }

      if (validTxCount === 0) {
        return { avgDuration: null, error: 'No valid transaction timing data' };
      }

      return { avgDuration: totalDuration / validTxCount };
    } catch (error) {
      return { avgDuration: null, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  };

  // Helper function to check if the Safe was deployed by an official factory
  const checkSafeFactory = async (address: string, chainId: number, safeVersion: string): Promise<{
    factoryAddress: string | null;
    factoryName: string | null;
    isOfficial: boolean | null;
    versionHasKnownFactories: boolean;
    error?: string;
  }> => {
    const versionHasKnownFactories = SAFE_VERSIONS_WITH_KNOWN_FACTORIES.has(safeVersion);

    const baseUrl = SAFE_API_URLS[chainId];
    if (!baseUrl) {
      return { factoryAddress: null, factoryName: null, isOfficial: null, versionHasKnownFactories, error: 'Unsupported chain' };
    }

    try {
      const checksummedAddress = getAddress(address);
      const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/creation/`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });

      if (!response.ok) {
        return { factoryAddress: null, factoryName: null, isOfficial: null, versionHasKnownFactories, error: `API error: ${response.status}` };
      }

      const data = await response.json();
      const factoryAddress = data.factoryAddress;

      if (!factoryAddress) {
        return { factoryAddress: null, factoryName: null, isOfficial: null, versionHasKnownFactories, error: 'No factory address returned' };
      }

      const factoryInfo = OFFICIAL_SAFE_PROXY_FACTORIES[factoryAddress.toLowerCase()] || null;
      return {
        factoryAddress,
        factoryName: factoryInfo?.name || null,
        isOfficial: factoryInfo !== null,
        versionHasKnownFactories,
      };
    } catch (error) {
      return { factoryAddress: null, factoryName: null, isOfficial: null, versionHasKnownFactories, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  };

  const performAnalysis = useCallback(async (addressToAnalyze: string) => {
    setLoading(true);
    setError('');
    setResults([]);

    try {
      const hasCode = await checkContractCode(addressToAnalyze, selectedChain);
      if (!hasCode) {
        setError('Address is not a contract');
        setLoading(false);
        return;
      }

      // Use multicall to batch all Safe multisig function calls
      const { version, threshold, owners, nonce, modules } = await batchGnosisSafeCalls(addressToAnalyze, selectedChain);

      // Initialize all sections with loading status
      const initialResults: SecurityCheck[] = [
        { title: 'Signing Speed Analysis', status: 'loading', message: 'Analyzing transaction signing patterns...' },
        { title: 'Signer Threshold', status: 'loading', message: 'Loading threshold information...' },
        { title: 'Signer Threshold Percentage', status: 'loading', message: 'Loading threshold percentage...' },
        { title: 'Safe Version', status: 'loading', message: 'Loading version information...' },
        { title: 'Contract Creation Date', status: 'loading', message: 'Loading creation date...' },
        { title: 'Multisig Nonce', status: 'loading', message: 'Loading nonce information...' },
        { title: 'Last Transaction Date', status: 'loading', message: 'Loading last transaction date...' },
        { title: 'Safe Factory', status: 'loading', message: 'Checking deployment factory...' },
        { title: 'Optional Modules', status: 'loading', message: 'Loading module information...' },
        { title: 'Transaction Guard', status: 'loading', message: 'Checking transaction guard configuration...' },
        { title: 'Fallback Handler', status: 'loading', message: 'Checking fallback handler configuration...' },
        { title: 'Chain Configuration', status: 'loading', message: 'Checking multi-chain deployment and replay protection...' },
        { title: 'Owner Activity Analysis', status: 'loading', message: 'Analyzing owner transaction activity...' },
        { title: 'Emergency Recovery Mechanisms', status: 'loading', message: 'Checking recovery module configuration...' },
        { title: 'Contract Signers', status: 'loading', message: 'Checking if signers are contracts...' },
        { title: 'Multi-Chain Signer Analysis', status: 'loading', message: 'Multi-chain deployment not detected' }
      ];

      setResults(initialResults);
      
      // Show results immediately while individual checks load in background
      setLoading(false);

      // Fetch latest Safe version info and update Safe Version status
      const versionInfoPromise = getSafeVersionInfo();
      const updatedResults = [...initialResults];

      // Update Safe Version when version info is fetched
      versionInfoPromise.then(({ latestVersion, secondLatestVersion, latestReleaseDate }) => {
        setResults(currentResults => {
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
        thresholdNum === 1 ? 'error'
        : thresholdNum <= 3 && thresholdPct < 51 ? 'warning'
        : 'success';
      updatedResults[1] = {
        title: 'Signer Threshold',
        status: thresholdStatus,
        message: thresholdNum === 1
          ? `Single signature requirement is insecure. Only ${thresholdNum} signature is required to execute transactions.`
          : thresholdStatus === 'warning'
            ? `Low signature threshold detected. ${thresholdNum} of ${ownerCount} signatures required to execute transactions.`
            : `Good signature threshold. ${thresholdNum} of ${ownerCount} signatures required to execute transactions.`
      };
      setResults([...updatedResults]);

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
      setResults([...updatedResults]);

      // Start API calls in parallel for better performance
      const creationDatePromise = getContractCreationDate(addressToAnalyze, selectedChain);
      const lastTxDatePromise = getLastTransactionDate(addressToAnalyze, selectedChain);
      const ownerActivityPromise = getOwnerLastTransactions(owners, selectedChain);
      const contractSignersPromise = checkContractSigners(owners, selectedChain);
      const guardPromise = checkSafeGuard(addressToAnalyze, selectedChain);
      const fallbackHandlerPromise = checkSafeFallbackHandler(addressToAnalyze, selectedChain);
      const chainConfigPromise = checkChainConfiguration(addressToAnalyze);
      const recoveryPromise = checkRecoveryMechanisms(addressToAnalyze, selectedChain, modules, threshold);
      const factoryPromise = checkSafeFactory(addressToAnalyze, selectedChain.id, version);

      // Update Contract Creation Date when ready
      creationDatePromise.then(creationDate => {
        setResults(currentResults => {
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
              status: 'warning',
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
      setResults([...updatedResults]);

      // Update Safe Factory when ready
      factoryPromise.then(({ factoryAddress, factoryName, isOfficial, versionHasKnownFactories, error }) => {
        setResults(currentResults => {
          const newResults = [...currentResults];

          if (error || isOfficial === null) {
            newResults[7] = {
              title: 'Safe Factory',
              status: 'warning',
              message: 'Could not determine deployment factory.'
            };
          } else if (isOfficial) {
            newResults[7] = {
              title: 'Safe Factory',
              status: 'success',
              message: (
                <div className="min-w-0">
                  <div>Deployed by official factory: <strong>{factoryName}</strong></div>
                  <div className="mt-1 sm:mt-2">
                    <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                      <a
                        href={`${selectedChain.explorerUrl}/address/${factoryAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline block"
                      >
                        {factoryAddress}
                      </a>
                    </div>
                  </div>
                </div>
              )
            };
          } else {
            newResults[7] = {
              title: 'Safe Factory',
              status: versionHasKnownFactories ? 'error' : 'warning',
              message: (
                <div className="min-w-0">
                  <div>{versionHasKnownFactories
                    ? 'Deployed by unrecognized factory. Verify this Safe was not created with modified code.'
                    : 'Deployed by unrecognized factory. No known official factories for this Safe version, so this may be expected.'
                  }</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Factory Address:</div>
                    <div className="ml-1 sm:ml-2 break-all break-words min-w-0 max-w-full overflow-hidden text-sm sm:text-base">
                      <a
                        href={`${selectedChain.explorerUrl}/address/${factoryAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 underline block"
                      >
                        {factoryAddress}
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
      setResults([...updatedResults]);

      // Fetch module names and update modules display
      if (modules.length > 0) {
        // Use sequential requests instead of concurrent with delays to avoid rate limiting
        const fetchModulesSequentially = async () => {
          const moduleDetails = [];
          const modulesToFetch = modules.slice(0, 3);

          for (let i = 0; i < modulesToFetch.length; i++) {
            const moduleAddr = modulesToFetch[i];

            // Add delay between requests (except for the first one)
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 700)); // 0.7 second delay between sequential calls
            }

            // Fetching contract name for module
            const name = await getContractName(moduleAddr, selectedChain);
            // Got contract name for module

            moduleDetails.push({
              address: moduleAddr,
              name: name
            });
          }

          return moduleDetails;
        };

        fetchModulesSequentially().then(moduleDetails => {
          setResults(currentResults => {
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
          setResults(currentResults => {
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
        setResults(currentResults => {
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
              status: 'warning',
              message: 'Could not determine last transaction date'
            };
          }
          return newResults;
        });
      });

      // Update Owner Activity Analysis when ready
      ownerActivityPromise.then(({ activeOwners, inactiveOwners, errorOwners }) => {
        setResults(currentResults => {
          const newResults = [...currentResults];

          if (errorOwners.length === owners.length) {
            // All owners had errors, likely due to missing API key or unsupported chain
            newResults[12] = {
              title: 'Owner Activity Analysis',
              status: 'warning',
              message: 'Could not analyze owner activity (Explorer API key required)'
            };
          } else if (activeOwners.length === 0) {
            // All owners are inactive (good)
            newResults[12] = {
              title: 'Owner Activity Analysis',
              status: 'success',
              message: `All ${inactiveOwners.length} owner${inactiveOwners.length === 1 ? '' : 's'} may be used exclusively for multisig signing (no recent non-multisig transactions).`
            };
          } else {
            // Some owners are active (not ideal)
            newResults[12] = {
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
        setResults(currentResults => {
          const newResults = [...currentResults];

          // Check if result is an error object
          if (typeof guardResult === 'object' && guardResult !== null && 'error' in guardResult) {
            // Handle different types of errors
            if (guardResult.error === 'UNSUPPORTED_VERSION') {
              newResults[9] = {
                title: 'Transaction Guard',
                status: 'warning',
                message: 'Could not check transaction guard status (Safe version too old for Safe SDK support)'
              };
            } else {
              newResults[9] = {
                title: 'Transaction Guard',
                status: 'warning',
                message: 'Could not check transaction guard status (requires Safe SDK support)'
              };
            }
          } else if (guardResult === '0x0000000000000000000000000000000000000000' || guardResult === '') {
            // No guard enabled (good)
            newResults[9] = {
              title: 'Transaction Guard',
              status: 'success',
              message: 'No transaction guard enabled. Uses standard Safe transaction execution.'
            };
          } else {
            // Guard enabled (warning - requires review)
            newResults[9] = {
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
        setResults(currentResults => {
          const newResults = [...currentResults];

          // Check if result is an error object
          if (typeof fallbackHandlerResult === 'object' && fallbackHandlerResult !== null && 'error' in fallbackHandlerResult) {
            // Handle different types of errors
            if (fallbackHandlerResult.error === 'UNSUPPORTED_VERSION') {
              newResults[10] = {
                title: 'Fallback Handler',
                status: 'warning',
                message: 'Could not check fallback handler status (Safe version too old for Safe SDK support)'
              };
            } else {
              newResults[10] = {
                title: 'Fallback Handler',
                status: 'warning',
                message: 'Could not check fallback handler status (requires Safe SDK support)'
              };
            }
          } else if (fallbackHandlerResult === '0x0000000000000000000000000000000000000000' || fallbackHandlerResult === '') {
            // No fallback handler enabled (good)
            newResults[10] = {
              title: 'Fallback Handler',
              status: 'success',
              message: 'No fallback handler enabled. Uses standard Safe functionality only.'
            };
          } else {
            // Check if it's a known official Safe fallback handler
            const handlerName = OFFICIAL_SAFE_FALLBACK_HANDLERS[fallbackHandlerResult.toLowerCase()];

            if (handlerName) {
              // Known official fallback handler (good)
              newResults[10] = {
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
              newResults[10] = {
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
        setResults(currentResults => {
          const newResults = [...currentResults];

          if (totalDeployments === 0) {
            // Should not happen as we already verified the contract exists
            newResults[11] = {
              title: 'Chain Configuration',
              status: 'error',
              message: 'Could not verify Safe deployment on any chain'
            };
          } else if (totalDeployments === 1) {
            // Safe only deployed on one chain (good)
            newResults[11] = {
              title: 'Chain Configuration',
              status: 'success',
              message: `Safe is deployed only on ${selectedChain.name}. No multi-chain deployment detected.`
            };

            // Skip Multi-Chain Signer Analysis for single-chain deployments
            newResults[15] = {
              title: 'Multi-Chain Signer Analysis',
              status: 'success',
              message: 'Not applicable - Safe is only deployed on one chain.'
            };
          } else {
            // Safe deployed on multiple chains (warning - replay risk)
            const chainNames = deployedChains.map(chain => chain.name).join(', ');
            newResults[11] = {
              title: 'Chain Configuration',
              status: 'warning',
              message: (
                <div>
                  <div>⚠️ Multi-chain deployment detected. Not an issue on its own, but this Safe exists on {totalDeployments} chains with the same address.</div>
                  <div className="mt-1 sm:mt-2">
                    <div className="font-medium text-sm sm:text-base">Deployed on:</div>
                    <div className="ml-1 sm:ml-2 text-sm sm:text-base">{chainNames}</div>
                  </div>
                </div>
              )
            };

            // Trigger multi-chain signer reuse analysis
            newResults[15] = {
              title: 'Multi-Chain Signer Analysis',
              status: 'loading',
              message: 'Analyzing signer reuse across chains...'
            };

            // Perform multi-chain signer analysis
            checkMultiChainSignerReuse(addressToAnalyze, deployedChains).then(({ reusedSigners, signerChains }) => {
              setResults(currentResults => {
                const updatedResults = [...currentResults];

                if (reusedSigners.length === 0) {
                  // No signer reuse detected (good)
                  updatedResults[15] = {
                    title: 'Multi-Chain Signer Analysis',
                    status: 'success',
                    message: '✅ No signer address appears on different chains. Each chain has unique signers.'
                  };
                } else {
                  // Signer reuse detected (warning)
                  updatedResults[15] = {
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
              setResults(currentResults => {
                const updatedResults = [...currentResults];
                updatedResults[15] = {
                  title: 'Multi-Chain Signer Analysis',
                  status: 'error',
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
        setResults(currentResults => {
          const newResults = [...currentResults];
          newResults[11] = {
            title: 'Chain Configuration',
            status: 'warning',
            message: 'Could not complete multi-chain deployment check'
          };
          return newResults;
        });
      });

      // Update Signing Speed Analysis (skip for 1-of-N — single signer always has zero
      // duration, and the threshold check already penalizes this configuration)
      if (thresholdNum > 1) {
        fetchSigningSpeedData(addressToAnalyze, selectedChain.id).then(speedData => {
          setResults(currentResults => {
            const newResults = [...currentResults];

            if (speedData.error) {
              // Error fetching data
              newResults[0] = {
                title: 'Signing Speed Analysis',
                status: 'warning',
                message: `Could not analyze signing speed: ${speedData.error}`
              };
            } else if (speedData.avgDuration !== null) {
              // Determine status based on average duration
              // < 10 min = error (too fast), < 6 hours = warning, >= 6 hours = success
              const status = speedData.avgDuration < 600 ? 'error' :
                            speedData.avgDuration < 21600 ? 'warning' : 'success';

              newResults[0] = {
                title: 'Signing Speed Analysis',
                status,
                message: (
                  <SpeedTest
                    address={addressToAnalyze}
                    chainId={selectedChain.id}
                    chainName={selectedChain.name}
                    explorerUrl={selectedChain.explorerUrl}
                  />
                )
              };
            } else {
              // No data available
              newResults[0] = {
                title: 'Signing Speed Analysis',
                status: 'warning',
                message: 'No transaction data available for signing speed analysis'
              };
            }

            return newResults;
          });
        });
      } else {
        setResults(currentResults => {
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
        setResults(currentResults => {
          const newResults = [...currentResults];

          if (!hasRecoveryModule) {
            // No recovery module (neutral - not necessarily bad)
            newResults[13] = {
              title: 'Emergency Recovery Mechanisms',
              status: 'warning',
              message: 'No recovery module detected. Consider implementing social recovery or guardian mechanisms for emergency access.'
            };
          } else {
            // Recovery module exists - assess configuration
            if (thresholdComparison === 'lower') {
              // Recovery threshold is lower than normal - potential security risk
              newResults[13] = {
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
              newResults[13] = {
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
              newResults[13] = {
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
              newResults[13] = {
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
        setResults(currentResults => {
          const newResults = [...currentResults];
          newResults[13] = {
            title: 'Emergency Recovery Mechanisms',
            status: 'warning',
            message: 'Could not check recovery mechanisms'
          };
          return newResults;
        });
      });

      // Update Contract Signers when ready
      contractSignersPromise.then(contractSigners => {
        setResults(currentResults => {
          const newResults = [...currentResults];

          if (contractSigners.length === 0) {
            // All signers are EOAs (good)
            newResults[14] = {
              title: 'Contract Signers',
              status: 'success',
              message: 'No multisig signers are contracts. All signers are externally owned accounts (EOAs).'
            };
          } else {
            // Some signers are contracts (warning)
            const contractList = contractSigners.length > 3
              ? contractSigners.slice(0, 3).join(', ') + ` and ${contractSigners.length - 3} more`
              : contractSigners.join(', ');

            newResults[14] = {
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

  const showToast = () => {
    setShowShareToast(true);
    setIsToastFading(false);

    // Start fade out after 1 second
    setTimeout(() => {
      setIsToastFading(true);
    }, 1000);

    // Completely hide after fade completes
    setTimeout(() => {
      setShowShareToast(false);
      setIsToastFading(false);
    }, 1500);
  };



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
                  {/* Show loading indicator when some results are still loading */}
                  {results.some(r => r.status === 'loading') && (
                    <div className="flex items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Analyzing...</span>
                    </div>
                  )}
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
                                {penalty.isCritical && (
                                  <span className="rounded bg-[var(--color-error)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--color-error)]">
                                    Critical
                                  </span>
                                )}
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
                            <p className="mb-1 font-medium text-[var(--color-text-primary)]">How scoring works:</p>
                            <ul className="space-y-1">
                              <li className="flex items-center gap-1.5">
                                <ShieldAlert className="h-3 w-3 text-[var(--color-error)]" />
                                <span><strong>Critical checks</strong> (Signer Threshold, Threshold Percentage): Errors cost 18-20 points</span>
                              </li>
                              <li className="flex items-center gap-1.5">
                                <Shield className="h-3 w-3 text-[var(--color-warning)]" />
                                <span><strong>Standard checks</strong>: Errors cost 8-15 points</span>
                              </li>
                              <li className="flex items-center gap-1.5">
                                <span className="rounded-full bg-[var(--color-error)]/10 px-1.5 py-0 text-[10px] font-medium text-[var(--color-error)]">x2</span>
                                <span>Multiple critical issues incur additional penalties</span>
                              </li>
                            </ul>
                          </div>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Results List */}
          <div className="space-y-3">
            {results
            .filter(result => result && result.status && result.title)
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
                        result.status === 'error' && "bg-[var(--color-error-bg)] border-[var(--color-error)]/30"
                      )}>
                        {result.status !== 'success' && (
                          <div className="mb-2">
                            <span className="text-xs text-[var(--color-text-tertiary)]">
                              Score impact: -{result.status === 'error' ? speedPenaltyConfig.error : speedPenaltyConfig.warning} points (Heavily weighted)
                            </span>
                          </div>
                        )}
                        {result.message}
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
                  result.status === 'loading' && "bg-[var(--color-primary-100)] border-[var(--color-primary)]/30"
                )}
              >
                <div className="flex items-start gap-4">
                  <div className="flex items-center justify-center w-6 h-6 shrink-0">
                    {result.status === 'success' && <CheckCircle className="h-5 w-5 text-[var(--color-success)]" />}
                    {result.status === 'warning' && <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" />}
                    {result.status === 'error' && <XCircle className="h-5 w-5 text-[var(--color-error)]" />}
                    {result.status === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={cn(
                        "font-semibold",
                        result.status === 'success' && "text-[var(--color-success)]",
                        result.status === 'warning' && "text-[var(--color-warning)]",
                        result.status === 'error' && "text-[var(--color-error)]",
                        result.status === 'loading' && "text-[var(--color-primary)]"
                      )}>{result.title}</h3>
                      
                      {/* Criticality Badge - only show for critical tests */}
                      {penaltyConfig.isCritical && (
                        <span 
                          className="inline-flex items-center gap-1 rounded-full bg-[var(--color-error)]/10 px-2 py-0.5 text-xs font-medium text-[var(--color-error)]"
                          title="Critical security check - failures have major impact on score"
                        >
                          <ShieldAlert className="h-3 w-3" />
                          Critical
                        </span>
                      )}
                      
                      <button
                        onClick={() => setOpenTooltip(isTooltipOpen ? null : index)}
                        className={cn(
                          "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/20 rounded-full p-1 transition-colors",
                          result.status === 'success' && "text-[var(--color-success)]/70 hover:text-[var(--color-success)]",
                          result.status === 'warning' && "text-[var(--color-warning)]/70 hover:text-[var(--color-warning)]",
                          result.status === 'error' && "text-[var(--color-error)]/70 hover:text-[var(--color-error)]",
                          result.status === 'loading' && "text-[var(--color-primary)]/70 hover:text-[var(--color-primary)]"
                        )}
                        aria-label="Show information"
                      >
                        <Info className="h-4 w-4" />
                      </button>
                    </div>
                    
                    {/* Show penalty info for non-success results */}
                    {result.status !== 'success' && result.status !== 'loading' && (
                      <div className="mt-1.5 text-xs text-[var(--color-text-tertiary)]">
                        Score impact: -{result.status === 'error' ? penaltyConfig.error : penaltyConfig.warning} points
                        {penaltyConfig.isCritical && ' (Critical)'}
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
