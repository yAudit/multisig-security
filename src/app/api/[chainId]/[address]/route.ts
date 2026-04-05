import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, isAddress, getAddress } from 'viem';
import { multicall } from 'viem/actions';
import { GNOSIS_SAFE_ABI, OFFICIAL_SAFE_FALLBACK_HANDLERS, OFFICIAL_SAFE_PROXY_FACTORIES, SAFE_VERSIONS_WITH_KNOWN_FACTORIES } from '@/constants/contracts';
import { SUPPORTED_CHAINS } from '@/constants/chains';

interface SecurityCheck {
  id: string;
  title: string;
  status: 'success' | 'warning' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

interface ApiResponse {
  address: string;
  chainId: number;
  chainName: string;
  analyzedAt: string;
  success: boolean;
  error?: string;
  safeInfo?: {
    version: string;
    threshold: number;
    owners: string[];
    nonce: number;
    modules: string[];
    guard: string;
    fallbackHandler: string;
  };
  securityScore?: {
    score: number;
    rating: 'High Risk' | 'Medium Risk' | 'Low Risk';
    position: number;
    description: string;
    penalties: { title: string; points: number; isCritical: boolean }[];
    criticalCount: number;
  };
  checks?: SecurityCheck[];
}

// Explorer API endpoints for different chains
// Note: All chains now use the unified Etherscan V2 API as per chain configuration
const EXPLORER_APIS = {
  1: 'https://api.etherscan.io/v2/api',
  8453: 'https://api.etherscan.io/v2/api', 
  42161: 'https://api.etherscan.io/v2/api',
  10: 'https://api.etherscan.io/v2/api',
  137: 'https://api.etherscan.io/v2/api',
  747474: null // Katana doesn't have explorer API
};

// GitHub API for latest Safe version
const GITHUB_API = 'https://api.github.com/repos/safe-global/safe-smart-account/releases';

// Cache for Safe version info (24-hour TTL)
const safeVersionCache: { latestVersion: string | null; fetchedAt: number } = {
  latestVersion: null,
  fetchedAt: 0,
};
const SAFE_VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chainId: string; address: string }> }
) {
  const { chainId, address } = await params;
  
  // Validate chain
  const chain = SUPPORTED_CHAINS.find(c => c.id.toString() === chainId);
  if (!chain) {
    const errorResponse: ApiResponse = {
      address,
      chainId: parseInt(chainId),
      chainName: 'Unknown',
      analyzedAt: new Date().toISOString(),
      success: false,
      error: `Unsupported chain ID: ${chainId}. Supported chains: ${SUPPORTED_CHAINS.map(c => c.id).join(', ')}`
    };
    return NextResponse.json(errorResponse, { status: 400 });
  }

  // Validate address format
  if (!isAddress(address)) {
    const errorResponse: ApiResponse = {
      address,
      chainId: parseInt(chainId),
      chainName: chain.name,
      analyzedAt: new Date().toISOString(),
      success: false,
      error: 'Invalid Ethereum address format'
    };
    return NextResponse.json(errorResponse, { status: 400 });
  }

  try {
    const createClient = (useBackup = false) => {
      const rpcUrl = useBackup ? chain.backupRpcUrl : chain.rpcUrl;
      return createPublicClient({
        chain: chain.viemChain,
        transport: http(rpcUrl)
      });
    };

    const executeWithBackup = async <T,>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      operation: (client: any) => Promise<T>
    ): Promise<T> => {
      try {
        const primaryClient = createClient();
        return await operation(primaryClient);
      } catch (primaryError) {
        try {
          const backupClient = createClient(true);
          return await operation(backupClient);
        } catch (backupError) {
          console.error(`Both primary and backup RPC failed for ${chain.name}:`, primaryError, backupError);
          throw primaryError;
        }
      }
    };

    // Check if address is a contract
    const code = await executeWithBackup((client) => {
      return client.getBytecode({ address: address as `0x${string}` });
    });
    if (!code || code === '0x') {
      const errorResponse: ApiResponse = {
        address,
        chainId: parseInt(chainId),
        chainName: chain.name,
        analyzedAt: new Date().toISOString(),
        success: false,
        error: 'Address is not a contract'
      };
      return NextResponse.json(errorResponse, { status: 400 });
    }

    const readSafeCoreIndividually = async () => {
      const version = await executeWithBackup((client) => {
        return client.readContract({
          address: address as `0x${string}`,
          abi: GNOSIS_SAFE_ABI,
          functionName: 'VERSION',
        });
      });

      const threshold = await executeWithBackup((client) => {
        return client.readContract({
          address: address as `0x${string}`,
          abi: GNOSIS_SAFE_ABI,
          functionName: 'getThreshold',
        });
      });

      const owners = await executeWithBackup((client) => {
        return client.readContract({
          address: address as `0x${string}`,
          abi: GNOSIS_SAFE_ABI,
          functionName: 'getOwners',
        });
      });

      const nonce = await executeWithBackup((client) => {
        return client.readContract({
          address: address as `0x${string}`,
          abi: GNOSIS_SAFE_ABI,
          functionName: 'nonce',
        });
      });

      let modules: string[] = [];
      try {
        const [moduleArray] = await executeWithBackup<[string[], string]>((client) => {
          return client.readContract({
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'getModulesPaginated',
            args: ['0x0000000000000000000000000000000000000001', 10n],
          });
        });
        modules = moduleArray as string[];
      } catch {
        // Optional modules might not be supported on older Safe versions.
      }

      let guard = '0x0000000000000000000000000000000000000000';
      try {
        guard = await executeWithBackup((client) => {
          return client.readContract({
            address: address as `0x${string}`,
            abi: [{"inputs":[],"name":"getGuard","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}],
            functionName: 'getGuard',
            args: [],
          });
        });
      } catch {
        // Guard is optional.
      }

      let fallbackHandler = '0x0000000000000000000000000000000000000000';
      try {
        fallbackHandler = await executeWithBackup((client) => {
          return client.readContract({
            address: address as `0x${string}`,
            abi: [{"inputs":[],"name":"getFallbackHandler","outputs":[{"internalType":"address","name":"handler","type":"address"}],"stateMutability":"view","type":"function"}],
            functionName: 'getFallbackHandler',
            args: [],
          });
        });
      } catch {
        // Fallback handler is optional.
      }

      return {
        version: version as string,
        threshold: Number(threshold),
        owners: owners as string[],
        nonce: Number(nonce),
        modules,
        guard: guard as string,
        fallbackHandler: fallbackHandler as string
      };
    };

    // Prepare multicall for Safe data - including guard and fallback handler
    let version = '';
    let threshold = 0;
    let owners: string[] = [];
    let nonce = 0;
    let modules: string[] = [];
    let guard = '0x0000000000000000000000000000000000000000';
    let fallbackHandler = '0x0000000000000000000000000000000000000000';

    try {
      const multicallData = await executeWithBackup((client) => {
        return multicall(client, {
          contracts: [
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
              args: ['0x0000000000000000000000000000000000000001', 10n],
            },
            // Add guard and fallback handler calls
            {
              address: address as `0x${string}`,
              abi: [{"inputs":[],"name":"getGuard","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}],
              functionName: 'getGuard',
              args: [],
            },
            {
              address: address as `0x${string}`,
              abi: [{"inputs":[],"name":"getFallbackHandler","outputs":[{"internalType":"address","name":"handler","type":"address"}],"stateMutability":"view","type":"function"}],
              functionName: 'getFallbackHandler',
              args: [],
            },
          ],
          allowFailure: true,
        });
      });

      // Extract results
      const [versionResult, thresholdResult, ownersResult, nonceResult, modulesResult, guardResult, fallbackHandlerResult] = multicallData;

      if (
        versionResult.status !== 'success' ||
        thresholdResult.status !== 'success' ||
        ownersResult.status !== 'success' ||
        nonceResult.status !== 'success'
      ) {
        throw new Error('Multicall returned partial failures');
      }

      version = versionResult.result as string;
      threshold = Number(thresholdResult.result);
      owners = ownersResult.result as string[];
      nonce = Number(nonceResult.result);
      modules = modulesResult.status === 'success' ? (modulesResult.result as [string[], string])[0] : [];
      guard = guardResult.status === 'success' ? guardResult.result as string : '0x0000000000000000000000000000000000000000';
      fallbackHandler = fallbackHandlerResult.status === 'success' ? fallbackHandlerResult.result as string : '0x0000000000000000000000000000000000000000';
    } catch (multicallError) {
      try {
        const safeCore = await readSafeCoreIndividually();
        version = safeCore.version;
        threshold = safeCore.threshold;
        owners = safeCore.owners;
        nonce = safeCore.nonce;
        modules = safeCore.modules;
        guard = safeCore.guard;
        fallbackHandler = safeCore.fallbackHandler;
      } catch (fallbackError) {
        const errorResponse: ApiResponse = {
          address,
          chainId: parseInt(chainId),
          chainName: chain.name,
          analyzedAt: new Date().toISOString(),
          success: false,
          error: `Address does not appear to be a valid Gnosis Safe contract${multicallError instanceof Error ? ` (${multicallError.message})` : ''}`
        };
        return NextResponse.json(errorResponse, { status: 400 });
      }
    }

    // Perform all 16 security checks
    const checks = await performAllSecurityChecks({
      address,
      chainId: parseInt(chainId),
      chain,
      version,
      threshold,
      owners,
      nonce,
      modules,
      guard,
      fallbackHandler,
      client: createClient()
    });

    const securityScore = calculateSecurityScore(checks);

    const successResponse: ApiResponse = {
      address,
      chainId: parseInt(chainId),
      chainName: chain.name,
      analyzedAt: new Date().toISOString(),
      success: true,
      safeInfo: {
        version,
        threshold,
        owners,
        nonce,
        modules,
        guard,
        fallbackHandler
      },
      securityScore: {
        score: securityScore.score,
        rating: securityScore.rating,
        position: securityScore.position,
        description: securityScore.description,
        penalties: securityScore.penalties,
        criticalCount: securityScore.criticalCount
      },
      checks
    };

    return NextResponse.json(successResponse);

  } catch (error) {
    const errorResponse: ApiResponse = {
      address,
      chainId: parseInt(chainId),
      chainName: chain.name,
      analyzedAt: new Date().toISOString(),
      success: false,
      error: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

// Safe Transaction Service API URLs
const SAFE_TX_API_URLS: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global',
  56: 'https://safe-transaction-bsc.safe.global',
  137: 'https://safe-transaction-polygon.safe.global',
  42161: 'https://safe-transaction-arbitrum.safe.global',
  10: 'https://safe-transaction-optimism.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  747474: 'https://safe-transaction-katana.safe.global',
};

// Check signing speed by analyzing confirmation timestamps
async function checkSigningSpeed(address: string, chainId: number): Promise<SecurityCheck> {
  const baseUrl = SAFE_TX_API_URLS[chainId];
  if (!baseUrl) {
    return {
      id: 'signing_speed_analysis',
      title: 'Signing Speed Analysis',
      status: 'warning',
      message: 'Could not analyze signing speed: Unsupported chain',
    };
  }

  try {
    const checksummedAddress = getAddress(address);
    const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/multisig-transactions/?executed=true&limit=10&ordering=-executionDate`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      return {
        id: 'signing_speed_analysis',
        title: 'Signing Speed Analysis',
        status: 'warning',
        message: `Could not analyze signing speed: API error ${response.status}`,
      };
    }

    const data = await response.json();
    const transactions = data.results || [];

    if (!transactions.length) {
      return {
        id: 'signing_speed_analysis',
        title: 'Signing Speed Analysis',
        status: 'warning',
        message: 'No transaction data available for signing speed analysis',
      };
    }

    let totalDuration = 0;
    let validTxCount = 0;

    for (const tx of transactions) {
      const confirmations = tx.confirmations || [];
      if (!confirmations.length) continue;

      const sorted = [...confirmations].sort((a: { submissionDate?: string }, b: { submissionDate?: string }) =>
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
      return {
        id: 'signing_speed_analysis',
        title: 'Signing Speed Analysis',
        status: 'warning',
        message: 'No valid transaction timing data',
      };
    }

    const avgDuration = totalDuration / validTxCount;
    // < 10 min = error (too fast, indicates centralization), < 6 hours = warning, >= 6 hours = success
    const status = avgDuration < 600 ? 'error' : avgDuration < 21600 ? 'warning' : 'success';

    const formatDuration = (seconds: number): string => {
      if (seconds < 60) return `${Math.round(seconds)} seconds`;
      if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
      if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hours`;
      return `${(seconds / 86400).toFixed(1)} days`;
    };

    const message = status === 'error'
      ? `Signatures collected very quickly (avg ${formatDuration(avgDuration)} across ${validTxCount} transactions). This may indicate centralized control.`
      : status === 'warning'
        ? `Moderate signing speed (avg ${formatDuration(avgDuration)} across ${validTxCount} transactions).`
        : `Healthy signing speed (avg ${formatDuration(avgDuration)} across ${validTxCount} transactions). Signatures are collected over a reasonable timeframe.`;

    return {
      id: 'signing_speed_analysis',
      title: 'Signing Speed Analysis',
      status,
      message,
      details: { avgDurationSeconds: avgDuration, transactionsAnalyzed: validTxCount },
    };
  } catch (error) {
    return {
      id: 'signing_speed_analysis',
      title: 'Signing Speed Analysis',
      status: 'warning',
      message: `Could not analyze signing speed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// Check if the Safe was deployed by an official proxy factory
async function checkSafeFactory(address: string, chainId: number, safeVersion: string): Promise<SecurityCheck> {
  const baseUrl = SAFE_TX_API_URLS[chainId];
  const versionHasKnownFactories = SAFE_VERSIONS_WITH_KNOWN_FACTORIES.has(safeVersion);

  if (!baseUrl) {
    return {
      id: 'safe_factory',
      title: 'Safe Factory',
      status: 'warning',
      message: 'Could not determine deployment factory: Unsupported chain',
    };
  }

  try {
    const checksummedAddress = getAddress(address);
    const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/creation/`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
      return {
        id: 'safe_factory',
        title: 'Safe Factory',
        status: 'warning',
        message: 'Could not determine deployment factory.',
      };
    }

    const data = await response.json();
    const factoryAddress = data.factoryAddress;

    if (!factoryAddress) {
      return {
        id: 'safe_factory',
        title: 'Safe Factory',
        status: 'warning',
        message: 'Could not determine deployment factory.',
      };
    }

    const factoryInfo = OFFICIAL_SAFE_PROXY_FACTORIES[factoryAddress.toLowerCase()] || null;

    if (factoryInfo) {
      return {
        id: 'safe_factory',
        title: 'Safe Factory',
        status: 'success',
        message: `Deployed by official factory: ${factoryInfo.name}`,
        details: { factoryAddress, factoryName: factoryInfo.name, isOfficial: true },
      };
    }

    return {
      id: 'safe_factory',
      title: 'Safe Factory',
      status: versionHasKnownFactories ? 'error' : 'warning',
      message: versionHasKnownFactories
        ? 'Deployed by unrecognized factory. Verify this Safe was not created with modified code.'
        : 'Deployed by unrecognized factory. No known official factories for this Safe version, so this may be expected.',
      details: { factoryAddress, isOfficial: false, versionHasKnownFactories },
    };
  } catch (error) {
    return {
      id: 'safe_factory',
      title: 'Safe Factory',
      status: 'warning',
      message: `Could not determine deployment factory: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// Perform all 16 security checks
async function performAllSecurityChecks(params: {
  address: string;
  chainId: number;
  chain: unknown;
  version: string;
  threshold: number;
  owners: string[];
  nonce: number;
  modules: string[];
  guard: string;
  fallbackHandler: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
}) {
  const { address, chainId, version, threshold, owners, nonce, modules, guard, fallbackHandler, client } = params;
  const checks: SecurityCheck[] = [];

  // 1. Signing Speed Analysis
  const signingSpeedCheck = await checkSigningSpeed(address, chainId);
  checks.push(signingSpeedCheck);

  // 2. Signer Threshold
  checks.push({
    id: 'signer_threshold',
    title: 'Signer Threshold',
    status: threshold === 1 ? 'error' : threshold <= 3 ? 'warning' : 'success',
    message: threshold === 1 
      ? `Single signature requirement is insecure. Only ${threshold} signature is required to execute transactions.`
      : threshold <= 3 
        ? `Low signature threshold detected. ${threshold} signatures are required to execute transactions.`
        : `Good signature threshold. ${threshold} signatures are required to execute transactions.`,
    details: { threshold, owners: owners.length }
  });

  // 3. Signer Threshold Percentage
  const thresholdPercentage = owners.length > 0 ? (threshold / owners.length) * 100 : 0;
  checks.push({
    id: 'signer_threshold_percentage',
    title: 'Signer Threshold Percentage',
    status: thresholdPercentage < 34 ? 'error' : thresholdPercentage < 51 ? 'warning' : 'success',
    message: thresholdPercentage < 34
      ? `Low threshold percentage: only ${thresholdPercentage.toFixed(1)}% of owners (${threshold}/${owners.length}) required. Consider increasing signer threshold or reducing owners.`
      : thresholdPercentage < 51
        ? `Moderate threshold: ${thresholdPercentage.toFixed(1)}% of owners (${threshold}/${owners.length}) required for transactions.`
        : `Strong threshold: ${thresholdPercentage.toFixed(1)}% of owners (${threshold}/${owners.length}) required for transactions.`,
    details: { percentage: thresholdPercentage }
  });

  // 4. Safe Version
  const versionCheck = await checkSafeVersion(version);
  checks.push(versionCheck);

  // 5. Contract Creation Date
  const creationDateCheck = await checkContractCreationDate(address, chainId);
  checks.push(creationDateCheck);

  // 6. Multisig Nonce
  checks.push({
    id: 'multisig_nonce',
    title: 'Multisig Nonce',
    status: nonce <= 3 ? 'error' : nonce <= 10 ? 'warning' : 'success',
    message: nonce <= 3
      ? `Very low usage: only ${nonce} transaction${nonce !== 1 ? 's' : ''} executed.`
      : nonce <= 10
        ? `Low usage: ${nonce} transactions executed.`
        : `Active usage: ${nonce} transactions executed.`,
    details: { nonce }
  });

  // 7. Last Transaction Date
  const lastTransactionCheck = await checkLastTransactionDate(address, chainId, nonce);
  checks.push(lastTransactionCheck);

  // 8. Safe Factory
  const factoryCheck = await checkSafeFactory(address, chainId, version);
  checks.push(factoryCheck);

  // 9. Optional Modules
  checks.push({
    id: 'optional_modules',
    title: 'Optional Modules',
    status: modules.length === 0 ? 'success' : 'warning',
    message: modules.length === 0 
      ? 'No optional modules are enabled. Uses standard Safe functionality only.'
      : `${modules.length} module${modules.length === 1 ? '' : 's'} enabled. Review module security.`,
    details: { modules, count: modules.length }
  });

  // 10. Transaction Guard
  checks.push({
    id: 'transaction_guard',
    title: 'Transaction Guard',
    status: guard === '0x0000000000000000000000000000000000000000' ? 'success' : 'warning',
    message: guard === '0x0000000000000000000000000000000000000000'
      ? 'No transaction guard enabled. Uses standard Safe transaction execution.'
      : `Transaction guard is enabled. Review guard contract security.`,
    details: { guard }
  });

  // 11. Fallback Handler
  const isOfficialHandler = OFFICIAL_SAFE_FALLBACK_HANDLERS[fallbackHandler];
  const fallbackStatus = fallbackHandler === '0x0000000000000000000000000000000000000000' 
    ? 'success' : isOfficialHandler ? 'success' : 'warning';
  checks.push({
    id: 'fallback_handler',
    title: 'Fallback Handler',
    status: fallbackStatus,
    message: fallbackHandler === '0x0000000000000000000000000000000000000000'
      ? 'No fallback handler enabled. Uses standard Safe functionality only.'
      : isOfficialHandler
        ? `✅ Known Safe fallback handler enabled: ${isOfficialHandler}`
        : '⚠️ Custom fallback handler enabled. Review handler contract security.',
    details: { fallbackHandler, isOfficial: !!isOfficialHandler }
  });

  // 12. Chain Configuration
  const multiChainCheck = await checkMultiChainDeployment(address, chainId);
  checks.push(multiChainCheck);

  // 13. Owner Activity Analysis
  const ownerActivityCheck = await checkOwnerActivity(owners);
  checks.push(ownerActivityCheck);

  // 14. Emergency Recovery Mechanisms
  const recoveryCheck = await checkEmergencyRecovery(modules);
  checks.push(recoveryCheck);

  // 15. Contract Signers
  const contractSignersCheck = await checkContractSigners(owners, client);
  checks.push(contractSignersCheck);

  // 16. Multi-Chain Signer Analysis
  const multiChainSignerCheck = await checkMultiChainSigners(address, owners, chainId);
  checks.push(multiChainSignerCheck);

  return checks;
}

// Helper function to get API key from environment
function getApiKey(): string | null {
  return process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY || null;
}

// Check Safe version against GitHub releases
async function checkSafeVersion(version: string): Promise<SecurityCheck> {
  try {
    let latestVersion: string;

    if (safeVersionCache.latestVersion && Date.now() - safeVersionCache.fetchedAt < SAFE_VERSION_CACHE_TTL_MS) {
      latestVersion = safeVersionCache.latestVersion;
    } else {
      const response = await fetch(GITHUB_API);
      if (!response.ok) throw new Error('GitHub API error');

      const releases = await response.json();
      if (!releases || releases.length === 0) throw new Error('No releases found');

      latestVersion = releases[0].tag_name.replace('v', '');
      safeVersionCache.latestVersion = latestVersion;
      safeVersionCache.fetchedAt = Date.now();
    }
    
    // Simple version comparison - would need proper semver comparison in production
    const isLatest = version === latestVersion;
    const versionParts = version.split('.').map(Number);
    const latestParts = latestVersion.split('.').map(Number);
    
    const majorDiff = latestParts[0] - versionParts[0];
    const minorDiff = latestParts[1] - versionParts[1];
    
    let status: 'success' | 'warning' | 'error' = 'error';
    let message = '';
    
    if (isLatest) {
      status = 'success';
      message = `Latest version: ${version} (current latest: ${latestVersion})`;
    } else if (majorDiff === 0 && minorDiff <= 2) {
      status = 'warning';
      message = `Acceptable version: ${version} (latest: ${latestVersion})`;
    } else {
      status = 'error';
      message = `Outdated version: ${version} (latest: ${latestVersion})`;
    }

    return {
      id: 'safe_version',
      title: 'Safe Version',
      status,
      message,
      details: { version, latestVersion }
    };
  } catch {
    return {
      id: 'safe_version',
      title: 'Safe Version',
      status: 'warning' as const,
      message: `Could not check version: ${version}`,
      details: { version }
    };
  }
}

// Check contract creation date via Explorer API
async function checkContractCreationDate(address: string, chainId: number): Promise<SecurityCheck> {
  const apiKey = getApiKey();
  const apiUrl = EXPLORER_APIS[chainId as keyof typeof EXPLORER_APIS];
  
  if (!apiUrl || !apiKey) {
    return {
      id: 'contract_creation_date',
      title: 'Contract Creation Date',
      status: 'warning' as const,
      message: 'Could not determine contract creation date (API not available)',
      details: {}
    };
  }

  try {
    const url = `${apiUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.result || data.result.length === 0) {
      throw new Error('No transactions found');
    }

    const creationTx = data.result[0];
    const creationDate = new Date(parseInt(creationTx.timeStamp) * 1000);
    const daysAgo = Math.floor((Date.now() - creationDate.getTime()) / (1000 * 60 * 60 * 24));

    let status: 'success' | 'warning' | 'error' = 'success';
    let message = '';

    if (daysAgo <= 7) {
      status = 'error';
      message = `Very recently deployed (${daysAgo} days ago). New contracts carry higher risk.`;
    } else if (daysAgo <= 60) {
      status = 'warning';
      message = `Recently deployed (${daysAgo} days ago). Relatively new contract.`;
    } else {
      status = 'success';
      message = `Established contract deployed ${daysAgo} days ago.`;
    }

    return {
      id: 'contract_creation_date',
      title: 'Contract Creation Date',
      status,
      message,
      details: { daysAgo, creationDate: creationDate.toISOString() }
    };
  } catch {
    return {
      id: 'contract_creation_date',
      title: 'Contract Creation Date',
      status: 'warning' as const,
      message: 'Could not determine contract creation date',
      details: {}
    };
  }
}

// Check last transaction date
async function checkLastTransactionDate(address: string, chainId: number, nonce: number): Promise<SecurityCheck> {
  if (nonce === 0) {
    return {
      id: 'last_transaction_date',
      title: 'Last Transaction Date',
      status: 'warning' as const,
      message: 'No transactions found. This Safe has never been used.',
      details: { nonce }
    };
  }

  const apiKey = getApiKey();
  const apiUrl = EXPLORER_APIS[chainId as keyof typeof EXPLORER_APIS];
  
  if (!apiUrl || !apiKey) {
    return {
      id: 'last_transaction_date',
      title: 'Last Transaction Date',
      status: 'warning' as const,
      message: 'Could not determine last transaction date (API not available)',
      details: {}
    };
  }

  try {
    const url = `${apiUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=desc&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.result || data.result.length === 0) {
      throw new Error('No transactions found');
    }

    const lastTx = data.result[0];
    const lastDate = new Date(parseInt(lastTx.timeStamp) * 1000);
    const daysAgo = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

    let status: 'success' | 'warning' | 'error' = 'success';
    let message = '';

    if (daysAgo >= 90) {
      status = 'error';
      message = `Inactive for ${daysAgo} days. Last transaction: ${lastDate.toDateString()}`;
    } else if (daysAgo >= 31) {
      status = 'warning';
      message = `Last used ${daysAgo} days ago on ${lastDate.toDateString()}`;
    } else {
      status = 'success';
      message = `Recently active. Last transaction: ${lastDate.toDateString()} (${daysAgo} days ago)`;
    }

    return {
      id: 'last_transaction_date',
      title: 'Last Transaction Date',
      status,
      message,
      details: { daysAgo, lastDate: lastDate.toISOString() }
    };
  } catch {
    return {
      id: 'last_transaction_date',
      title: 'Last Transaction Date',
      status: 'warning' as const,
      message: 'Could not determine last transaction date',
      details: {}
    };
  }
}

// Check multi-chain deployment
async function checkMultiChainDeployment(address: string, currentChainId: number): Promise<SecurityCheck> {
  let deployedChains = 0;
  const chainNames: string[] = [];

  // Check each supported chain
  for (const chain of SUPPORTED_CHAINS) {
    if (chain.id === currentChainId) {
      deployedChains++;
      chainNames.push(chain.name);
      continue;
    }

    try {
      const client = createPublicClient({
        chain: chain.viemChain,
        transport: http(chain.rpcUrl)
      });

      const code = await client.getBytecode({ address: address as `0x${string}` });
      if (code && code !== '0x') {
        // Verify it's actually a Safe
        try {
          const versionResult = await client.readContract({
            address: address as `0x${string}`,
            abi: GNOSIS_SAFE_ABI,
            functionName: 'VERSION',
          });
          if (versionResult) {
            deployedChains++;
            chainNames.push(chain.name);
          }
        } catch {
          // Not a Safe contract
        }
      }
    } catch {
      // Chain connection failed
    }
  }

  if (deployedChains === 1) {
    return {
      id: 'chain_configuration',
      title: 'Chain Configuration',
      status: 'success' as const,
      message: `Safe is deployed only on ${chainNames[0]}. No multi-chain deployment detected.`,
      details: { deployedChains, chainNames }
    };
  } else if (deployedChains > 1) {
    return {
      id: 'chain_configuration',
      title: 'Chain Configuration',
      status: 'warning' as const,
      message: `⚠️ Multi-chain deployment detected. Safe exists on ${deployedChains} chains: ${chainNames.join(', ')}`,
      details: { deployedChains, chainNames }
    };
  } else {
    return {
      id: 'chain_configuration',
      title: 'Chain Configuration',
      status: 'error' as const,
      message: 'Could not verify Safe deployment on any chain',
      details: { deployedChains, chainNames }
    };
  }
}

// Check owner activity (simplified - would need full implementation)
async function checkOwnerActivity(owners: string[]): Promise<SecurityCheck> {
  return {
    id: 'owner_activity_analysis',
    title: 'Owner Activity Analysis',
    status: 'warning' as const,
    message: 'Could not analyze owner activity (requires Explorer API implementation)',
    details: { ownerCount: owners.length }
  };
}

// Check emergency recovery mechanisms
async function checkEmergencyRecovery(modules: string[]): Promise<SecurityCheck> {
  if (modules.length === 0) {
    return {
      id: 'emergency_recovery_mechanisms',
      title: 'Emergency Recovery Mechanisms',
      status: 'warning' as const,
      message: 'No recovery module detected. Consider implementing social recovery or guardian mechanisms for emergency access.',
      details: { modules }
    };
  }

  const hasRecoveryModule = modules.length > 0; // Simplified check

  return {
    id: 'emergency_recovery_mechanisms',
    title: 'Emergency Recovery Mechanisms',
    status: hasRecoveryModule ? 'success' as const : 'warning' as const,
    message: hasRecoveryModule 
      ? 'Recovery module detected. Review configuration carefully.'
      : 'No recovery module detected. Consider implementing social recovery or guardian mechanisms for emergency access.',
    details: { modules, moduleCount: modules.length }
  };
}

// Check contract signers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkContractSigners(owners: string[], client: any): Promise<SecurityCheck> {
  const contractSigners: string[] = [];

  for (const owner of owners) {
    try {
      const code = await client.getBytecode({ address: owner as `0x${string}` });
      if (code && code !== '0x' && code.length > 2) {
        contractSigners.push(owner);
      }
    } catch {
      // Assume EOA if check fails
    }
  }

  if (contractSigners.length === 0) {
    return {
      id: 'contract_signers',
      title: 'Contract Signers',
      status: 'success' as const,
      message: 'No multisig signers are contracts. All signers are externally owned accounts (EOAs).',
      details: { contractSigners, totalOwners: owners.length }
    };
  } else {
    return {
      id: 'contract_signers',
      title: 'Contract Signers',
      status: 'warning' as const,
      message: `${contractSigners.length} signer${contractSigners.length === 1 ? '' : 's'} ${contractSigners.length === 1 ? 'is' : 'are'} contract${contractSigners.length === 1 ? '' : 's'}, not EOA${contractSigners.length === 1 ? '' : 's'}. Need to recursively check those signers.`,
      details: { contractSigners, totalOwners: owners.length }
    };
  }
}

// Check multi-chain signer analysis
async function checkMultiChainSigners(address: string, owners: string[], currentChainId: number): Promise<SecurityCheck> {
  // Simplified implementation - would need full multi-chain analysis
  return {
    id: 'multi_chain_signer_analysis',
    title: 'Multi-Chain Signer Analysis',
    status: 'success' as const,
    message: 'Not applicable - requires multi-chain deployment analysis',
    details: { currentChain: currentChainId }
  };
}

// Test penalty configuration - matches web app's Cumulative Risk Penalty algorithm
const TEST_PENALTIES: Record<string, { error: number; warning: number; isCritical: boolean }> = {
  'Threshold': { error: 20, warning: 10, isCritical: true },
  'Signer Threshold': { error: 20, warning: 10, isCritical: true },
  'Owner Count': { error: 18, warning: 9, isCritical: true },
  'Signer Threshold Percentage': { error: 18, warning: 9, isCritical: true },
  'Fallback Handler': { error: 14, warning: 6, isCritical: false },
  'Proxy Implementation': { error: 18, warning: 8, isCritical: true },
  'Guard': { error: 12, warning: 5, isCritical: false },
  'Transaction Guard': { error: 12, warning: 5, isCritical: false },
  'Modules': { error: 12, warning: 5, isCritical: false },
  'Optional Modules': { error: 12, warning: 5, isCritical: false },
  'Contract Version': { error: 10, warning: 4, isCritical: false },
  'Safe Version': { error: 10, warning: 4, isCritical: false },
  'Signing Speed Analysis': { error: 16, warning: 8, isCritical: false },
  'Owner Balance': { error: 6, warning: 3, isCritical: false },
  'Duplicate Owners': { error: 6, warning: 3, isCritical: false },
  'Etherscan Verification': { error: 4, warning: 2, isCritical: false },
  'Emergency Recovery Mechanisms': { error: 2, warning: 1, isCritical: false },
  'Contract Signers': { error: 2, warning: 1, isCritical: false },
  'Safe Factory': { error: 10, warning: 4, isCritical: false },
  'Chain Configuration': { error: 2, warning: 1, isCritical: false },
};

const DEFAULT_PENALTY = { error: 8, warning: 4, isCritical: false };

// Calculate security score (same algorithm as web app - Cumulative Risk Penalty)
function calculateSecurityScore(checks: SecurityCheck[]) {
  let score = 100;
  let criticalFailures = 0;
  let criticalWarnings = 0;
  const penalties: { title: string; points: number; isCritical: boolean }[] = [];

  for (const check of checks) {
    const config = TEST_PENALTIES[check.title] || DEFAULT_PENALTY;

    if (check.status === 'error') {
      score -= config.error;
      penalties.push({ title: check.title, points: config.error, isCritical: config.isCritical });
      if (config.isCritical) criticalFailures++;
    } else if (check.status === 'warning') {
      score -= config.warning;
      penalties.push({ title: check.title, points: config.warning, isCritical: config.isCritical });
      if (config.isCritical) criticalWarnings++;
    }
  }

  // Compounding penalty for multiple critical issues
  const totalCriticalIssues = criticalFailures + criticalWarnings;
  if (totalCriticalIssues >= 3) {
    score -= 8;
    penalties.push({ title: 'Multiple Critical Issues', points: 8, isCritical: true });
  }
  if (totalCriticalIssues >= 5) {
    score -= 10;
    penalties.push({ title: 'Severe Critical Issues', points: 10, isCritical: true });
  }

  const rawScore = Math.max(0, Math.min(100, score));

  // Position on slider with curve that emphasizes good vs bad
  let position: number;
  if (rawScore >= 65) {
    position = 66 + (rawScore - 65) * 0.83;
  } else if (rawScore >= 40) {
    position = 33 + (rawScore - 40) * 1.28;
  } else {
    position = 5 + rawScore * 0.72;
  }
  position = Math.max(5, Math.min(95, position));

  let rating: 'High Risk' | 'Medium Risk' | 'Low Risk';
  let description: string;

  if (rawScore >= 65) {
    rating = 'Low Risk';
    description = 'Your Safe follows security best practices with minimal issues.';
  } else if (rawScore >= 40) {
    rating = 'Medium Risk';
    description = 'Your Safe has moderate security risks that should be addressed.';
  } else {
    rating = 'High Risk';
    description = 'Your Safe has significant security risks that need immediate attention.';
  }

  return { score: rawScore, rating, position, description, penalties: penalties.sort((a, b) => b.points - a.points), criticalCount: totalCriticalIssues };
}
