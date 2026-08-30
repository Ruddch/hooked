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
  {
    type: 'event',
    name: 'BuyFeeRecorded',
    inputs: [
      { name: 'listingId', type: 'uint256', indexed: true },
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'mainToken', type: 'address', indexed: false },
      { name: 'quoteAmountIn', type: 'uint256', indexed: false },
      { name: 'mainAmountOut', type: 'uint256', indexed: false },
      { name: 'feeMainTaken', type: 'uint256', indexed: false },
      { name: 'feeMainToCollector', type: 'uint256', indexed: false },
      { name: 'feeQuoteToJackpot', type: 'uint256', indexed: false },
      { name: 'feeQuoteToOps', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
      { name: 'blockNumber', type: 'uint64', indexed: false },
    ],
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
    type: 'function',
    name: 'drandOracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'pendingLength',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getPendingBuyIds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'isReadyToSettle',
    stateMutability: 'view',
    inputs: [{ name: 'buyId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'settleWithDrand',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyId', type: 'uint256' },
      { name: 'round', type: 'uint64' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
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
  {
    type: 'event',
    name: 'JackpotMiss',
    inputs: [
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'winProbWad', type: 'uint256', indexed: false },
      { name: 'roll', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TicketSettled',
    inputs: [
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'TicketNotEligible',
    inputs: [{ name: 'buyId', type: 'uint256', indexed: true }],
  },
] as const

export const rewardsCollectorAbi = [
  {
    type: 'function',
    name: 'rewardsTargetDrandRound',
    stateMutability: 'view',
    inputs: [{ name: 'buyId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
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
  {
    type: 'event',
    name: 'TicketOpened',
    inputs: [
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'listingId', type: 'uint256', indexed: true },
      { name: 'mainToken', type: 'address', indexed: false },
      { name: 'mainAmountOut', type: 'uint256', indexed: false },
      { name: 'targetDrandRound', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TicketSkipped',
    inputs: [
      { name: 'buyId', type: 'uint256', indexed: true },
      { name: 'listingId', type: 'uint256', indexed: true },
      { name: 'quoteAmountIn', type: 'uint256', indexed: false },
      { name: 'minBuyUsdg', type: 'uint256', indexed: false },
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
