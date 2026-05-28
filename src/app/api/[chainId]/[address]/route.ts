import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, http, isAddress, getAddress } from 'viem';
import type { PublicClient } from 'viem';
import { multicall } from 'viem/actions';
import { GNOSIS_SAFE_ABI, OFFICIAL_SAFE_FALLBACK_HANDLERS, OFFICIAL_SAFE_PROXY_FACTORIES, OFFICIAL_SAFE_SINGLETONS, SENTINEL_MODULES_ADDRESS, GUARD_STORAGE_SLOT, FALLBACK_HANDLER_STORAGE_SLOT, EIP7702_DELEGATION_PREFIX, SAFE_EXEC_TX_METHOD_ID, KNOWN_RECOVERY_MODULE_KEYWORDS } from '@/constants/contracts';
import { SUPPORTED_CHAINS, SAFE_TX_SERVICE_URLS, SAFE_GITHUB_RELEASES_URL, isBlockscout, buildExplorerApiUrl } from '@/constants/chains';
import { calculateSecurityScore } from '@/lib/scoring';
import { ZERO_ADDRESS, ZERO_SLOT, extractAddressFromSlot, isContractRevertError, FETCH_TIMEOUT_MS, getEtherscanApiKey } from '@/lib/utils';
import { CHECK_TITLES } from '@/lib/checkTitles';
import { SIGNING_SPEED_ERROR_SECONDS, SIGNING_SPEED_WARNING_SECONDS, INACTIVITY_ERROR_DAYS, INACTIVITY_WARNING_DAYS, CONTRACT_AGE_ERROR_DAYS, CONTRACT_AGE_WARNING_DAYS, NONCE_ERROR_MAX, NONCE_WARNING_MAX, THRESHOLD_LOW_ABSOLUTE, THRESHOLD_MAJORITY_PCT, THRESHOLD_LOW_PCT, SAFE_VERSION_CACHE_TTL_MS } from '@/lib/thresholds';

// Security check thresholds


// Cache for Safe version info (24-hour TTL)
const safeVersionCache: {
  latestVersion: string | null;
  secondLatestVersion: string | null;
  latestReleaseDate: Date | null;
  fetchedAt: number;
} = { latestVersion: null, secondLatestVersion: null, latestReleaseDate: null, fetchedAt: 0 };

interface SecurityCheck {
  id: string;
  title: string;
  status: 'success' | 'warning' | 'error' | 'unavailable';
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
    guard: string | null;
    fallbackHandler: string | null;
  };
  securityScore?: {
    score: number;
    rating: 'High Risk' | 'Medium Risk' | 'Low Risk';
    position: number;
    description: string;
    penalties: { title: string; points: number }[];
    completedChecks: number;
    totalChecks: number;
    unavailableChecks: number;
  };
  checks?: SecurityCheck[];
}

// Helper to get explorer API URL for a chain
const getExplorerApiUrl = (chainId: number): string | null => {
  return SUPPORTED_CHAINS.find(c => c.id === chainId)?.explorerApiUrl ?? null;
};

function checkVersionFormat(version: string): boolean {
  const parts = version.split('.');
  return parts.length === 3 && parts.every(p => /^\d+$/.test(p));
}

function compareVersionStrings(a: string, b: string): number {
  const [majorA, minorA, patchA] = a.split('.').map(Number);
  const [majorB, minorB, patchB] = b.split('.').map(Number);
  if (majorA !== majorB) return majorA - majorB;
  if (minorA !== minorB) return minorA - minorB;
  return patchA - patchB;
}

type VersionCategory = 'latest' | 'second-latest' | 'old' | 'very-old' | 'future';

function categorizeVersion(
  version: string,
  latestVersion: string | null,
  secondLatestVersion: string | null,
  latestReleaseDate: Date | null,
): VersionCategory {
  if (!latestVersion) {
    if (version === '1.4.1') return 'latest';
    const [major, minor] = version.split('.').map(Number);
    if (major === 1 && minor >= 3 && minor <= 4) return 'old';
    return 'very-old';
  }

  if (version === latestVersion) return 'latest';

  if (secondLatestVersion && version === secondLatestVersion && latestReleaseDate) {
    const daysSinceLatestRelease = (Date.now() - latestReleaseDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLatestRelease < 365) return 'second-latest';
  }

  const [major, minor, patch] = version.split('.').map(Number);
  const [latestMajor, latestMinor, latestPatch] = latestVersion.split('.').map(Number);

  if (major < latestMajor) return 'very-old';
  if (major > latestMajor) return 'future';
  if (minor < latestMinor) {
    return (latestMinor - minor <= 2) ? 'old' : 'very-old';
  }
  if (minor > latestMinor) return 'future';
  if (patch < latestPatch) return 'old';
  if (patch > latestPatch) return 'future';
  return 'latest';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chainId: string; address: string }> }
) {
  const { chainId, address } = await params;

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
        transport: http(rpcUrl, { timeout: 15000 })
      });
    };

    const executeWithBackup = async <T,>(
      operation: (client: PublicClient) => Promise<T>
    ): Promise<T> => {
      try {
        const primaryClient = createClient();
        return await operation(primaryClient);
      } catch (primaryError) {
        try {
          const backupClient = createClient(true);
          return await operation(backupClient);
        } catch (backupError) {
          if (isContractRevertError(primaryError) || isContractRevertError(backupError)) {
            throw primaryError;
          }
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

    // Verify the contract is actually a Safe multisig
    try {
      await executeWithBackup((client) => {
        return client.readContract({
          address: address as `0x${string}`,
          abi: GNOSIS_SAFE_ABI,
          functionName: 'VERSION',
        });
      });
    } catch (versionError) {
      if (isContractRevertError(versionError) || (versionError instanceof Error && /revert|does not appear/i.test(versionError.message))) {
        const errorResponse: ApiResponse = {
          address,
          chainId: parseInt(chainId),
          chainName: chain.name,
          analyzedAt: new Date().toISOString(),
          success: false,
          error: 'This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.'
        };
        return NextResponse.json(errorResponse, { status: 400 });
      }
    }

    const readSafeCoreIndividually = async () => {
      const version = await executeWithBackup((client) => {
        return client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'VERSION' });
      });
      const threshold = await executeWithBackup((client) => {
        return client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getThreshold' });
      });
      const owners = await executeWithBackup((client) => {
        return client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getOwners' });
      });
      const nonce = await executeWithBackup((client) => {
        return client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'nonce' });
      });
      let modules: string[] = [];
      try {
        const [moduleArray] = await executeWithBackup<[string[], string]>((client) => {
          return client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL_MODULES_ADDRESS, 10n] });
        });
        modules = moduleArray as string[];
      } catch {}
      let guard: string | null = null;
      try {
        const guardSlot = await executeWithBackup<`0x${string}` | undefined>((client) => {
          return client.getStorageAt({ address: address as `0x${string}`, slot: GUARD_STORAGE_SLOT as `0x${string}` });
        });
        guard = extractAddressFromSlot(guardSlot) || ZERO_ADDRESS;
      } catch {}
      let fallbackHandler: string | null = null;
      try {
        const fallbackSlot = await executeWithBackup<`0x${string}` | undefined>((client) => {
          return client.getStorageAt({ address: address as `0x${string}`, slot: FALLBACK_HANDLER_STORAGE_SLOT as `0x${string}` });
        });
        fallbackHandler = extractAddressFromSlot(fallbackSlot);
      } catch {}
      return { version: version as string, threshold: Number(threshold), owners: owners as string[], nonce: Number(nonce), modules, guard: guard as string, fallbackHandler: fallbackHandler as string };
    };

    // Prepare multicall for Safe data
    let version = '';
    let threshold = 0;
    let owners: string[] = [];
    let nonce = 0;
    let modules: string[] = [];
    let guard: string | null = null;
    let fallbackHandler: string | null = null;

    try {
      const [multicallData, guardSlotValue, fallbackSlotValue] = await executeWithBackup((client) => {
        return Promise.all([
          multicall(client, {
            contracts: [
              { address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'VERSION' },
              { address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getThreshold' },
              { address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getOwners' },
              { address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'nonce' },
              { address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL_MODULES_ADDRESS, 10n] },
            ],
            allowFailure: true,
          }),
          client.getStorageAt({ address: address as `0x${string}`, slot: GUARD_STORAGE_SLOT as `0x${string}` }),
          client.getStorageAt({ address: address as `0x${string}`, slot: FALLBACK_HANDLER_STORAGE_SLOT as `0x${string}` }),
        ]);
      });

      const [versionResult, thresholdResult, ownersResult, nonceResult, modulesResult] = multicallData;

      if (versionResult.status !== 'success' || thresholdResult.status !== 'success' || ownersResult.status !== 'success' || nonceResult.status !== 'success') {
        throw new Error('Multicall returned partial failures');
      }

      version = versionResult.result as string;
      threshold = Number(thresholdResult.result);
      owners = ownersResult.result as string[];
      nonce = Number(nonceResult.result);
      modules = modulesResult.status === 'success' && Array.isArray(modulesResult.result) && Array.isArray(modulesResult.result[0])
        ? [...modulesResult.result[0]] as string[]
        : [];
      guard = extractAddressFromSlot(guardSlotValue) || ZERO_ADDRESS;
      fallbackHandler = extractAddressFromSlot(fallbackSlotValue);
    } catch (multicallError) {
      if (isContractRevertError(multicallError) || (multicallError instanceof Error && /revert|does not appear/i.test(multicallError.message))) {
        const errorResponse: ApiResponse = { address, chainId: parseInt(chainId), chainName: chain.name, analyzedAt: new Date().toISOString(), success: false, error: 'This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.' };
        return NextResponse.json(errorResponse, { status: 400 });
      }
      try {
        const safeCore = await readSafeCoreIndividually();
        version = safeCore.version; threshold = safeCore.threshold; owners = safeCore.owners; nonce = safeCore.nonce; modules = safeCore.modules; guard = safeCore.guard; fallbackHandler = safeCore.fallbackHandler;
      } catch (fallbackError) {
        if (isContractRevertError(fallbackError) || (fallbackError instanceof Error && /revert|does not appear/i.test(fallbackError.message))) {
          const errorResponse: ApiResponse = { address, chainId: parseInt(chainId), chainName: chain.name, analyzedAt: new Date().toISOString(), success: false, error: 'This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.' };
          return NextResponse.json(errorResponse, { status: 400 });
        }
        const errorResponse: ApiResponse = { address, chainId: parseInt(chainId), chainName: chain.name, analyzedAt: new Date().toISOString(), success: false, error: `Analysis failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}` };
        return NextResponse.json(errorResponse, { status: 500 });
      }
    }

    // Perform all 16 security checks
    const checks = await performAllSecurityChecks({
      address, chainId: parseInt(chainId), version, threshold, owners, nonce, modules, guard, fallbackHandler, client: createClient()
    });

    const securityScore = calculateSecurityScore(checks);

    const successResponse: ApiResponse = {
      address, chainId: parseInt(chainId), chainName: chain.name, analyzedAt: new Date().toISOString(), success: true,
      safeInfo: { version, threshold, owners, nonce, modules, guard, fallbackHandler },
      securityScore: { score: securityScore.rawScore, rating: securityScore.rating, position: securityScore.position, description: securityScore.description, penalties: securityScore.penalties, completedChecks: securityScore.completedChecks, totalChecks: securityScore.totalChecks, unavailableChecks: securityScore.unavailableChecks },
      checks
    };

    return NextResponse.json(successResponse);

  } catch (error) {
    if (isContractRevertError(error) || (error instanceof Error && /revert|does not appear/i.test(error.message))) {
      const errorResponse: ApiResponse = { address, chainId: parseInt(chainId), chainName: chain.name, analyzedAt: new Date().toISOString(), success: false, error: 'This address is a contract but does not appear to be a Gnosis Safe multisig. Only Safe multisig addresses are supported.' };
      return NextResponse.json(errorResponse, { status: 400 });
    }
    const errorResponse: ApiResponse = { address, chainId: parseInt(chainId), chainName: chain.name, analyzedAt: new Date().toISOString(), success: false, error: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

// ──────────────────────────────────────────────
// Check functions
// ──────────────────────────────────────────────

async function performAllSecurityChecks(params: {
  address: string; chainId: number; version: string; threshold: number; owners: string[];
  nonce: number; modules: string[]; guard: string | null; fallbackHandler: string | null; client: PublicClient;
}): Promise<SecurityCheck[]> {
  const { address, chainId, version, threshold, owners, nonce, modules, guard, fallbackHandler, client } = params;

  const thresholdPct = owners.length > 0 ? (threshold / owners.length) * 100 : 0;
  const thresholdStatus: SecurityCheck['status'] = threshold === 0 || threshold === 1 ? 'error' : threshold <= THRESHOLD_LOW_ABSOLUTE && thresholdPct < THRESHOLD_MAJORITY_PCT ? 'warning' : 'success';
  const pctStatus: SecurityCheck['status'] = thresholdPct < THRESHOLD_LOW_PCT ? 'error' : thresholdPct < THRESHOLD_MAJORITY_PCT ? 'warning' : 'success';
  const nonceStatus: SecurityCheck['status'] = nonce <= NONCE_ERROR_MAX ? 'error' : nonce <= NONCE_WARNING_MAX ? 'warning' : 'success';

  const guardCheck: SecurityCheck = guard === null
    ? { id: 'transaction_guard', title: CHECK_TITLES.TRANSACTION_GUARD, status: 'unavailable', message: 'Could not check transaction guard status' }
    : guard === ZERO_ADDRESS || guard === ''
      ? { id: 'transaction_guard', title: CHECK_TITLES.TRANSACTION_GUARD, status: 'success', message: 'No transaction guard enabled. Uses standard Safe transaction execution.', details: { guard } }
      : { id: 'transaction_guard', title: CHECK_TITLES.TRANSACTION_GUARD, status: 'warning', message: 'Transaction guard is enabled. Review guard contract security.', details: { guard } };

  const isOfficialHandler = fallbackHandler && OFFICIAL_SAFE_FALLBACK_HANDLERS[fallbackHandler.toLowerCase()];
  const fbStatus: SecurityCheck['status'] = fallbackHandler === null
    ? 'unavailable'
    : (fallbackHandler === ZERO_ADDRESS || fallbackHandler === '') ? 'success' : isOfficialHandler ? 'success' : 'warning';

  // Run all async checks in parallel
  const [
    signingSpeedCheck,
    safeVersionCheck,
    contractCreationCheck,
    lastTransactionCheck,
    singletonIntegrityCheck,
    multiChainResult,
    ownerActivityCheck,
    emergencyRecoveryCheck,
    contractSignersCheck,
  ] = await Promise.all([
    threshold > 1 ? checkSigningSpeed(address, chainId) : Promise.resolve({ id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status: 'success' as const, message: 'Signing speed analysis skipped for single-signer Safe (threshold is 1).' }),
    checkSafeVersion(version),
    checkContractCreationDate(address, chainId),
    checkLastTransactionDate(address, chainId, nonce),
    checkSingletonIntegrity(address, chainId),
    checkMultiChainDeployment(address, chainId),
    checkOwnerActivity(owners, chainId),
    checkEmergencyRecovery(modules, threshold, chainId, client),
    checkContractSigners(owners, client),
  ]);

  // Multi-Chain Signer depends on chain config result
  const multiChainSignerCheck = await checkMultiChainSigners(address, owners, chainId, multiChainResult.deployedChainIds);

  return [
    signingSpeedCheck,
    { id: 'signer_threshold', title: CHECK_TITLES.SIGNER_THRESHOLD, status: thresholdStatus, message: threshold === 1 ? `Single signature requirement is insecure. Only ${threshold} signature is required to execute transactions.` : thresholdStatus === 'warning' ? `Low signature threshold detected. ${threshold} of ${owners.length} signatures required to execute transactions.` : `Good signature threshold. ${threshold} of ${owners.length} signatures required to execute transactions.`, details: { threshold, owners: owners.length } },
    { id: 'signer_threshold_percentage', title: CHECK_TITLES.SIGNER_THRESHOLD_PCT, status: pctStatus, message: thresholdPct < 34 ? `Low threshold percentage: only ${thresholdPct.toFixed(1)}% of owners (${threshold}/${owners.length}) required. Consider increasing signer threshold or reducing owners.` : thresholdPct < 51 ? `Moderate threshold: ${thresholdPct.toFixed(1)}% of owners (${threshold}/${owners.length}) required for transactions.` : `Strong threshold: ${thresholdPct.toFixed(1)}% of owners (${threshold}/${owners.length}) required for transactions.`, details: { percentage: thresholdPct } },
    safeVersionCheck,
    contractCreationCheck,
    { id: 'multisig_nonce', title: CHECK_TITLES.MULTISIG_NONCE, status: nonceStatus, message: nonce <= NONCE_ERROR_MAX ? `Very low usage: only ${nonce} transaction${nonce !== 1 ? 's' : ''} executed.` : nonce <= NONCE_WARNING_MAX ? `Low usage: ${nonce} transactions executed.` : `Active usage: ${nonce} transactions executed.`, details: { nonce } },
    lastTransactionCheck,
    singletonIntegrityCheck,
    { id: 'optional_modules', title: CHECK_TITLES.OPTIONAL_MODULES, status: modules.length === 0 ? 'success' : 'warning', message: modules.length === 0 ? 'No optional modules are enabled. Uses standard Safe functionality only.' : `${modules.length} module${modules.length === 1 ? '' : 's'} enabled. Review module security.`, details: { modules, count: modules.length } },
    guardCheck,
    { id: 'fallback_handler', title: CHECK_TITLES.FALLBACK_HANDLER, status: fbStatus, message: fallbackHandler === null ? 'Could not check fallback handler status' : (fallbackHandler === ZERO_ADDRESS || fallbackHandler === '') ? 'No fallback handler enabled. Uses standard Safe functionality only.' : isOfficialHandler ? `Known Safe fallback handler enabled: ${isOfficialHandler}` : 'Custom fallback handler enabled. Review handler contract security.', details: { fallbackHandler, isOfficial: !!isOfficialHandler } },
    multiChainResult.check,
    ownerActivityCheck,
    emergencyRecoveryCheck,
    contractSignersCheck,
    multiChainSignerCheck,
  ];
}

// 1. Signing Speed
async function checkSigningSpeed(address: string, chainId: number): Promise<SecurityCheck> {
  const baseUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (!baseUrl) return { id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status: 'unavailable', message: 'Could not analyze signing speed: Unsupported chain' };

  try {
    const checksummedAddress = getAddress(address);
    const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/multisig-transactions/?executed=true&limit=10&ordering=-executionDate`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return { id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status: 'unavailable', message: `Could not analyze signing speed: API error ${response.status}` };

    const data = await response.json();
    const transactions = data.results || [];
    if (!transactions.length) return { id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status: 'unavailable', message: 'No transaction data available for signing speed analysis' };

    let totalDuration = 0;
    let validTxCount = 0;
    for (const tx of transactions) {
      const confirmations = tx.confirmations || [];
      if (!confirmations.length) continue;
      const sorted = [...confirmations].sort((a: { submissionDate?: string }, b: { submissionDate?: string }) => (a.submissionDate || '').localeCompare(b.submissionDate || ''));
      const firstTime = sorted[0].submissionDate ? new Date(sorted[0].submissionDate).getTime() : null;
      const lastTime = sorted[sorted.length - 1].submissionDate ? new Date(sorted[sorted.length - 1].submissionDate).getTime() : null;
      if (firstTime && lastTime && !isNaN(firstTime) && !isNaN(lastTime)) {
        totalDuration += (lastTime - firstTime) / 1000;
        validTxCount++;
      }
    }
    if (validTxCount === 0) return { id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status: 'unavailable', message: 'No valid transaction timing data' };

    const avgDuration = totalDuration / validTxCount;
    const status: SecurityCheck['status'] = avgDuration < SIGNING_SPEED_ERROR_SECONDS ? 'error' : avgDuration < SIGNING_SPEED_WARNING_SECONDS ? 'warning' : 'success';
    const fmt = (s: number) => s < 60 ? `${Math.round(s)} seconds` : s < 3600 ? `${Math.round(s / 60)} minutes` : s < 86400 ? `${(s / 3600).toFixed(1)} hours` : `${(s / 86400).toFixed(1)} days`;
    return { id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status, message: status === 'error' ? `Signatures collected very quickly (avg ${fmt(avgDuration)} across ${validTxCount} transactions). This may indicate centralized control.` : status === 'warning' ? `Moderate signing speed (avg ${fmt(avgDuration)} across ${validTxCount} transactions).` : `Healthy signing speed (avg ${fmt(avgDuration)} across ${validTxCount} transactions). Signatures are collected over a reasonable timeframe.`, details: { avgDurationSeconds: avgDuration, transactionsAnalyzed: validTxCount } };
  } catch (error) {
    return { id: 'signing_speed_analysis', title: CHECK_TITLES.SIGNING_SPEED, status: 'unavailable', message: `Could not analyze signing speed: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

// 4. Safe Version (5-category logic matching frontend)
async function checkSafeVersion(version: string): Promise<SecurityCheck> {
  try {
    let latestVersion: string | null;
    let secondLatestVersion: string | null;
    let latestReleaseDate: Date | null;

    if (safeVersionCache.latestVersion && (Date.now() - safeVersionCache.fetchedAt) < SAFE_VERSION_CACHE_TTL_MS) {
      latestVersion = safeVersionCache.latestVersion;
      secondLatestVersion = safeVersionCache.secondLatestVersion;
      latestReleaseDate = safeVersionCache.latestReleaseDate;
    } else {
      const response = await fetch(SAFE_GITHUB_RELEASES_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
      const releases = await response.json();
      if (!Array.isArray(releases) || releases.length === 0) throw new Error('No releases found');

      const validReleases = releases
        .filter((release: { tag_name?: string }) => { if (!release.tag_name) return false; const v = release.tag_name.replace(/^v/, ''); return checkVersionFormat(v); })
        .sort((a: { tag_name: string }, b: { tag_name: string }) => compareVersionStrings(b.tag_name.replace(/^v/, ''), a.tag_name.replace(/^v/, '')));

      latestVersion = validReleases[0] ? validReleases[0].tag_name.replace(/^v/, '') : null;
      secondLatestVersion = validReleases[1] ? validReleases[1].tag_name.replace(/^v/, '') : null;
      latestReleaseDate = validReleases[0] ? new Date(validReleases[0].published_at) : null;

      safeVersionCache.latestVersion = latestVersion;
      safeVersionCache.secondLatestVersion = secondLatestVersion;
      safeVersionCache.latestReleaseDate = latestReleaseDate;
      safeVersionCache.fetchedAt = Date.now();
    }

    const category = categorizeVersion(version, latestVersion, secondLatestVersion, latestReleaseDate);
    const status: SecurityCheck['status'] = (category === 'latest' || category === 'second-latest') ? 'success' : category === 'old' ? 'warning' : 'error';

    let message: string;
    if (category === 'latest') {
      message = `Latest version: ${version}${latestVersion && latestVersion !== version ? ` (current latest: ${latestVersion})` : ''}`;
    } else if (category === 'second-latest') {
      const daysSinceLatestRelease = latestReleaseDate ? Math.floor((Date.now() - latestReleaseDate.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      message = `Second latest version: ${version}. Newest version (${latestVersion}) released ${daysSinceLatestRelease} days ago.`;
    } else if (category === 'future') {
      message = `Unknown future Safe version detected! Version: ${version}${latestVersion ? ` (current latest: ${latestVersion})` : ''}`;
    } else if (category === 'old') {
      message = `Outdated version: ${version}${latestVersion ? ` (latest: ${latestVersion})` : ''}`;
    } else {
      message = `Very outdated version: ${version}${latestVersion ? ` (latest: ${latestVersion})` : ''}`;
    }

    return { id: 'safe_version', title: CHECK_TITLES.SAFE_VERSION, status, message, details: { version, latestVersion, secondLatestVersion, category } };
  } catch {
    const category = categorizeVersion(version, null, null, null);
    const status: SecurityCheck['status'] = (category === 'latest' || category === 'second-latest') ? 'success' : category === 'old' ? 'warning' : 'error';
    const message = category === 'latest'
      ? `Latest version: ${version}`
      : category === 'old'
        ? `Outdated version: ${version}`
        : `Very outdated version: ${version}`;
    return { id: 'safe_version', title: CHECK_TITLES.SAFE_VERSION, status, message, details: { version, category } };
  }
}

// 5. Contract Creation Date (uses Safe Transaction Service as primary source, Etherscan as fallback)
async function checkContractCreationDate(address: string, chainId: number): Promise<SecurityCheck> {
  // 1. Try Safe Transaction Service first (free, no API key needed on most chains)
  const txServiceUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (txServiceUrl) {
    try {
      const checksummedAddress = getAddress(address);
      const url = `${txServiceUrl}/api/v1/safes/${checksummedAddress}/creation/`;
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        const data = await response.json();
        if (data.created) {
          const creationDate = new Date(data.created);
          const daysAgo = Math.floor((Date.now() - creationDate.getTime()) / (1000 * 60 * 60 * 24));
          const status: SecurityCheck['status'] = daysAgo <= CONTRACT_AGE_ERROR_DAYS ? 'error' : daysAgo <= CONTRACT_AGE_WARNING_DAYS ? 'warning' : 'success';
          return { id: 'contract_creation_date', title: CHECK_TITLES.CONTRACT_CREATION_DATE, status, message: status === 'error' ? `Very recently deployed (${daysAgo} days ago). New contracts carry higher risk.` : status === 'warning' ? `Recently deployed (${daysAgo} days ago). Relatively new contract.` : `Established contract deployed ${daysAgo} days ago.`, details: { daysAgo, creationDate: creationDate.toISOString() } };
        }
      }
    } catch {
      // Fall through to Etherscan fallback
    }
  }

  // 2. Fallback: Etherscan/Blockscout explorer API
  const apiUrl = getExplorerApiUrl(chainId);
  const apiKey = getEtherscanApiKey();
  if (!apiUrl || (!apiKey && !isBlockscout(apiUrl))) return { id: 'contract_creation_date', title: CHECK_TITLES.CONTRACT_CREATION_DATE, status: 'unavailable', message: 'Could not determine contract creation date (API not available)' };

  try {
    const apikeyParam = isBlockscout(apiUrl) ? '' : `&apikey=${apiKey}`;
    const url = buildExplorerApiUrl(apiUrl, chainId, {
      module: 'account', action: 'txlist', address,
      startblock: '0', endblock: '99999999', page: '1', offset: '20', sort: 'asc',
    }) + apikeyParam;
    const response = await fetch(url);
    if (!response.ok) return { id: 'contract_creation_date', title: CHECK_TITLES.CONTRACT_CREATION_DATE, status: 'unavailable', message: `Could not determine contract creation date: API error ${response.status}` };

    const data = await response.json();
    if (!data.result || data.result.length === 0) return { id: 'contract_creation_date', title: CHECK_TITLES.CONTRACT_CREATION_DATE, status: 'unavailable', message: 'Could not determine contract creation date: No transactions found' };

    // Find the creation transaction (where 'to' field is empty/null), matching frontend logic
    const creationTx = data.result.find((tx: { to: string | null }) => tx.to === '' || tx.to === null);
    const sourceTx = creationTx || data.result[0];
    const creationDate = new Date(parseInt(sourceTx.timeStamp) * 1000);
    const daysAgo = Math.floor((Date.now() - creationDate.getTime()) / (1000 * 60 * 60 * 24));

    const status: SecurityCheck['status'] = daysAgo <= CONTRACT_AGE_ERROR_DAYS ? 'error' : daysAgo <= CONTRACT_AGE_WARNING_DAYS ? 'warning' : 'success';
    return { id: 'contract_creation_date', title: CHECK_TITLES.CONTRACT_CREATION_DATE, status, message: status === 'error' ? `Very recently deployed (${daysAgo} days ago). New contracts carry higher risk.` : status === 'warning' ? `Recently deployed (${daysAgo} days ago). Relatively new contract.` : `Established contract deployed ${daysAgo} days ago.`, details: { daysAgo, creationDate: creationDate.toISOString() } };
  } catch {
    return { id: 'contract_creation_date', title: CHECK_TITLES.CONTRACT_CREATION_DATE, status: 'unavailable', message: 'Could not determine contract creation date' };
  }
}

// 7. Last Transaction Date (uses Safe Transaction Service as primary source, Etherscan as fallback)
async function checkLastTransactionDate(address: string, chainId: number, nonce: number): Promise<SecurityCheck> {
  if (nonce === 0) return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status: 'warning', message: 'No transactions found. This Safe has never been used.', details: { nonce } };

  // 1. Try Safe Transaction Service first (free, no API key needed on most chains)
  const txServiceUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (txServiceUrl) {
    try {
      const checksummedAddress = getAddress(address);
      const url = `${txServiceUrl}/api/v1/safes/${checksummedAddress}/multisig-transactions/?executed=true&limit=1&ordering=-nonce`;
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        const data = await response.json();
        if (data.results && data.results.length > 0 && data.results[0].executionDate) {
          const lastDate = new Date(data.results[0].executionDate);
          const daysAgo = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
          const status: SecurityCheck['status'] = daysAgo >= INACTIVITY_ERROR_DAYS ? 'error' : daysAgo >= INACTIVITY_WARNING_DAYS ? 'warning' : 'success';
          return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status, message: status === 'error' ? `Inactive for ${daysAgo} days. Last transaction: ${lastDate.toDateString()}.` : status === 'warning' ? `Last used ${daysAgo} days ago on ${lastDate.toDateString()}.` : `Recently active. Last transaction: ${lastDate.toDateString()} (${daysAgo} days ago).`, details: { daysAgo, lastDate: lastDate.toISOString() } };
        }
      }
    } catch {
      // Fall through to Etherscan fallback
    }
  }

  // 2. Fallback: Etherscan/Blockscout explorer API
  const apiUrl = getExplorerApiUrl(chainId);
  const apiKey = getEtherscanApiKey();
  if (!apiUrl || (!apiKey && !isBlockscout(apiUrl))) return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status: 'unavailable', message: 'Could not determine last transaction date (API not available)' };

  try {
    const apikeyParam = isBlockscout(apiUrl) ? '' : `&apikey=${apiKey}`;
    const url = buildExplorerApiUrl(apiUrl, chainId, {
      module: 'account', action: 'txlist', address,
      startblock: '0', endblock: '99999999', page: '1', offset: '1', sort: 'desc',
    }) + apikeyParam;
    const response = await fetch(url);
    if (!response.ok) return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status: 'unavailable', message: `Could not determine last transaction date: API error ${response.status}` };

    const data = await response.json();
    if (!data.result || data.result.length === 0) return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status: 'unavailable', message: 'Could not determine last transaction date: No transactions found' };

    const lastTx = data.result[0];
    const lastDate = new Date(parseInt(lastTx.timeStamp) * 1000);
    const daysAgo = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

    const status: SecurityCheck['status'] = daysAgo >= INACTIVITY_ERROR_DAYS ? 'error' : daysAgo >= INACTIVITY_WARNING_DAYS ? 'warning' : 'success';
    return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status, message: status === 'error' ? `Inactive for ${daysAgo} days. Last transaction: ${lastDate.toDateString()}.` : status === 'warning' ? `Last used ${daysAgo} days ago on ${lastDate.toDateString()}.` : `Recently active. Last transaction: ${lastDate.toDateString()} (${daysAgo} days ago).`, details: { daysAgo, lastDate: lastDate.toISOString() } };
  } catch {
    return { id: 'last_transaction_date', title: CHECK_TITLES.LAST_TRANSACTION_DATE, status: 'unavailable', message: 'Could not determine last transaction date' };
  }
}

// 8. Singleton Integrity
async function checkSingletonIntegrity(address: string, chainId: number): Promise<SecurityCheck> {
  const baseUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (!baseUrl) return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'unavailable', message: 'Could not determine singleton: Unsupported chain' };

  try {
    const checksummedAddress = getAddress(address);
    const url = `${baseUrl}/api/v1/safes/${checksummedAddress}/creation/`;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'unavailable', message: 'Could not determine singleton.' };

    const data = await response.json();
    const masterCopy = data.masterCopy;
    if (!masterCopy) return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'unavailable', message: 'Could not determine singleton.' };

    const chainSingletons = OFFICIAL_SAFE_SINGLETONS[chainId];
    if (!chainSingletons) return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'unavailable', message: 'No singleton registry for this chain.' };

    const singletonName = chainSingletons[masterCopy.toLowerCase()] || null;
    if (singletonName) return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'success', message: `Delegates to official singleton: ${singletonName}`, details: { masterCopy, singletonName, isOfficial: true } };

    const factoryAddress = data.factoryAddress;
    const factoryInfo = OFFICIAL_SAFE_PROXY_FACTORIES[factoryAddress?.toLowerCase()] || null;
    const factoryNote = factoryInfo
      ? ` (deployed by official factory: ${factoryInfo.name}, but singleton is unrecognized)`
      : '';
    return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'error', message: `Unrecognized singleton address.${factoryNote} Verify this Safe was not created with modified code.`, details: { masterCopy, isOfficial: false, factoryAddress, factoryNote } };
  } catch (error) {
    return { id: 'singleton_integrity', title: CHECK_TITLES.SINGLETON_INTEGRITY, status: 'unavailable', message: `Could not determine singleton: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}

// 12. Chain Configuration (parallel chain checks)
async function checkMultiChainDeployment(address: string, currentChainId: number): Promise<{ check: SecurityCheck; deployedChainIds: number[] }> {
  const chainNames: string[] = [];
  const deployedChainIds: number[] = [];
  let deployedChains = 0;

  // Always include current chain
  deployedChains++;
  chainNames.push(SUPPORTED_CHAINS.find(c => c.id === currentChainId)!.name);
  deployedChainIds.push(currentChainId);

  const otherChains = SUPPORTED_CHAINS.filter(c => c.id !== currentChainId);
  const results = await Promise.allSettled(otherChains.map(async (chain) => {
    const client = createPublicClient({ chain: chain.viemChain, transport: http(chain.rpcUrl, { timeout: 15000 }) });
    const code = await client.getBytecode({ address: address as `0x${string}` });
    if (code && code !== '0x') {
      try {
        await client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'VERSION' });
        return chain;
      } catch { return null; }
    }
    return null;
  }));

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      deployedChains++;
      chainNames.push(result.value.name);
      deployedChainIds.push(result.value.id);
    }
  }

  if (deployedChains === 1) return { check: { id: 'chain_configuration', title: CHECK_TITLES.CHAIN_CONFIGURATION, status: 'success', message: `Safe is deployed only on ${chainNames[0]}. No multi-chain deployment detected.`, details: { deployedChains, chainNames } }, deployedChainIds };
  return { check: { id: 'chain_configuration', title: CHECK_TITLES.CHAIN_CONFIGURATION, status: 'success', message: `Multi-chain deployment detected. Safe exists on ${deployedChains} chains: ${chainNames.join(', ')}`, details: { deployedChains, chainNames } }, deployedChainIds };
}

// 13. Owner Activity Analysis (full implementation matching frontend)
async function checkOwnerActivity(owners: string[], chainId: number): Promise<SecurityCheck> {
  const apiUrl = getExplorerApiUrl(chainId);
  const apiKey = getEtherscanApiKey();
  if (!apiUrl || (!apiKey && !isBlockscout(apiUrl))) return { id: 'owner_activity_analysis', title: CHECK_TITLES.OWNER_ACTIVITY, status: 'unavailable', message: 'Could not analyze owner activity (Explorer API key required)', details: { ownerCount: owners.length } };

  const activeOwners: string[] = [];
  const inactiveOwners: string[] = [];
  const errorOwners: string[] = [];

  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    try {
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 250));
      const apikeyParam = isBlockscout(apiUrl) ? '' : `&apikey=${apiKey}`;
      const url = buildExplorerApiUrl(apiUrl, chainId, {
        module: 'account', action: 'txlist', address: owner,
        startblock: '0', endblock: '99999999', page: '1', offset: '10', sort: 'desc',
      }) + apikeyParam;
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { errorOwners.push(owner); continue; }

      const data = await response.json();
      if (data.status === '1' && data.result && data.result.length > 0) {
        const nonMultisigTxs = data.result.filter((tx: { input?: string }) => {
          const methodId = tx.input ? tx.input.slice(0, 10) : '';
          return methodId !== SAFE_EXEC_TX_METHOD_ID;
        });
        if (nonMultisigTxs.length === 0) {
          inactiveOwners.push(owner);
        } else {
          const lastNonMultisigTx = nonMultisigTxs[0];
          const lastTxDate = new Date(parseInt(lastNonMultisigTx.timeStamp) * 1000);
          const daysSinceLastTx = (Date.now() - lastTxDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceLastTx > 90) { inactiveOwners.push(owner); } else { activeOwners.push(owner); }
        }
      } else {
        inactiveOwners.push(owner);
      }
    } catch {
      errorOwners.push(owner);
    }
  }

  if (errorOwners.length === owners.length) return { id: 'owner_activity_analysis', title: CHECK_TITLES.OWNER_ACTIVITY, status: 'unavailable', message: 'Could not analyze owner activity (Explorer API key required)', details: { ownerCount: owners.length, activeOwners, inactiveOwners, errorOwners } };
  if (activeOwners.length === 0) return { id: 'owner_activity_analysis', title: CHECK_TITLES.OWNER_ACTIVITY, status: 'success', message: `All ${inactiveOwners.length} owner${inactiveOwners.length === 1 ? '' : 's'} may be used exclusively for multisig signing (no recent non-multisig transactions).`, details: { ownerCount: owners.length, activeOwners, inactiveOwners, errorOwners } };
  return { id: 'owner_activity_analysis', title: CHECK_TITLES.OWNER_ACTIVITY, status: 'warning', message: `${activeOwners.length} owner${activeOwners.length === 1 ? ' has' : 's have'} recent non-multisig activity. Consider using dedicated signing addresses.`, details: { ownerCount: owners.length, activeOwners, inactiveOwners, errorOwners } };
}

// Fetch a verified contract's name from Etherscan with retry on rate-limit / transient errors.
// Mirrors the frontend's getContractName behavior so the API doesn't silently miss a recovery
// module when Etherscan is throttling.
async function fetchContractName(address: string, chainId: number, apiUrl: string, apiKey: string): Promise<string | null> {
  const apikeyParam = isBlockscout(apiUrl) ? '' : `&apikey=${apiKey}`;
  const url = buildExplorerApiUrl(apiUrl, chainId, {
    module: 'contract', action: 'getsourcecode', address,
  }) + apikeyParam;
  const maxRetries = 5;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) continue;
        if (response.status >= 400 && response.status < 500 && attempt < 2) continue;
        return null;
      }

      const data = await response.json();
      if (data && data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
        const name = data.result[0]?.ContractName;
        if (typeof name === 'string' && name.trim() !== '') return name.trim();
      }
      return null;
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      const maxErrorRetries = isTimeout ? 3 : 2;
      if (attempt < maxErrorRetries) continue;
      return null;
    }
  }
  return null;
}

// 14. Emergency Recovery Mechanisms (full implementation matching frontend)
async function checkEmergencyRecovery(modules: string[], threshold: number, chainId: number, client: PublicClient): Promise<SecurityCheck> {
  if (modules.length === 0) return { id: 'emergency_recovery_mechanisms', title: CHECK_TITLES.EMERGENCY_RECOVERY, status: 'warning', message: 'No recovery module detected. Consider implementing social recovery or guardian mechanisms for emergency access.', details: { modules } };

  const apiUrl = getExplorerApiUrl(chainId);
  const apiKey = getEtherscanApiKey();

  // Fetch all module names in parallel
  const moduleNames = await Promise.all(modules.map(async (moduleAddr) => {
    if (!apiUrl || (!apiKey && !isBlockscout(apiUrl))) return { address: moduleAddr, name: moduleAddr };
    const name = await fetchContractName(moduleAddr, chainId, apiUrl, apiKey || '');
    return { address: moduleAddr, name: name ?? moduleAddr };
  }));

  const recoveryModules: string[] = [];
  for (const { address: moduleAddr, name: moduleName } of moduleNames) {
    const lowerName = moduleName.toLowerCase();
const isRecoveryModule = KNOWN_RECOVERY_MODULE_KEYWORDS.some(keyword => lowerName.includes(keyword));
    if (isRecoveryModule) recoveryModules.push(moduleAddr);
  }

  // Read recovery thresholds for detected recovery modules (in parallel)
  let recoveryThreshold: number | null = null;
  if (recoveryModules.length > 0) {
    const thresholdResults = await Promise.allSettled(recoveryModules.map(async (moduleAddr) => {
      try {
        const result = await client.readContract({
          address: moduleAddr as `0x${string}`,
          abi: [{ inputs: [], name: 'threshold', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }],
          functionName: 'threshold',
        });
        return Number(result);
      } catch { return null; }
    }));
    for (const result of thresholdResults) {
      if (result.status === 'fulfilled' && result.value !== null) {
        recoveryThreshold = result.value;
        break; // Use the first threshold found
      }
    }
  }

  const normalThresholdNum = Number(threshold);

  if (recoveryModules.length === 0) {
    return { id: 'emergency_recovery_mechanisms', title: CHECK_TITLES.EMERGENCY_RECOVERY, status: 'warning', message: 'No recovery module detected. Consider implementing social recovery or guardian mechanisms for emergency access.', details: { modules, moduleCount: modules.length } };
  }

  let thresholdComparison: 'lower' | 'equal' | 'higher' | 'unknown' = 'unknown';
  if (recoveryThreshold !== null) {
    if (recoveryThreshold < normalThresholdNum) thresholdComparison = 'lower';
    else if (recoveryThreshold === normalThresholdNum) thresholdComparison = 'equal';
    else thresholdComparison = 'higher';
  }

  if (thresholdComparison === 'lower') {
    return { id: 'emergency_recovery_mechanisms', title: CHECK_TITLES.EMERGENCY_RECOVERY, status: 'error', message: `Recovery module detected with LOWER threshold than normal operations! Normal: ${normalThresholdNum} signatures, Recovery: ${recoveryThreshold} signatures. Lower recovery threshold could allow easier unauthorized access.`, details: { modules: recoveryModules, moduleCount: recoveryModules.length, recoveryThreshold, normalThreshold: normalThresholdNum, thresholdComparison } };
  }
  if (thresholdComparison === 'equal') {
    return { id: 'emergency_recovery_mechanisms', title: CHECK_TITLES.EMERGENCY_RECOVERY, status: 'success', message: `Recovery module detected with equal threshold to normal operations (${normalThresholdNum} signatures).`, details: { modules: recoveryModules, moduleCount: recoveryModules.length, recoveryThreshold, normalThreshold: normalThresholdNum, thresholdComparison } };
  }
  if (thresholdComparison === 'higher') {
    return { id: 'emergency_recovery_mechanisms', title: CHECK_TITLES.EMERGENCY_RECOVERY, status: 'success', message: `Recovery module detected with HIGHER threshold than normal operations (${recoveryThreshold} vs ${normalThresholdNum} signatures). Very secure.`, details: { modules: recoveryModules, moduleCount: recoveryModules.length, recoveryThreshold, normalThreshold: normalThresholdNum, thresholdComparison } };
  }
  return { id: 'emergency_recovery_mechanisms', title: CHECK_TITLES.EMERGENCY_RECOVERY, status: 'warning', message: `${recoveryModules.length} module${recoveryModules.length === 1 ? '' : 's'} detected. Review module configuration carefully. Could not determine recovery threshold.`, details: { modules: recoveryModules, moduleCount: recoveryModules.length, recoveryThreshold, normalThreshold: normalThresholdNum, thresholdComparison } };
}

// 15. Contract Signers (parallel bytecode checks, with EIP-7702 detection)
async function checkContractSigners(owners: string[], client: PublicClient): Promise<SecurityCheck> {
  // EIP-7702 delegation designator prefix — EOAs with active delegations return
  // bytecode starting with 0xef01 but are still EOAs, not smart contracts.
  interface CodeCheckResult { owner: string; isContract: boolean; isEip7702: boolean }
  const results = await Promise.allSettled(owners.map(async (owner): Promise<CodeCheckResult> => {
    try {
      const code = await client.getBytecode({ address: owner as `0x${string}` });
      if (code && code !== '0x' && code.length > 2) {
        if (code.startsWith(EIP7702_DELEGATION_PREFIX)) {
          return { owner, isContract: false, isEip7702: true };
        }
        return { owner, isContract: true, isEip7702: false };
      }
      return { owner, isContract: false, isEip7702: false };
    } catch { return { owner, isContract: false, isEip7702: false }; }
  }));
  const contractSigners = results.filter((r): r is PromiseFulfilledResult<CodeCheckResult> => r.status === 'fulfilled' && r.value.isContract).map(r => r.value.owner);
  const eip7702Signers = results.filter((r): r is PromiseFulfilledResult<CodeCheckResult> => r.status === 'fulfilled' && r.value.isEip7702).map(r => r.value.owner);

  if (contractSigners.length === 0 && eip7702Signers.length === 0) {
    return { id: 'contract_signers', title: CHECK_TITLES.CONTRACT_SIGNERS, status: 'success', message: 'No multisig signers are contracts. All signers are externally owned accounts (EOAs).', details: { contractSigners, eip7702Signers, totalOwners: owners.length } };
  }
  if (contractSigners.length === 0 && eip7702Signers.length > 0) {
    return { id: 'contract_signers', title: CHECK_TITLES.CONTRACT_SIGNERS, status: 'success', message: `No signers are contracts, but ${eip7702Signers.length} signer${eip7702Signers.length === 1 ? ' has' : 's have'} an active EIP-7702 delegation (EOA with temporary contract code). These remain EOAs controlled by their private keys.`, details: { contractSigners, eip7702Signers, totalOwners: owners.length } };
  }
  const eip7702Note = eip7702Signers.length > 0 ? ` Additionally, ${eip7702Signers.length} signer${eip7702Signers.length === 1 ? ' has' : 's have'} an EIP-7702 delegation (EOA with temporary contract code).` : '';
  return { id: 'contract_signers', title: CHECK_TITLES.CONTRACT_SIGNERS, status: 'warning', message: `${contractSigners.length} signer${contractSigners.length === 1 ? 'is a contract' : 's are contracts'}, not EOA${contractSigners.length === 1 ? '' : 's'}. Need to recursively check those signers.${eip7702Note}`, details: { contractSigners, eip7702Signers, totalOwners: owners.length } };
}

// 16. Multi-Chain Signer Analysis (full implementation matching frontend)
async function checkMultiChainSigners(address: string, owners: string[], currentChainId: number, deployedChainIds: number[]): Promise<SecurityCheck> {
  if (deployedChainIds.length <= 1) return { id: 'multi_chain_signer_analysis', title: CHECK_TITLES.MULTI_CHAIN_SIGNER, status: 'success', message: 'Not applicable — Safe is only deployed on one chain.', details: { currentChain: currentChainId } };

  const signerCounts: Record<string, string[]> = {};
  const allChainOwners: Record<string, string[]> = {};

  const deployedChains = SUPPORTED_CHAINS.filter(c => deployedChainIds.includes(c.id));

  const chainOwnerResults = await Promise.allSettled(deployedChains.map(async (chain) => {
    try {
const client = createPublicClient({ chain: chain.viemChain, transport: http(chain.rpcUrl, { timeout: 15000 }) });
      try {
        const chainOwners = await client.readContract({ address: address as `0x${string}`, abi: GNOSIS_SAFE_ABI, functionName: 'getOwners' }) as string[];
        return { chainName: chain.name, owners: chainOwners };
      } catch { return { chainName: chain.name, owners: [] as string[] }; }
    } catch { return { chainName: chain.name, owners: [] as string[] }; }
  }));

  for (const result of chainOwnerResults) {
    if (result.status === 'fulfilled') {
      const { chainName, owners: chainOwners } = result.value;
      allChainOwners[chainName] = chainOwners;
      for (const owner of chainOwners) {
        const ownerLower = owner.toLowerCase();
        if (!signerCounts[ownerLower]) signerCounts[ownerLower] = [];
        signerCounts[ownerLower].push(chainName);
      }
    }
  }

  const reusedSigners = Object.keys(signerCounts).filter(signer => signerCounts[signer].length > 1);
  if (reusedSigners.length === 0) return { id: 'multi_chain_signer_analysis', title: CHECK_TITLES.MULTI_CHAIN_SIGNER, status: 'success', message: 'No signer address appears on different chains. Each chain has unique signers.', details: { currentChain: currentChainId, reusedSigners: [], signerChains: signerCounts } };
  return { id: 'multi_chain_signer_analysis', title: CHECK_TITLES.MULTI_CHAIN_SIGNER, status: 'warning', message: `${reusedSigners.length} signer${reusedSigners.length === 1 ? '' : 's'} reused between chains. This may increase key compromise risk.`, details: { currentChain: currentChainId, reusedSigners, signerChains: signerCounts } };
}