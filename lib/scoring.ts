import { CHECK_TITLES } from './checkTitles';

// Shared security scoring logic — single source of truth for both API and frontend.
// Any change here automatically applies to both.

export interface PenaltyConfig {
  error: number;
  warning: number;
  description: string;
}

export interface ScoringInput {
  title: string;
  status: string;
}

export interface SecurityScoreResult {
  rawScore: number;
  position: number;
  rating: 'High Risk' | 'Medium Risk' | 'Low Risk';
  description: string;
  penalties: { title: string; points: number }[];
  completedChecks: number;
  totalChecks: number;
  unavailableChecks: number;
}

export const INFORMATIONAL_CHECKS = new Set<string>([
  CHECK_TITLES.CHAIN_CONFIGURATION,
  CHECK_TITLES.TRANSACTION_GUARD,
  CHECK_TITLES.FALLBACK_HANDLER,
  CHECK_TITLES.OPTIONAL_MODULES,
  CHECK_TITLES.EMERGENCY_RECOVERY,
]);

export const PENALTY_CONFIG: Record<string, PenaltyConfig> = {
  // Core security controls
  'Signer Threshold': {
    error: 20,
    warning: 10,
    description: 'Number of signatures required to execute transactions',
  },
  'Signer Threshold Percentage': {
    error: 14,
    warning: 7,
    description: 'Percentage of owners required to approve transactions',
  },

  // Important security features
  'Signing Speed Analysis': {
    error: 14,
    warning: 7,
    description: 'Time between first and last signature (indicates potential centralization)',
  },
  'Safe Version': {
    error: 10,
    warning: 4,
    description: 'Safe singleton contract version',
  },
  'Singleton Integrity': {
    error: 25,
    warning: 12,
    description: 'Verifies the proxy delegates to an official, audited Safe singleton',
  },

  // Other checks
  'Multisig Nonce': {
    error: 6,
    warning: 3,
    description: 'Total number of transactions executed by the multisig',
  },
  'Contract Creation Date': {
    error: 4,
    warning: 2,
    description: 'Age of the multisig contract deployment',
  },
  'Last Transaction Date': {
    error: 4,
    warning: 2,
    description: 'Time since last transaction execution',
  },

  // Informational checks
  'Contract Signers': {
    error: 4,
    warning: 2,
    description: 'Check if signers are smart contracts',
  },
  'Owner Activity Analysis': {
    error: 2,
    warning: 1,
    description: 'Transaction activity of owner addresses',
  },
  'Multi-Chain Signer Analysis': {
    error: 4,
    warning: 2,
    description: 'Signer reuse across chain deployments',
  },
};

export const DEFAULT_PENALTY: PenaltyConfig = {
  error: 8,
  warning: 4,
  description: 'Security check',
};

/**
 * Cumulative Risk Penalty algorithm.
 * Starts at 100, subtracts penalties for each failed/warned check, clamps to 0–100.
 * Accepts any array of objects with `title` and `status` fields — works with
 * both the API's SecurityCheck (which includes `id`/`details`) and the
 * frontend's SecurityCheck (which includes `loading` status and ReactNode messages).
 */
export function calculateSecurityScore(checks: ScoringInput[]): SecurityScoreResult {
  const scored = checks.filter(c => c && c.title && !INFORMATIONAL_CHECKS.has(c.title));
  const totalChecks = scored.length;
  const unavailableChecks = scored.filter(c => c.status === 'unavailable').length;
  const completedChecks = scored.filter(c => c.status && c.status !== 'loading' && c.status !== 'unavailable').length;

  if (completedChecks === 0) {
    return {
      rawScore: 0,
      position: 0,
      rating: 'High Risk',
      description: 'Analysis in progress...',
      penalties: [],
      completedChecks,
      totalChecks,
      unavailableChecks,
    };
  }

  let score = 100;
  const penalties: { title: string; points: number }[] = [];

  for (const check of checks) {
    if (!check || !check.status || check.status === 'loading' || check.status === 'unavailable') continue;
    if (INFORMATIONAL_CHECKS.has(check.title)) continue;

    if (!PENALTY_CONFIG[check.title]) {
      console.warn(
        `[scoring] No penalty config for check "${check.title}" — using default (${DEFAULT_PENALTY.error}/${DEFAULT_PENALTY.warning})`
      );
    }
    const config = PENALTY_CONFIG[check.title] || DEFAULT_PENALTY;

    if (check.status === 'error') {
      score -= config.error;
      penalties.push({ title: check.title, points: config.error });
    } else if (check.status === 'warning') {
      score -= config.warning;
      penalties.push({ title: check.title, points: config.warning });
    }
  }

  const rawScore = Math.max(0, Math.min(100, score));

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

  return {
    rawScore,
    position,
    rating,
    description,
    penalties: penalties.sort((a, b) => b.points - a.points),
    completedChecks,
    totalChecks,
    unavailableChecks,
  };
}
