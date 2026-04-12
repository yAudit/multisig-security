'use client';

import React, { useState, useCallback } from 'react';
import { getAddress } from 'ethers';
import {
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ChevronDown,
  ExternalLink,
  Loader2,
  Zap
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SAFE_TX_SERVICE_URLS } from '../constants/chains';

interface Confirmation {
  owner: string;
  submissionDate: string;
  signature?: string;
  signatureType?: string;
}

interface SafeTransaction {
  safeTxHash: string;
  transactionHash?: string;
  nonce: number;
  submissionDate?: string;
  executionDate?: string;
  confirmations?: Confirmation[];
  confirmationsRequired?: number;
  to: string;
  value: string;
  data?: string;
}

interface Transaction {
  safe_tx_hash: string;
  tx_hash: string;
  nonce: number | string;
  first_signature_time: string;
  last_signature_time: string;
  first_signer: string;
  last_signer: string;
  num_confirmations: number;
  confirmations_required: number;
  used_safe_api: boolean;
  non_standard_sig_types: string[];
  min_gap_seconds: number | null;
  min_gap_formatted: string | null;
  duration_seconds: number;
  duration_formatted: string;
  execution_date: string;
  proposal_to_last_sig_seconds: number;
  proposal_to_last_sig_formatted: string;
}

interface AnalysisResult {
  safe_address: string;
  chain: string;
  total_transactions_analyzed: number;
  average_duration_seconds: number;
  average_duration_formatted: string;
  transactions: Transaction[];
}

interface SpeedTestProps {
  address: string;
  chainId: number;
  chainName: string;
  explorerUrl: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

function parseIsoTimestamp(tsString: string): Date | null {
  if (!tsString) return null;
  try {
    const date = new Date(tsString.replace('Z', '+00:00'));
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function getSpeedClass(durationSeconds: number): { color: string; textColor: string } {
  if (durationSeconds < 600) return { 
    color: "bg-[var(--color-error-bg)] border-[var(--color-error)]/30 text-[var(--color-error)]", 
    textColor: "text-[var(--color-error)]" 
  };
  if (durationSeconds < 3600) return { 
    color: "bg-[var(--color-warning-bg)] border-[var(--color-warning)]/30 text-[var(--color-warning)]", 
    textColor: "text-[var(--color-warning)]" 
  };
  if (durationSeconds < 21600) return { 
    color: "bg-[var(--color-warning-bg)] border-[var(--color-warning)]/30 text-[var(--color-warning)]", 
    textColor: "text-[var(--color-warning)]" 
  };
  return { 
    color: "bg-[var(--color-success-bg)] border-[var(--color-success)]/30 text-[var(--color-success)]", 
    textColor: "text-[var(--color-success)]" 
  };
}

function getRiskAssessment(avgSeconds: number): { 
  className: string; 
  text: string; 
  rating: string; 
  icon: React.ReactNode 
} {
  if (avgSeconds < 600) {
    return {
      className: "high",
      text: "Fast Signing - Average signing time under 10 minutes suggests minimal transaction review",
      rating: "Fast Signing",
      icon: <AlertTriangle className="h-5 w-5" />
    };
  }
  if (avgSeconds < 3600) {
    return {
      className: "medium",
      text: "Moderate Signing - Transactions signed within an hour on average",
      rating: "Moderate Signing",
      icon: <Clock className="h-5 w-5" />
    };
  }
  if (avgSeconds < 21600) {
    return {
      className: "medium",
      text: "Moderate Signing - Transactions signed within 6 hours on average",
      rating: "Moderate Signing",
      icon: <Clock className="h-5 w-5" />
    };
  }
  return {
    className: "low",
    text: "Slow Signing - Adequate time for thorough review and coordination",
    rating: "Slow Signing",
    icon: <CheckCircle className="h-5 w-5" />
  };
}

function getMinGapClass(gapSeconds: number): string {
  if (gapSeconds < 30) return "text-[var(--color-error)]";
  if (gapSeconds < 300) return "text-[var(--color-warning)]";
  if (gapSeconds < 1800) return "text-[var(--color-warning)]";
  return "text-[var(--color-success)]";
}

async function fetchAndAnalyzeSafe(address: string, chainId: number): Promise<AnalysisResult> {
  const apiUrl = SAFE_TX_SERVICE_URLS[chainId];
  if (!apiUrl) {
    throw new Error(`Chain ${chainId} not supported for speed test`);
  }

  const checksummedAddress = getAddress(address);
  const url = new URL(`${apiUrl}/api/v1/safes/${checksummedAddress}/multisig-transactions/`);
  url.searchParams.append('executed', 'true');
  url.searchParams.append('limit', '10');
  url.searchParams.append('ordering', '-executionDate');

  const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Safe API error: ${response.status}`);
  }

  const data = await response.json();
  const transactions: SafeTransaction[] = data.results || [];

  if (!transactions.length) {
    throw new Error('No executed transactions found for this Safe');
  }

  const results: Transaction[] = [];
  let totalDuration = 0;

  for (const tx of transactions) {
    const confirmations = tx.confirmations || [];
    if (!confirmations.length) continue;

    const sorted = [...confirmations].sort((a, b) =>
      (a.submissionDate || '').localeCompare(b.submissionDate || '')
    );

    const firstTime = parseIsoTimestamp(sorted[0].submissionDate);
    const lastTime = parseIsoTimestamp(sorted[sorted.length - 1].submissionDate);
    if (!firstTime || !lastTime) continue;

    const durationSeconds = (lastTime.getTime() - firstTime.getTime()) / 1000;

    const proposalTime = parseIsoTimestamp(tx.submissionDate || '');
    const proposalToLastSigSeconds = proposalTime
      ? (lastTime.getTime() - proposalTime.getTime()) / 1000
      : 0;

    const confirmationsRequired = tx.confirmationsRequired ?? 0;

    let minGapSeconds: number | null = null;
    if (confirmationsRequired >= 3 && sorted.length >= confirmationsRequired) {
      let min = Infinity;
      for (let i = 1; i < sorted.length; i++) {
        const t0 = parseIsoTimestamp(sorted[i - 1].submissionDate);
        const t1 = parseIsoTimestamp(sorted[i].submissionDate);
        if (t0 && t1) {
          const gap = (t1.getTime() - t0.getTime()) / 1000;
          if (gap < min) min = gap;
        }
      }
      if (min !== Infinity) minGapSeconds = min;
    }

    results.push({
      safe_tx_hash: tx.safeTxHash || 'Unknown',
      tx_hash: tx.transactionHash || 'Unknown',
      nonce: tx.nonce ?? 'N/A',
      first_signature_time: firstTime.toISOString(),
      last_signature_time: lastTime.toISOString(),
      first_signer: sorted[0].owner || 'Unknown',
      last_signer: sorted[sorted.length - 1].owner || 'Unknown',
      num_confirmations: confirmations.length,
      confirmations_required: confirmationsRequired,
      used_safe_api: confirmationsRequired > 0 && confirmations.length >= confirmationsRequired,
      non_standard_sig_types: [...new Set(
        confirmations
          .map(c => c.signatureType)
          .filter((t): t is string => !!t && t !== 'EOA' && t !== 'ETH_SIGN')
      )],
      min_gap_seconds: minGapSeconds,
      min_gap_formatted: minGapSeconds !== null ? formatDuration(minGapSeconds) : null,
      duration_seconds: durationSeconds,
      duration_formatted: formatDuration(durationSeconds),
      execution_date: tx.executionDate || 'Unknown',
      proposal_to_last_sig_seconds: proposalToLastSigSeconds,
      proposal_to_last_sig_formatted: formatDuration(proposalToLastSigSeconds),
    });
    totalDuration += durationSeconds;
  }

  if (!results.length) {
    throw new Error('No transactions with confirmation data found');
  }

  const avgDuration = totalDuration / results.length;

  return {
    safe_address: checksummedAddress,
    chain: chainId.toString(),
    total_transactions_analyzed: results.length,
    average_duration_seconds: avgDuration,
    average_duration_formatted: formatDuration(avgDuration),
    transactions: results.sort((a, b) => a.duration_seconds - b.duration_seconds),
  };
}

export function SpeedTest({ address, chainId, chainName, explorerUrl }: SpeedTestProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [expanded, setExpanded] = useState(false);

  const runTest = useCallback(async () => {
    if (result || loading) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const data = await fetchAndAnalyzeSafe(address, chainId);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze signing speed');
    } finally {
      setLoading(false);
    }
  }, [address, chainId, result, loading]);

  // Auto-run on mount
  React.useEffect(() => {
    runTest();
  }, [runTest]);

  if (loading) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" />
        <span className="text-sm text-[var(--color-text-secondary)]">Analyzing signing speed...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning-bg)]">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-[var(--color-warning)] shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-[var(--color-warning)]">Signing Speed Analysis Unavailable</p>
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!result) return null;

  const speed = getSpeedClass(result.average_duration_seconds);
  const risk = getRiskAssessment(result.average_duration_seconds);

  return (
    <div className={cn(
      "rounded-lg border overflow-hidden",
      speed.color
    )}>
      {/* Collapsed View - Big Number */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-6 text-left hover:opacity-80 transition-opacity"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap className="h-6 w-6" />
            <div>
              <p className="text-sm font-medium opacity-80">Average Signing Duration</p>
              <p className={cn(
                "text-4xl sm:text-5xl font-bold tracking-tight mt-1",
                speed.textColor
              )}>
                {result.average_duration_formatted}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={cn(
              "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold",
              risk.className === "high" && "bg-[var(--color-error-bg)] text-[var(--color-error)]",
              risk.className === "medium" && "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
              risk.className === "low" && "bg-[var(--color-success-bg)] text-[var(--color-success)]"
            )}>
              {risk.icon}
              {risk.rating}
            </div>
            <ChevronDown className={cn(
              "h-5 w-5 transition-transform duration-200",
              expanded && "rotate-180"
            )} />
          </div>
        </div>
        <p className="mt-3 text-sm opacity-80">{risk.text}</p>
      </button>

      {/* Expanded View - Transaction Details */}
      {expanded && (
        <div className="border-t border-current/20">
          <div className="p-4 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    #
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    Transaction
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    Nonce
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    Sigs
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    Used API
                  </th>
                  <th className="px-3 py-2 text-center text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    Sig Types
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    Duration
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    <span title="Shortest gap between any two consecutive signatures. N/A for thresholds ≤ 2. A very short min gap suggests one operator signing with multiple keys.">
                      Min Gap
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {result.transactions.map((tx, index) => {
                  const txSpeed = getSpeedClass(tx.duration_seconds);
                  const hasNonStandardSigs = tx.non_standard_sig_types.length > 0;
                  return (
                    <tr key={tx.safe_tx_hash} className="hover:bg-black/5">
                      <td className="px-3 py-2 text-sm text-[var(--color-text-tertiary)]">
                        {index + 1}
                      </td>
                      <td className="px-3 py-2">
                        <a
                          href={`${explorerUrl}/tx/${tx.tx_hash !== "Unknown" ? tx.tx_hash : tx.safe_tx_hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-mono text-sm text-[var(--color-primary)] hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {tx.safe_tx_hash.slice(0, 6)}...{tx.safe_tx_hash.slice(-4)}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                      <td className="px-3 py-2 text-sm text-[var(--color-text-secondary)]">
                        {tx.nonce}
                      </td>
                      <td className="px-3 py-2 text-sm text-[var(--color-text-secondary)]">
                        {tx.num_confirmations}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {tx.used_safe_api ? (
                          <CheckCircle className="inline-block h-4 w-4 text-[var(--color-success)]" />
                        ) : (
                          <XCircle className="inline-block h-4 w-4 text-[var(--color-error)]" />
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {hasNonStandardSigs ? (
                          <span
                            className="inline-flex items-center gap-1 text-[var(--color-warning)]"
                            title={tx.non_standard_sig_types.join(', ')}
                          >
                            <AlertTriangle className="h-4 w-4 shrink-0" />
                            <span className="text-xs font-medium">
                              {tx.non_standard_sig_types
                                .map(t => t === 'CONTRACT_SIGNATURE' ? 'Contract' : t === 'APPROVED_HASH' ? 'OnChain' : t)
                                .join(', ')}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--color-text-tertiary)]">Standard</span>
                        )}
                      </td>
                      <td className={cn(
                        "px-3 py-2 text-right text-sm font-semibold",
                        txSpeed.textColor
                      )}>
                        {tx.duration_formatted}
                      </td>
                      <td className={cn(
                        "px-3 py-2 text-right text-sm font-semibold",
                        tx.min_gap_seconds !== null
                          ? getMinGapClass(tx.min_gap_seconds)
                          : "text-[var(--color-text-tertiary)]"
                      )}>
                        {tx.min_gap_formatted ?? "N/A"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
