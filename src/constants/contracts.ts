// Gnosis Safe ABI with all the functions we need
export const GNOSIS_SAFE_ABI = [
  {
    "inputs": [],
    "name": "VERSION",
    "outputs": [{"internalType": "string", "name": "", "type": "string"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getThreshold",
    "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getOwners",
    "outputs": [{"internalType": "address[]", "name": "", "type": "address[]"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "nonce",
    "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {"internalType": "address", "name": "start", "type": "address"},
      {"internalType": "uint256", "name": "pageSize", "type": "uint256"}
    ],
    "name": "getModulesPaginated",
    "outputs": [
      {"internalType": "address[]", "name": "array", "type": "address[]"},
      {"internalType": "address", "name": "next", "type": "address"}
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getGuard",
    "outputs": [{"internalType": "address", "name": "guard", "type": "address"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getFallbackHandler",
    "outputs": [{"internalType": "address", "name": "handler", "type": "address"}],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

// Known official Safe fallback handlers that are safe to use
export const OFFICIAL_SAFE_FALLBACK_HANDLERS: { [address: string]: string } = {
  // CompatibilityFallbackHandler (current recommended handler)
  '0x017062a1de2fe6b99be3d9d37841fed19f573804': 'CompatibilityFallbackHandler',
  '0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4': 'CompatibilityFallbackHandler 1.3.0',
  '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99': 'CompatibilityFallbackHandler 1.4.1',

  // DefaultCallbackHandler (legacy but official)
  '0xd5d82b6addc9027b22dca772aa68d5d74cdbdf44': 'DefaultCallbackHandler',

  // TokenCallbackHandler (used by Safe UI)
  '0x7f6ab15b00e1e8e1d4ff2b25ce0e2e83dd5e24d1': 'TokenCallbackHandler',
  '0x6ac8d65dc698ae07263e3a98aa698c33060b4a13': 'TokenCallbackHandler',

  // SignMessageLib (for EIP-1271 signature verification)
  '0x98ffbbf51bb33a056b08ddf711f289936aaff717': 'SignMessageLib',
  '0xa65387f16b013cf2af4605ad8aa5ec25a2cbda83': 'SignMessageLib',

  // CreateCall (for creating contracts from Safe)
  '0x7cbb62eaa69f79e6873cd1ecb2392971036cfaa4': 'CreateCall',
  '0x9b35af71d77eaf8d7e40252370304687390a1a52': 'CreateCall',

  // SimulateTxAccessor (for simulating transactions)
  '0x59ad6735bcd8152b84860cb256dd9e96b85f69da': 'SimulateTxAccessor',
  '0x727a77a074d1e6c4530e814f89e618a3298fc044': 'SimulateTxAccessor',
};

// Official Safe proxy factory addresses, keyed by lowercase address → { name, version }
export const OFFICIAL_SAFE_PROXY_FACTORIES: { [address: string]: { name: string; version: string } } = {
  // v1.0.0
  '0x12302fe9c02ff50939baaaaf415fc226c078613c': { name: 'ProxyFactory v1.0.0', version: '1.0.0' },
  // v1.1.1
  '0x76e2cfc1f5fa8f6a5b3fc4c8f4788f0116861f9b': { name: 'ProxyFactory v1.1.1', version: '1.1.1' },
  // v1.3.0
  '0xa6b71e26c5e0845f74c812102ca7114b6a896ab2': { name: 'GnosisSafeProxyFactory v1.3.0', version: '1.3.0' },
  '0xc22834581ebc8527d974f8a1c97e1bea4ef910bc': { name: 'GnosisSafeProxyFactory v1.3.0 (EIP-155)', version: '1.3.0' },
  '0xdaec33641865e4651fb43181c6db6f7232ee91c2': { name: 'GnosisSafeProxyFactory v1.3.0 (zkSync)', version: '1.3.0' },
  // v1.4.1
  '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67': { name: 'SafeProxyFactory v1.4.1', version: '1.4.1' },
  '0xc329d02fd8cb2fc13aa919005af46320794a8629': { name: 'SafeProxyFactory v1.4.1 (zkSync)', version: '1.4.1' },
  // v1.5.0
  '0x14f2982d601c9458f93bd70b218933a6f8165e7b': { name: 'SafeProxyFactory v1.5.0', version: '1.5.0' },
};

// Safe versions for which we have known factory addresses
export const SAFE_VERSIONS_WITH_KNOWN_FACTORIES = new Set(
  Object.values(OFFICIAL_SAFE_PROXY_FACTORIES).map(f => f.version)
);

// Official Safe singleton (masterCopy) addresses per chain.
// Source: safe-global/safe-deployments repository.
// Keyed by chain ID, each value maps lowercase address → human-readable name.
// Used to verify that a Safe proxy delegates to an official, audited singleton.
export const OFFICIAL_SAFE_SINGLETONS: Record<number, Record<string, string>> = {
  1: {
    '0xb6029ea3b2c51d09a50b53ca8012feeb05bda35a': 'GnosisSafe v1.0.0',
    '0x34cfac646f301356faa8b21e94227e3583fe3f5f': 'GnosisSafe v1.1.1',
    '0x6851d6fdfafd08c0295c392436245e5bc78b0185': 'GnosisSafe v1.2.0',
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
    '0xff51a5898e281db6dfc7855790607438df2ca44b': 'Safe v1.5.0',
    '0xedd160febbd92e350d4d398fb636302fccd67c7e': 'SafeL2 v1.5.0',
  },
  10: {
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
  },
  56: {
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
  },
  137: {
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
  },
  8453: {
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
    '0xff51a5898e281db6dfc7855790607438df2ca44b': 'Safe v1.5.0',
    '0xedd160febbd92e350d4d398fb636302fccd67c7e': 'SafeL2 v1.5.0',
  },
  42161: {
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
  },
  146: {
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
  },
  747474: {
    '0x69f4d1788e39c87893c980c06edf4b7f686e2938': 'GnosisSafe v1.3.0 (EIP-155)',
    '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': 'GnosisSafe v1.3.0',
    '0xfb1bffc9d739b8d520daf37df666da4c687191ea': 'GnosisSafeL2 v1.3.0 (EIP-155)',
    '0x3e5c63644e683549055b9be8653de26e0b4cd36e': 'GnosisSafeL2 v1.3.0',
    '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
    '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'SafeL2 v1.4.1',
    '0xff51a5898e281db6dfc7855790607438df2ca44b': 'Safe v1.5.0',
    '0xedd160febbd92e350d4d398fb636302fccd67c7e': 'SafeL2 v1.5.0',
  },
};

// Sentinel address used for modules list
export const SENTINEL_MODULES_ADDRESS = '0x0000000000000000000000000000000000000001';

// Storage slots for guard and fallback handler (stable across Safe v1.3.0+)
// These must be read via eth_getStorageAt because Safe v1.4.1 removed the
// public getGuard() and getFallbackHandler() functions to save bytecode size.
export const GUARD_STORAGE_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
export const FALLBACK_HANDLER_STORAGE_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';