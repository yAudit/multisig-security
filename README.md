# Multisig Security Checker

Security analyzer for Safe (formerly Gnosis Safe) multisig wallets. Paste a Safe address, choose a network, and get an opinionated security review that highlights risky configurations. Further information about the analysis is available in this post: https://blog.electisec.com/multisig-security.

![Multisig security web app](screenshot.png)

## Key Capabilities

- **Deep Safe introspection** – batch RPC calls retrieve the Safe version, owner set, signing threshold, nonce, enabled modules, guard, and fallback handler.
- **Security heuristics** – fourteen checks score each Safe on threshold quality, owner activity, EOA vs contract signers, optional modules, fallback handler provenance, emergency recovery settings, and more.
- **Cross-chain awareness** – detects deployments across Ethereum, Base, Arbitrum, Optimism, Polygon, and Katana, then warns when signers are reused between chains (replay-attack risk).
- **Fresh data sources** – combines viem RPC calls, Safe Protocol Kit helpers, GitHub release metadata, and Etherscan-style explorer APIs with rate limiting and RPC fallbacks.
- **Human-friendly UX** – color-coded score bar, hover tooltips that explain every check, and curated example Safes for each chain so you can demo the tool instantly.

## Stack

- [Next.js 15](https://nextjs.org/) App Router with React 19 and TypeScript
- [viem](https://viem.sh/) for RPC reads and multicall batching
- [@safe-global/protocol-kit](https://github.com/safe-global/safe-core-sdk) for Safe-specific helpers
- Tailwind-style utility classes for styling (see `src/app/globals.css`)

## Getting Started

1. **Prerequisites**
   - Node.js 20+
   - `pnpm` (preferred) or `npm`/`yarn`

2. **Install dependencies**
   ```bash
   pnpm install
   ```
   > Use `npm install` or `yarn install` if you prefer those package managers.

3. **Environment variables**
   Create `.env.local` and set an explorer API key (shared across Etherscan-family explorers):
   ```bash
   NEXT_PUBLIC_ETHERSCAN_API_KEY=YourApiKeyToken
   ```
   The app falls back to `YourApiKeyToken`, but supplying a real key avoids tight rate limits when fetching historical tx data.

4. **Run the dev server**
   ```bash
   pnpm dev
   ```
   Visit `http://localhost:3000`, choose a chain, and load a Safe address (or pick one from the example list).

5. **Production build**
   ```bash
   pnpm build
   pnpm start
   ```

## API Usage

All functionality is exposed through the built-in API route:

```
GET /api/[chainId]/[address]
```

- `chainId`: numeric ID from `SUPPORTED_CHAINS` (1, 8453, 42161, 10, 137, 747474).
- `address`: Safe contract address (checksum format preferred).

Response payload:

- `safeInfo`: version, threshold, owners, nonce, modules, guard, fallback handler.
- `securityScore`: aggregate score (0–100) plus qualitative rating.
- `checks`: array of the fourteen security checks, each with `status` (`success`, `warning`, `error`) and a descriptive message.

This makes it easy to plug the analyzer into monitoring scripts or dashboards without scraping the UI.

## Feedback

For feature requests or bug reports, DM `@engn33r` on X or open an issue/PR in this repo.

