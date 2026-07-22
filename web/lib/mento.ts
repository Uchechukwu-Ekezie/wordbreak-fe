// Celo's native Mento exchange — lets a player enter a pool with only CELO, by swapping just
// enough of it into cUSD first. Not every player has cUSD already (that's the whole reason this
// file exists), so this removes the "you must already hold cUSD" requirement from the UI even
// though the pool contract itself only ever accepts cUSD.
//
// Addresses below were read directly from the live contracts on Celo mainnet (Broker
// .getExchangeProviders(), then BiPoolManager.getExchanges()) rather than taken from docs, since
// this moves real funds. Mento's contracts aren't deployed the same way on Celo Sepolia, so this
// whole feature is mainnet-only — see mentoAvailable().

import { publicClient, sendWrite } from "./wallet";
import { CHAIN_ID, CUSD_ADDRESS } from "./config";

export const MENTO_BROKER = "0x777A8255cA72412f0d706dc03C9D1987306B4CaD" as const;
const BIPOOL_MANAGER = "0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901" as const;
const CELO_CUSD_EXCHANGE_ID = "0x3135b662c38265d0655177091f1b647b4fef511103d06c016efdf18b46930d2c" as const;
export const CELO_TOKEN_ADDRESS = "0x471EcE3750Da237f93B8E339c536989b8978a438" as const;

export const mentoAvailable = () => CHAIN_ID === 42220;

const BROKER_ABI = [
  {
    type: "function", name: "getAmountIn", stateMutability: "view",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountOut", type: "uint256" },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
  {
    type: "function", name: "swapIn", stateMutability: "nonpayable",
    inputs: [
      { name: "exchangeProvider", type: "address" },
      { name: "exchangeId", type: "bytes32" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// How much CELO is needed, right now, to receive exactly `cusdOut` of cUSD.
export async function celoNeededForCusd(cusdOut: bigint): Promise<bigint> {
  return publicClient.readContract({
    address: MENTO_BROKER,
    abi: BROKER_ABI,
    functionName: "getAmountIn",
    args: [BIPOOL_MANAGER, CELO_CUSD_EXCHANGE_ID, CELO_TOKEN_ADDRESS, CUSD_ADDRESS, cusdOut],
  }) as Promise<bigint>;
}

// Swaps `celoIn` for at least `minCusdOut` of cUSD, approving the Broker first if needed.
// Returns the swap transaction hash; the caller is responsible for waiting on the receipt,
// matching how every other on-chain write in this app is called.
export async function swapCeloForCusd(
  account: `0x${string}`,
  celoIn: bigint,
  minCusdOut: bigint,
): Promise<`0x${string}`> {
  const allowance = (await publicClient.readContract({
    address: CELO_TOKEN_ADDRESS, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance",
    args: [account, MENTO_BROKER],
  })) as bigint;
  if (allowance < celoIn) {
    const ah = await sendWrite(account, {
      address: CELO_TOKEN_ADDRESS, abi: ERC20_ALLOWANCE_ABI, functionName: "approve",
      args: [MENTO_BROKER, celoIn],
    });
    await publicClient.waitForTransactionReceipt({ hash: ah });
  }
  return sendWrite(account, {
    address: MENTO_BROKER,
    abi: BROKER_ABI,
    functionName: "swapIn",
    args: [BIPOOL_MANAGER, CELO_CUSD_EXCHANGE_ID, CELO_TOKEN_ADDRESS, CUSD_ADDRESS, celoIn, minCusdOut],
  });
}
