// Shared security scoring logic — single source of truth for both API and frontend.
// Any change here automatically applies to both.

export interface PenaltyConfig {
  error: number;
  warning: number;
  isCritical: boolean;
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
  penalties: { title: string; points: number; isCritical: boolean }[];
  criticalCount: number;
}

export const PENALTY_CONFIG: Record<string, PenaltyConfig> = {
  // CRITICAL: Core security controls
  'Signer Threshold': {
    error: 20,
    warning: 10,
    isCritical: true,
    description: 'Number of signatures required to execute transactions',
  },
  'Signer Threshold Percentage': {
    error: 18,
    warning: 9,
    isCritical: true,
    description: 'Percentage of owners required to approve transactions',
  },

  // HIGH: Important security features
  'Signing Speed Analysis': {
    error: 16,
    warning: 8,
    isCritical: false,
    description: 'Time between first and last signature (indicates potential centralization)',
  },
  'Fallback Handler': {
    error: 14,
    warning: 6,
    isCritical: false,
    description: 'Handles token callbacks and fallback operations',
  },
  'Optional Modules': {
    error: 12,
    warning: 5,
    isCritical: false,
    description: 'Extensions that can execute transactions',
  },
  'Safe Version': {
    error: 10,
    warning: 4,
    isCritical: false,
    description: 'Safe singleton contract version',
  },
  'Safe Factory': {
    error: 10,
    warning: 4,
    isCritical: false,
    description: 'Checks if Safe was deployed by an official proxy factory',
  },

  // STANDARD: Other checks
  'Multisig Nonce': {
    error: 6,
    warning: 3,
    isCritical: false,
    description: 'Total number of transactions executed by the multisig',
  },
  'Contract Creation Date': {
    error: 4,
    warning: 2,
    isCritical: false,
    description: 'Age of the multisig contract deployment',
  },
  'Last Transaction Date': {
    error: 4,
    warning: 2,
    isCritical: false,
    description: 'Time since last transaction execution',
  },

  // LOW IMPACT: Informational checks
  'Emergency Recovery Mechanisms': {
    error: 2,
    warning: 1,
    isCritical: false,
    description: 'Recovery modules for emergency access',
  },
  'Transaction Guard': {
    error: 2,
    warning: 1,
    isCritical: false,
    description: 'Transaction guard for additional validation',
  },
  'Contract Signers': {
    error: 2,
    warning: 1,
    isCritical: false,
    description: 'Check if signers are smart contracts',
  },
  'Chain Configuration': {
    error: 2,
    warning: 1,
    isCritical: false,
    description: 'Multi-chain deployment check',
  },
  'Owner Activity Analysis': {
    error: 2,
    warning: 1,
    isCritical: false,
    description: 'Transaction activity of owner addresses',
  },
  'Multi-Chain Signer Analysis': {
    error: 2,
    warning: 1,
    isCritical: false,
    description: 'Signer reuse across chain deployments',
  },
};

export const DEFAULT_PENALTY: PenaltyConfig = {
  error: 8,
  warning: 4,
  isCritical: false,
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
  // Filter out loading/incomplete checks (no-op for API which never passes them)
  const completedChecks = checks.filter(c => c && c.status && c.status !== 'loading');

  if (completedChecks.length === 0) {
    return {
      rawScore: 0,
      position: 0,
      rating: 'High Risk',
      description: 'Analysis in progress...',
      penalties: [],
      criticalCount: 0,
    };
  }

  let score = 100;
  let criticalFailures = 0;
  const penalties: { title: string; points: number; isCritical: boolean }[] = [];

  for (const check of completedChecks) {
    if (!PENALTY_CONFIG[check.title]) {
      console.warn(
        `[scoring] No penalty config for check "${check.title}" — using default (${DEFAULT_PENALTY.error}/${DEFAULT_PENALTY.warning})`
      );
    }
    const config = PENALTY_CONFIG[check.title] || DEFAULT_PENALTY;

    if (check.status === 'error') {
      score -= config.error;
      penalties.push({ title: check.title, points: config.error, isCritical: config.isCritical });
      if (config.isCritical) criticalFailures++;
    } else if (check.status === 'warning') {
      score -= config.warning;
      penalties.push({ title: check.title, points: config.warning, isCritical: config.isCritical });
    }
  }

  // Compounding penalty for multiple critical errors (warnings excluded —
  // they already deduct points and shouldn't also trigger compounding)
  if (criticalFailures >= 3) {
    score -= 8;
    penalties.push({ title: 'Multiple Critical Issues', points: 8, isCritical: true });
  }
  if (criticalFailures >= 5) {
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

  return {
    rawScore,
    position,
    rating,
    description,
    penalties: penalties.sort((a, b) => b.points - a.points),
    criticalCount: criticalFailures,
  };
}
