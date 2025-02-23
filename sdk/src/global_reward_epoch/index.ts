import { Block } from '@ethersproject/providers'

import { Deployment, Market, MarketLiquiditySnapshot, Network } from '..'
import { AccountRewardEpoch } from '../account_reward_epoch'
import { SECONDS_IN_DAY, SECONDS_IN_WEEK, SECONDS_IN_YEAR } from '../constants/time'
import Lyra from '../lyra'
import { LyraStaking } from '../lyra_staking'
import fetchGlobalRewardEpochData, { GlobalRewardEpochData } from '../utils/fetchGlobalRewardEpochData'
import fetchLyraTokenSpotPrice from '../utils/fetchLyraTokenSpotPrice'
import fetchOpTokenSpotPrice from '../utils/fetchOpTokenSpotPrice'
import findMarketX from '../utils/findMarketX'
import fromBigNumber from '../utils/fromBigNumber'
import getEffectiveLiquidityTokens, { getMinimumStakedLyra } from '../utils/getEffectiveLiquidityTokens'
import getEffectiveTradingFeeRebate from '../utils/getEffectiveTradingFeeRebate'

export type GlobalRewardEpochAPY = {
  lyra: number
  op: number
  total: number
}

export type GlobalRewardEpochTokens = {
  lyra: number
  op: number
}

export type GlobalRewardEpochTradingFeeRebateTier = {
  stakedLyraCutoff: number
  feeRebate: number
}

export class GlobalRewardEpoch {
  private lyra: Lyra
  private epoch: GlobalRewardEpochData
  id: number
  progressDays: number
  markets: Market[]
  marketsLiquidity: MarketLiquiditySnapshot[]
  staking: LyraStaking
  blockTimestamp: number
  startTimestamp: number
  endTimestamp: number
  duration: number
  lastUpdatedTimestamp: number
  isCurrent: boolean
  isComplete: boolean
  totalAverageStakedLyra: number
  minTradingFeeRebate: number
  maxTradingFeeRebate: number
  stakingApy: GlobalRewardEpochAPY
  totalStakingRewards: GlobalRewardEpochTokens
  tradingRewardsCap: GlobalRewardEpochTokens
  prices: GlobalRewardEpochTokens
  tradingFeeRebateTiers: GlobalRewardEpochTradingFeeRebateTier[]
  wethLyraStaking: GlobalRewardEpochTokens
  constructor(
    lyra: Lyra,
    id: number,
    epoch: GlobalRewardEpochData,
    prices: GlobalRewardEpochTokens,
    markets: Market[],
    marketsLiquidity: MarketLiquiditySnapshot[],
    staking: LyraStaking,
    block: Block
  ) {
    this.lyra = lyra
    this.id = id
    this.epoch = epoch
    this.prices = prices
    this.tradingFeeRebateTiers = epoch.tradingRewardConfig?.rebateRateTable?.map(tier => {
      return {
        stakedLyraCutoff: tier?.cutoff ?? 0,
        feeRebate: tier?.returnRate ?? 0,
      }
    })
    this.blockTimestamp = block.timestamp
    this.startTimestamp = epoch.startTimestamp
    this.lastUpdatedTimestamp = epoch.lastUpdated
    this.endTimestamp = epoch.endTimestamp
    this.isCurrent = this.blockTimestamp >= this.startTimestamp && this.blockTimestamp <= this.endTimestamp
    this.isComplete = this.blockTimestamp > this.endTimestamp
    this.markets = markets
    this.staking = staking
    this.marketsLiquidity = marketsLiquidity

    const durationSeconds = Math.max(0, this.endTimestamp - this.startTimestamp)
    this.duration = durationSeconds
    const progressSeconds = durationSeconds - Math.max(0, this.endTimestamp - this.blockTimestamp)
    this.progressDays = progressSeconds / SECONDS_IN_DAY
    this.totalAverageStakedLyra = this.progressDays ? epoch.totalStkLyraDays / this.progressDays : 0

    // Staking
    const stkLyraPerDollar = this.prices.lyra > 0 ? 1 / this.prices.lyra : 0
    const totalStkLyra = this.isComplete ? this.totalAverageStakedLyra : fromBigNumber(staking.totalSupply)
    const pctSharePerDollar = totalStkLyra > 0 ? stkLyraPerDollar / totalStkLyra : 0

    const opRewards = this.epoch.stakingRewardConfig.totalRewards.OP
    const opPerDollarPerSecond = durationSeconds > 0 ? (pctSharePerDollar * opRewards) / durationSeconds : 0
    const opApy = opPerDollarPerSecond * this.prices.op * SECONDS_IN_YEAR

    const lyraRewards = this.epoch.stakingRewardConfig.totalRewards.LYRA
    const lyraPerDollarPerSecond = durationSeconds > 0 ? (pctSharePerDollar * lyraRewards) / durationSeconds : 0
    const lyraApy = lyraPerDollarPerSecond * this.prices.lyra * SECONDS_IN_YEAR

    this.stakingApy = {
      op: opApy,
      lyra: lyraApy,
      total: opApy + lyraApy,
    }

    this.totalStakingRewards = {
      lyra: this.epoch.stakingRewardConfig.totalRewards.LYRA,
      op: 0,
    }

    this.minTradingFeeRebate = this.tradingFeeRebate(0)
    this.maxTradingFeeRebate = this.tradingFeeRebate(totalStkLyra)

    const { lyraRewardsCap, opRewardsCap } = this.epoch.tradingRewardConfig.rewards
    this.tradingRewardsCap = {
      lyra: lyraRewardsCap,
      op: opRewardsCap,
    }

    this.wethLyraStaking = {
      lyra: 0,
      op: this.epoch.wethLyraStakingRewardConfig?.totalRewards.OP ?? 0,
    }
  }

  // Getters

  static async getAll(lyra: Lyra): Promise<GlobalRewardEpoch[]> {
    // TODO: @dillon remove for arbitrum rewards
    if (lyra.deployment !== Deployment.Mainnet || lyra.network === Network.Arbitrum) {
      return []
    }
    const [epochs, lyraPrice, opPrice, markets, staking, block] = await Promise.all([
      fetchGlobalRewardEpochData(lyra),
      fetchLyraTokenSpotPrice(lyra),
      fetchOpTokenSpotPrice(lyra),
      lyra.markets(),
      lyra.lyraStaking(),
      lyra.provider.getBlock('latest'),
    ])
    const marketsLiquidity = await Promise.all(markets.map(market => market.liquidity()))
    const prices = { lyra: lyraPrice, op: opPrice }
    return epochs
      .map(
        (epoch, idx) => new GlobalRewardEpoch(lyra, idx + 1, epoch, prices, markets, marketsLiquidity, staking, block)
      )
      .sort((a, b) => a.endTimestamp - b.endTimestamp)
  }

  static async getLatest(lyra: Lyra): Promise<GlobalRewardEpoch | null> {
    // TODO: @dillon remove for arbitrum rewards
    if (lyra.deployment !== Deployment.Mainnet || lyra.network === Network.Arbitrum) {
      return null
    }
    const epochs = await this.getAll(lyra)
    const latestEpoch = epochs.find(r => !r.isComplete) ?? epochs[epochs.length - 1]
    return latestEpoch ?? null
  }

  static async getByStartTimestamp(lyra: Lyra, startTimestamp: number): Promise<GlobalRewardEpoch | null> {
    // TODO: @dillon remove for arbitrum rewards
    if (lyra.deployment !== Deployment.Mainnet || lyra.network === Network.Arbitrum) {
      return null
    }
    const epochs = await this.getAll(lyra)
    const epoch = epochs.find(epoch => epoch.startTimestamp === startTimestamp)
    return epoch ?? null
  }

  // Dynamic Fields

  vaultApy(marketAddressOrName: string, stakedLyraBalance: number, _vaultTokenBalance: number): GlobalRewardEpochAPY {
    const market = findMarketX(this.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol

    const vaultTokenBalance = _vaultTokenBalance

    const totalAvgVaultTokens = this.totalAverageVaultTokens(marketAddressOrName)
    const mmvConfig = this.epoch.MMVConfig[marketKey]
    const scaledStkLyraDays = this.epoch.scaledStkLyraDays[marketKey]

    if (!mmvConfig || !scaledStkLyraDays) {
      return {
        lyra: 0,
        op: 0,
        total: 0,
      }
    }

    const x = mmvConfig.x
    const totalAvgScaledStkLyra = this.progressDays ? scaledStkLyraDays / this.progressDays : 0

    const effectiveLpTokensPerLpToken = getEffectiveLiquidityTokens(
      vaultTokenBalance,
      totalAvgVaultTokens,
      stakedLyraBalance,
      totalAvgScaledStkLyra,
      x
    )

    const totalAvgBoostedVaultTokens = this.totalAverageBoostedVaultTokens(marketAddressOrName)
    const boostedPortionOfLiquidity =
      totalAvgBoostedVaultTokens > 0 ? effectiveLpTokensPerLpToken / totalAvgBoostedVaultTokens : 0
    const basePortionOfLiquidity = totalAvgVaultTokens > 0 ? vaultTokenBalance / totalAvgVaultTokens : 0

    // This ratio is for no staking -> staking w/ stkLyraBalance (noStakingMultiplier)
    // Vs UI apy multiplier is from zero staking -> staking w/ stkLyraBalance (vaultApyMultiplier)
    const apyMultiplier = basePortionOfLiquidity > 0 ? boostedPortionOfLiquidity / basePortionOfLiquidity : 0

    // Calculate total vault token balance, including pending deposits
    const marketIdx = this.markets.findIndex(m => m.address === market.address)
    const tokenPrice = fromBigNumber(this.marketsLiquidity[marketIdx].tokenPrice)
    const totalQueuedVaultTokens =
      tokenPrice > 0 ? fromBigNumber(this.marketsLiquidity[marketIdx].pendingDeposits) / tokenPrice : 0
    const totalAvgAndQueuedVaultTokens = totalAvgVaultTokens + totalQueuedVaultTokens

    const vaultTokensPerDollar = tokenPrice > 0 ? 1 / tokenPrice : 0
    const pctSharePerDollar = totalAvgAndQueuedVaultTokens > 0 ? vaultTokensPerDollar / totalAvgAndQueuedVaultTokens : 0

    const lyraRewards = mmvConfig.LYRA
    const lyraPerDollarPerSecond = this.duration > 0 ? (pctSharePerDollar * lyraRewards) / this.duration : 0
    const lyraApy = lyraPerDollarPerSecond * this.prices.lyra * SECONDS_IN_YEAR * apyMultiplier

    const opRewards = mmvConfig.OP
    const opPerDollarPerSecond = this.duration > 0 ? (pctSharePerDollar * opRewards) / this.duration : 0
    const opApy = opPerDollarPerSecond * this.prices.op * SECONDS_IN_YEAR * apyMultiplier

    return {
      lyra: lyraApy,
      op: opApy,
      total: lyraApy + opApy,
    }
  }

  vaultMaxBoost(marketAddressOrName: string, vaultTokenBalance: number): number {
    const market = findMarketX(this.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    const totalAvgVaultTokens = this.totalAverageVaultTokens(marketAddressOrName)
    const scaledStkLyraDays = this.epoch.scaledStkLyraDays[marketKey]
    const totalAvgScaledStkLyra = this.progressDays ? scaledStkLyraDays / this.progressDays : 0
    return getMinimumStakedLyra(totalAvgScaledStkLyra, vaultTokenBalance, totalAvgVaultTokens)
  }

  vaultApyMultiplier(marketAddressOrName: string, stakedLyraBalance: number, vaultTokenBalance: number): number {
    const baseApy = this.vaultApy(marketAddressOrName, 0, vaultTokenBalance).total
    const boostedApy = this.vaultApy(marketAddressOrName, stakedLyraBalance, vaultTokenBalance).total
    return baseApy > 0 ? boostedApy / baseApy : 0
  }

  minVaultApy(marketAddressOrName: string): GlobalRewardEpochAPY {
    return this.vaultApy(marketAddressOrName, 0, 10_000)
  }

  maxVaultApy(marketAddressOrName: string): GlobalRewardEpochAPY {
    const market = findMarketX(this.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    const scaledStkLyraDays = this.epoch.scaledStkLyraDays[marketKey]
    if (!scaledStkLyraDays) {
      return { lyra: 0, op: 0, total: 0 }
    }
    const totalAvgScaledStkLyra = this.progressDays ? scaledStkLyraDays / this.progressDays : 0
    return this.vaultApy(marketAddressOrName, totalAvgScaledStkLyra, 10_000)
  }

  totalVaultRewards(marketAddressOrName: string): GlobalRewardEpochTokens {
    const market = findMarketX(this.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    return {
      lyra: this.epoch.rewardedMMVRewards.LYRA[marketKey] ?? 0,
      op: this.epoch.rewardedMMVRewards.OP[marketKey] ?? 0,
    }
  }

  totalAverageVaultTokens(marketAddressOrName: string): number {
    const market = findMarketX(this.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    return this.progressDays ? (this.epoch.totalLpTokenDays[marketKey] ?? 0) / this.progressDays : 0
  }

  totalAverageBoostedVaultTokens(marketAddressOrName: string): number {
    const market = findMarketX(this.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    return this.progressDays ? (this.epoch.totalBoostedLpTokenDays[marketKey] ?? 0) / this.progressDays : 0
  }

  tradingFeeRebate(stakedLyraBalance: number): number {
    const {
      useRebateTable,
      rebateRateTable,
      maxRebatePercentage,
      netVerticalStretch,
      verticalShift,
      vertIntercept,
      stretchiness,
    } = this.epoch.tradingRewardConfig
    return getEffectiveTradingFeeRebate(
      stakedLyraBalance,
      useRebateTable,
      rebateRateTable,
      maxRebatePercentage,
      netVerticalStretch,
      verticalShift,
      vertIntercept,
      stretchiness
    )
  }

  tradingRewards(tradingFees: number, stakedLyraBalance: number): GlobalRewardEpochTokens {
    const { lyraPortion, fixedLyraPrice, fixedOpPrice, floorTokenPriceLyra, floorTokenPriceOP } =
      this.epoch.tradingRewardConfig.rewards

    const lyraPrice = this.isComplete ? fixedLyraPrice : Math.max(this.prices.lyra, floorTokenPriceLyra)
    const opPrice = this.isComplete ? fixedOpPrice : Math.max(this.prices.op, floorTokenPriceOP)

    const feeRebate = this.tradingFeeRebate(stakedLyraBalance)
    const feesRebated = feeRebate * tradingFees

    const lyraRewards = (feesRebated * lyraPortion) / lyraPrice
    const opRewards = (feesRebated * (1 - lyraPortion)) / opPrice

    return { lyra: lyraRewards, op: opRewards }
  }

  shortCollateralRewards(shortCollateralRebate: number): GlobalRewardEpochTokens {
    const { lyraPortion, fixedLyraPrice, fixedOpPrice, floorTokenPriceLyra, floorTokenPriceOP } =
      this.epoch.tradingRewardConfig.rewards

    const lyraPrice = this.isComplete ? fixedLyraPrice : Math.max(this.prices.lyra, floorTokenPriceLyra)
    const opPrice = this.isComplete ? fixedOpPrice : Math.max(this.prices.op, floorTokenPriceOP)

    const lyraRewards = (shortCollateralRebate * lyraPortion) / lyraPrice
    const opRewards = (shortCollateralRebate * (1 - lyraPortion)) / opPrice
    return { lyra: lyraRewards, op: opRewards }
  }

  shortCollateralYieldPerDay(
    contracts: number,
    delta: number,
    expiryTimestamp: number,
    marketBaseSymbol: string
  ): GlobalRewardEpochTokens {
    const timeToExpiry = Math.max(0, expiryTimestamp - this.blockTimestamp)

    if (
      !this.epoch.tradingRewardConfig.shortCollatRewards ||
      !this.epoch.tradingRewardConfig.shortCollatRewards[marketBaseSymbol]
    ) {
      return {
        lyra: 0,
        op: 0,
      }
    }

    const { longDatedPenalty, tenDeltaRebatePerOptionDay, ninetyDeltaRebatePerOptionDay } =
      this.epoch.tradingRewardConfig.shortCollatRewards[marketBaseSymbol]
    const { lyraPortion, floorTokenPriceLyra, floorTokenPriceOP } = this.epoch.tradingRewardConfig.rewards
    const absDelta = Math.abs(delta)

    if (absDelta < 0.1 || absDelta > 0.9 || this.isComplete) {
      return {
        lyra: 0,
        op: 0,
      }
    }

    const timeDiscount = timeToExpiry >= SECONDS_IN_WEEK * 4 ? longDatedPenalty : 1

    const rebatePerDay =
      (tenDeltaRebatePerOptionDay +
        (ninetyDeltaRebatePerOptionDay - tenDeltaRebatePerOptionDay) *
          ((absDelta - 0.1) / (0.9 - 0.1)) *
          timeDiscount) *
      contracts

    const lyraPrice = Math.max(this.prices.lyra, floorTokenPriceLyra)
    const opPrice = Math.max(this.prices.op, floorTokenPriceOP)
    const lyraRebatePerDay = lyraPortion * rebatePerDay
    const opRebatePerDay = (1 - lyraPortion) * rebatePerDay
    const lyraRewards = lyraPrice > 0 ? lyraRebatePerDay / lyraPrice : 0
    const opRewards = opPrice > 0 ? opRebatePerDay / opPrice : 0

    return {
      lyra: lyraRewards,
      op: opRewards,
    }
  }

  // Edge

  async accountRewardEpoch(address: string): Promise<AccountRewardEpoch | null> {
    const epochs = await AccountRewardEpoch.getByOwner(this.lyra, address)
    const epoch = epochs.find(
      epoch =>
        epoch.globalEpoch.startTimestamp === this.startTimestamp && epoch.globalEpoch.endTimestamp === this.endTimestamp
    )
    return epoch ?? null
  }
}
