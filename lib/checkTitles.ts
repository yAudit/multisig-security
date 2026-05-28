export const CHECK_TITLES = {
  SIGNING_SPEED: 'Signing Speed Analysis',
  SIGNER_THRESHOLD: 'Signer Threshold',
  SIGNER_THRESHOLD_PCT: 'Signer Threshold Percentage',
  SAFE_VERSION: 'Safe Version',
  CONTRACT_CREATION_DATE: 'Contract Creation Date',
  MULTISIG_NONCE: 'Multisig Nonce',
  LAST_TRANSACTION_DATE: 'Last Transaction Date',
  SINGLETON_INTEGRITY: 'Singleton Integrity',
  OPTIONAL_MODULES: 'Optional Modules',
  CONTRACT_SIGNERS: 'Contract Signers',
  OWNER_ACTIVITY: 'Owner Activity Analysis',
  MULTI_CHAIN_SIGNER: 'Multi-Chain Signer Analysis',
  TRANSACTION_GUARD: 'Transaction Guard',
  FALLBACK_HANDLER: 'Fallback Handler',
  CHAIN_CONFIGURATION: 'Chain Configuration',
  EMERGENCY_RECOVERY: 'Emergency Recovery Mechanisms',
} as const;

export type CheckTitle = (typeof CHECK_TITLES)[keyof typeof CHECK_TITLES];