export interface TooltipInfo {
  description: string;
  thresholds: { status: string; condition: string }[];
  learnMoreUrl: string;
}

export const SECURITY_CHECK_TOOLTIPS: Record<string, TooltipInfo> = {
  'Signer Threshold': {
    description: 'The number of signatures required to execute transactions. Higher thresholds provide better security.',
    thresholds: [
      { status: '✅ Success', condition: 'Threshold ≥ 4 signatures' },
      { status: '⚠️ Warning', condition: 'Threshold 2-3 signatures' },
      { status: '❌ Error', condition: 'Threshold = 1 signature (single point of failure)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-signatures'
  },
  'Signer Threshold Percentage': {
    description: 'The percentage of owners required to approve transactions. Higher percentages reduce risk of collusion.',
    thresholds: [
      { status: '✅ Success', condition: 'Threshold ≥ 51% of owners' },
      { status: '⚠️ Warning', condition: 'Threshold 34-50% of owners' },
      { status: '❌ Error', condition: 'Threshold < 34% of owners' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-signatures'
  },
  'Safe Version': {
    description: 'The version of the Safe smart contract. Newer versions include security improvements and bug fixes.',
    thresholds: [
      { status: '✅ Success', condition: 'Latest or second-latest version (within 180 days)' },
      { status: '⚠️ Warning', condition: 'Outdated version (1-2 versions behind)' },
      { status: '❌ Error', condition: 'Very outdated version (3+ versions behind)' }
    ],
    learnMoreUrl: 'https://github.com/safe-global/safe-smart-account/releases'
  },
  'Contract Creation Date': {
    description: 'How long the Safe has existed. Newer contracts carry higher risk as they have less operational history.',
    thresholds: [
      { status: '✅ Success', condition: 'Deployed > 60 days ago' },
      { status: '⚠️ Warning', condition: 'Deployed 7-60 days ago' },
      { status: '❌ Error', condition: 'Deployed < 7 days ago (very new)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/'
  },
  'Multisig Nonce': {
    description: 'The number of transactions executed. Higher nonces indicate active usage and operational maturity.',
    thresholds: [
      { status: '✅ Success', condition: 'Nonce > 10 transactions' },
      { status: '⚠️ Warning', condition: 'Nonce 4-10 transactions' },
      { status: '❌ Error', condition: 'Nonce ≤ 3 transactions (minimal usage)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-signatures'
  },
  'Last Transaction Date': {
    description: 'When the Safe was last used. Long periods of inactivity may indicate abandonment.',
    thresholds: [
      { status: '✅ Success', condition: 'Used within last 30 days' },
      { status: '⚠️ Warning', condition: 'Used 30-90 days ago' },
      { status: '❌ Error', condition: 'Inactive for 90+ days' }
    ],
    learnMoreUrl: 'https://docs.safe.global/'
  },
  'Safe Factory': {
    description: 'Checks whether the Safe was deployed by an official Safe proxy factory contract. Safes deployed by unknown factories may have been created with modified or malicious code.',
    thresholds: [
      { status: '✅ Success', condition: 'Deployed by an official Safe proxy factory' },
      { status: '⚠️ Warning', condition: 'Factory address unknown or could not be checked' },
      { status: '❌ Error', condition: 'Deployed by an unrecognized factory (requires investigation)' }
    ],
    learnMoreUrl: 'https://github.com/safe-global/safe-smart-account/tree/main/contracts/proxies'
  },
  'Optional Modules': {
    description: 'Additional functionality modules installed on the Safe. Modules can add features but also increase attack surface.',
    thresholds: [
      { status: '✅ Success', condition: 'No modules enabled (standard Safe only)' },
      { status: '⚠️ Warning', condition: 'One or more modules enabled (requires review)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-modules'
  },
  'Transaction Guard': {
    description: 'A guard contract that validates transactions before execution. Can add security but requires careful review.',
    thresholds: [
      { status: '✅ Success', condition: 'No guard enabled (standard execution)' },
      { status: '⚠️ Warning', condition: 'Guard enabled (review guard contract security)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-guards'
  },
  'Fallback Handler': {
    description: 'A contract that handles calls to undefined functions. Official Safe fallback handlers are safe and provide features like EIP-1271 signature verification.',
    thresholds: [
      { status: '✅ Success', condition: 'No fallback handler (standard Safe) or known official Safe fallback handler' },
      { status: '⚠️ Warning', condition: 'Custom fallback handler enabled (review handler security)' }
    ],
    learnMoreUrl: 'https://help.safe.global/en/articles/40838-what-is-a-fallback-handler-and-how-does-it-relate-to-safe'
  },
  'Chain Configuration': {
    description: 'Checks if the Safe exists on multiple chains with the same address (canonical deployment). Multi-chain deployments are normal and expected — EIP-712 domain separators prevent cross-chain signature replay. This check is informational; see Multi-Chain Signer Analysis for the actual security risk (signer reuse across chains).',
    thresholds: [
      { status: '✅ Success', condition: 'Deployed on single chain only' },
      { status: 'ℹ️ Informational', condition: 'Deployed on multiple chains (check signer reuse)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/eip-155'
  },
  'Owner Activity Analysis': {
    description: 'Checks if owner addresses are used for non-multisig transactions. Dedicated signing keys are more secure.',
    thresholds: [
      { status: '✅ Success', condition: 'All owners inactive (dedicated signing keys)' },
      { status: '⚠️ Warning', condition: 'Some owners have recent non-multisig activity' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-signatures'
  },
  'Emergency Recovery Mechanisms': {
    description: 'Checks for recovery modules and validates their configuration. Recovery thresholds should not be lower than normal thresholds.',
    thresholds: [
      { status: '✅ Success', condition: 'Recovery threshold ≥ normal threshold' },
      { status: '⚠️ Warning', condition: 'No recovery module or unknown threshold' },
      { status: '❌ Error', condition: 'Recovery threshold < normal threshold (security risk)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-modules'
  },
  'Contract Signers': {
    description: 'Checks if any signers are smart contracts instead of EOAs. Contract signers require recursive security analysis.',
    thresholds: [
      { status: '✅ Success', condition: 'All signers are EOAs (externally owned accounts)' },
      { status: '⚠️ Warning', condition: 'One or more signers are contracts (needs review)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/smart-account-signatures'
  },
  'Multi-Chain Signer Analysis': {
    description: 'Only shown for multi-chain deployments. Analyzes whether the same signer addresses are reused across different chains where this Safe is deployed. Cross-chain signer reuse increases security risk because if a single private key is compromised, attackers could potentially gain control over the Safe on multiple blockchains simultaneously. Best practice is to use different signer addresses for each chain deployment.',
    thresholds: [
      { status: '✅ Success', condition: 'No signer addresses reused across chains' },
      { status: '⚠️ Warning', condition: 'Same signer addresses used on multiple chains' }
    ],
    learnMoreUrl: 'https://docs.safe.global/advanced/eip-155'
  },
  'Signing Speed Analysis': {
    description: 'Analyzes the time between first and last signature for recent transactions. Very fast signing may indicate insufficient transaction review and potential centralization risk. Click to expand and view detailed transaction timing data.',
    thresholds: [
      { status: '✅ Slow (Safe)', condition: 'Average signing time > 6 hours (adequate review time)' },
      { status: '⚠️ Moderate', condition: 'Average signing time 10 minutes - 6 hours' },
      { status: '❌ Fast (Risky)', condition: 'Average signing time < 10 minutes (insufficient review)' }
    ],
    learnMoreUrl: 'https://docs.safe.global/'
  }
};

export const getTooltipInfo = (title: string): TooltipInfo => {
  return SECURITY_CHECK_TOOLTIPS[title] || {
    description: 'Security check information',
    thresholds: [],
    learnMoreUrl: 'https://docs.safe.global/'
  };
};