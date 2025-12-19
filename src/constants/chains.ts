import { mainnet, base, arbitrum, optimism, polygon, bsc, sonic } from 'viem/chains';
import { defineChain } from 'viem';

// Define Katana chain
export const katana = defineChain({
  id: 747474,
  name: 'Katana',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['https://katana.drpc.org'],
    },
  },
  blockExplorers: {
    default: { name: 'Katana Explorer', url: 'https://katana-explorer.com' },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
      blockCreated: 1,
    },
  },
});

export interface ChainConfig {
  id: number;
  name: string;
  viemChain: typeof mainnet | typeof base | typeof arbitrum | typeof optimism | typeof polygon | typeof bsc | typeof sonic | typeof katana;
  rpcUrl: string;
  backupRpcUrl: string;
  explorerApiUrl: string;
  explorerUrl: string;
}

export const CHAIN_ID_MAP = {
  'Ethereum': 1,
  'Base': 8453,
  'Arbitrum': 42161,
  'Optimism': 10,
  'Polygon': 137,
  'BNB': 56,
  'Sonic': 146,
  'Katana': 747474,
} as const;

export const SUPPORTED_CHAINS: ChainConfig[] = [
  {
    id: 1,
    name: 'Ethereum',
    viemChain: mainnet,
    rpcUrl: 'https://eth.meowrpc.com',
    backupRpcUrl: 'https://eth.drpc.org',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://etherscan.io'
  },
  {
    id: 8453,
    name: 'Base',
    viemChain: base,
    rpcUrl: 'https://base.meowrpc.com',
    backupRpcUrl: 'https://base.drpc.org',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://basescan.org'
  },
  {
    id: 42161,
    name: 'Arbitrum',
    viemChain: arbitrum,
    rpcUrl: 'https://arbitrum.drpc.org',
    backupRpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://arbiscan.io'
  },
  {
    id: 10,
    name: 'Optimism',
    viemChain: optimism,
    rpcUrl: 'https://optimism.drpc.org',
    backupRpcUrl: 'https://mainnet.optimism.io',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://optimistic.etherscan.io'
  },
  {
    id: 137,
    name: 'Polygon',
    viemChain: polygon,
    rpcUrl: 'https://polygon.drpc.org',
    backupRpcUrl: 'https://polygon-rpc.com',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://polygonscan.com'
  },
  {
    id: 56,
    name: 'BNB',
    viemChain: bsc,
    rpcUrl: 'https://1rpc.io/bnb',
    backupRpcUrl: 'https://bsc-dataseed.binance.org',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://bscscan.com'
  },
  {
    id: 146,
    name: 'Sonic',
    viemChain: sonic,
    rpcUrl: 'https://sonic.drpc.org',
    backupRpcUrl: 'https://rpc.soniclabs.com',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://sonicscan.org'
  },
  {
    id: 747474,
    name: 'Katana',
    viemChain: katana,
    rpcUrl: 'https://rpc.katana.network',
    backupRpcUrl: 'https://katana.drpc.org',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    explorerUrl: 'https://katana-explorer.com'
  }
];

export const DEFAULT_CHAIN = SUPPORTED_CHAINS[0]; // Ethereum

export interface ExampleMultisig {
  address: string;
  name: string;
}

export const CHAIN_EXAMPLES: Record<number, ExampleMultisig[]> = {
  // Ethereum (1)
  1: [
    { address: '0x73b047fe6337183A454c5217241D780a932777bD', name: 'Lido Emergency Brakes Multisig' },
    { address: '0x3B59C6d0034490093460787566dc5D6cE17F2f9C', name: 'Uniswap Accountability Committee' },
    { address: '0xcAD001c30E96765aC90307669d578219D4fb1DCe', name: 'Euler Finance DAO' },
    { address: '0xFEB4acf3df3cDEA7399794D0869ef76A6EfAff52', name: 'Yearn DAO Multisig' },
    { address: '0x467947EE34aF926cF1DCac093870f613C96B1E0c', name: 'Curve Finance Emergency Owner' },
    { address: '0x4FF1b9D9ba8558F5EAfCec096318eA0d8b541971', name: 'Origin Finance Guardian Multisig' },
    { address: '0x9fC3dc011b461664c835F2527fffb1169b3C213e', name: 'Ethereum Foundation DeFi Multisig' },
    { address: '0xac140648435d03f784879cd789130f22ef588fcd', name: 'Aave Chan Initiative Multisig' },
    { address: '0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa', name: 'Morpho DAO Multisig' }
  ],

  // Base (8453)
  8453: [
    { address: '0x1a07dceefeebba3d1873e2b92bef190d2f11c3cb', name: 'Beefy Finance Multisig' },
    { address: '0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa', name: 'Morpho DAO Multisig' },
    { address: '0xBDE0c70BdC242577c52dFAD53389F82fd149EA5a', name: 'Aerodrome Team Multisig'},
    { address: '0xc61b9bb3a7a0767e3179713f3a5c7a9aedce193c', name: 'Bitfinex Multisig'}
  ],

  // Arbitrum (42161)
  42161: [
    { address: '0x7c68c42de679ffb0f16216154c996c354cf1161b', name: 'Balancer Protocol Fees Multisig' },
    { address: '0xc9647361742eb964965b461c44bdf5c4bc3c406d', name: 'Ethena Multisig' },
    { address: '0x6346282db8323a54e840c6c772b4399c9c655c0d', name: 'Yearn Strategist Multisig' },
    { address: '0x4a183b7ed67b9e14b3f45abfb2cf44ed22c29e54', name: 'Zerion Multisig' }
  ],

  // Optimism (10)
  10: [
    { address: '0x392ac17a9028515a3bfa6cce51f8b70306c6bd43', name: 'Stargate Finance Multisig'},
    { address: '0x2458baabfb21ae1da11d9dd6ad4e48ab2fbf9959', name: 'LayerZero Multisig'},
    { address: '0x4Cf8fE0A4c2539F7EFDD2047d8A5D46F14613088', name: 'Lido Emergency Brakes Multisig' },
    { address: '0x043f9687842771b3df8852c1e9801dcaeed3f6bc', name: 'Balancer Optimism DAO Multisig' },
    { address: '0x60c5c9c98bcbd0b0f2fd89b24c16e533baa8cda3', name: 'OP RetroPGF Multisig' }
  ],

  // Polygon (137)
  137: [
    { address: '0xc0c07644631543c3af2fA7230D387C5fA418a131', name: 'Angle Protocol Management Multisig' },
    { address: '0x47290de56e71dc6f46c26e50776fe86cc8b21656', name: 'Stargate Finance Multisig' },
    { address: '0xc4ad0000e223e398dc329235e6c497db5470b626', name: 'Yearn pchad Multisig' },
    { address: '0xa4b291ed1220310d3120f515b5b7accaecd66f17', name: 'PolyNetwork Multisig' }
  ],

  // BNB (56)
  56: [
    { address: '0x0128ea927198f39e4955ddb01fd62e8de6b3e6a4', name: 'Angle Governance Multisig' },
    { address: '0xc61b9bb3a7a0767e3179713f3a5c7a9aedce193c', name: 'Bitfinex Multisig' }
  ],

  // Sonic (146)
  146: [
    { address: '0x7461d8c0fDF376c847b651D882DEa4C73fad2e4B', name: 'Silo Fees Receiver' },
    { address: '0x600ad881ace196c27d0cf14e662ad03c6a5b4de8', name: 'Shadow Partners Multisig' }
  ],

  // Katana (747474)
  747474: [
    { address: '0xe6ad5A88f5da0F276C903d9Ac2647A937c917162', name: 'Yearn kchad Multisig' },
    { address: '0xBe7c7efc1ef3245d37E3157F76A512108D6D7aE6', name: 'Yearn Strategist Multisig' },
    { address: '0xb5c5b5D7a64d43bb91Dab63Ff3095F7FcB869b4e', name: 'Morpho Gauntlet Curator' },
    { address: '0x18b8828ca63F03CE4765f56Db7652F88cDE45d7c', name: 'Morpho Registry Owner' }
  ]
};