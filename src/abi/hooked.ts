export const hookedV1Abi = [
  {
    type: 'function',
    name: 'listings',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'mainToken', type: 'address' },
      { name: 'feeCollector', type: 'address' },
      { name: 'jackpot', type: 'address' },
      { name: 'opsWallet', type: 'address' },
      { name: 'active', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'buyCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'poolFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'tickSpacing',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int24' }],
  },
] as const

export const jackpotPoolAbi = [
  {
    type: 'function',
    name: 'poolBalance',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'currentTarget',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'JackpotHit',
    inputs: [
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'winProbWad', type: 'uint256', indexed: false },
      { name: 'roll', type: 'uint256', indexed: false },
      { name: 'payout', type: 'uint256', indexed: false },
      { name: 'target', type: 'uint256', indexed: false },
    ],
  },
] as const

export const rewardsCollectorAbi = [
  {
    type: 'event',
    name: 'RewardsSettled',
    inputs: [
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'mainToken', type: 'address', indexed: true },
      { name: 'multiplierWad', type: 'uint256', indexed: false },
      { name: 'bonusPaid', type: 'uint256', indexed: false },
      { name: 'roll', type: 'uint256', indexed: false },
    ],
  },
] as const

export const poolSwapTestAbi = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountSpecified', type: 'int256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
      {
        name: 'testSettings',
        type: 'tuple',
        components: [
          { name: 'takeClaims', type: 'bool' },
          { name: 'settleUsingBurn', type: 'bool' },
        ],
      },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
] as const
