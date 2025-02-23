import { AccountBalances, AccountLiquidityTokenBalance, AccountLyraBalances } from '../account'
import { Deployment, LyraGlobalContractId } from '../constants/contracts'
import { Network } from '../constants/network'
import { SECONDS_IN_SIX_MONTHS } from '../constants/time'
import { ClaimAddedEvent } from '../contracts/common/typechain/MultiDistributor'
import { GlobalRewardEpoch } from '../global_reward_epoch'
import Lyra from '../lyra'
import fetchAccountRewardEpochData, { AccountRewardEpochData } from '../utils/fetchAccountRewardEpochData'
import findMarketX from '../utils/findMarketX'
import fromBigNumber from '../utils/fromBigNumber'
import getGlobalContract from '../utils/getGlobalContract'
import parseClaimAddedTags from './parseClaimAddedTags'

export type AccountRewardEpochAPY = {
  lyra: number
  op: number
  total: number
}

export type AccountRewardEpochTokens = {
  lyra: number
  op: number
}

export type AccountRewardEpochTokensWethLyraStaking = {
  opRewards: number
  gUniTokensStaked: number
  percentShare: number
}

export class AccountRewardEpoch {
  private vaultTokenBalances: Record<string, AccountLiquidityTokenBalance>
  lyra: Lyra
  account: string
  globalEpoch: GlobalRewardEpoch
  accountEpoch: AccountRewardEpochData
  stakedLyraBalance: number
  tradingFeeRebate: number
  tradingFees: number
  stakingRewards: AccountRewardEpochTokens
  isPendingRewards: boolean
  stakingRewardsUnlockTimestamp: AccountRewardEpochTokens
  totalVaultRewards: AccountRewardEpochTokens
  tradingRewards: AccountRewardEpochTokens
  shortCollateralRewards: AccountRewardEpochTokens
  wethLyraStaking: AccountRewardEpochTokensWethLyraStaking
  constructor(
    lyra: Lyra,
    account: string,
    accountEpoch: AccountRewardEpochData,
    globalEpoch: GlobalRewardEpoch,
    balances: AccountBalances[],
    lyraBalances: AccountLyraBalances,
    claimAddedEvents: ClaimAddedEvent[]
  ) {
    this.lyra = lyra
    this.account = account
    this.globalEpoch = globalEpoch
    this.accountEpoch = accountEpoch
    const avgStkLyraBalance =
      this.globalEpoch.progressDays > 0 ? this.accountEpoch.stkLyraDays / this.globalEpoch.progressDays : 0
    this.stakedLyraBalance = this.globalEpoch.isComplete
      ? avgStkLyraBalance
      : fromBigNumber(lyraBalances.ethereumStkLyra.add(lyraBalances.optimismStkLyra))
    this.vaultTokenBalances = balances.reduce(
      (lpTokenBalances, balance) => ({
        ...lpTokenBalances,
        [balance.baseAsset.symbol]: balance.liquidityToken,
      }),
      {}
    )
    this.stakingRewards = {
      lyra: this.accountEpoch.inflationaryRewards?.lyra,
      op: this.accountEpoch.inflationaryRewards?.op,
    }
    this.stakingRewardsUnlockTimestamp = {
      lyra: this.globalEpoch.endTimestamp + SECONDS_IN_SIX_MONTHS,
      op: this.globalEpoch.endTimestamp,
    }
    this.totalVaultRewards = globalEpoch.markets.reduce(
      (sum, market) => {
        const { lyra, op } = this.vaultRewards(market.address)
        return {
          lyra: sum.lyra + lyra,
          op: sum.op + op,
        }
      },
      { lyra: 0, op: 0 }
    )
    this.tradingFeeRebate = this.globalEpoch.tradingFeeRebate(this.stakedLyraBalance)
    this.tradingFees = this.accountEpoch.tradingRewards?.tradingFees ?? 0
    this.tradingRewards = this.globalEpoch.tradingRewards(this.tradingFees, this.stakedLyraBalance)
    this.shortCollateralRewards = this.globalEpoch.shortCollateralRewards(
      this.accountEpoch.tradingRewards?.totalCollatRebateDollars ?? 0
    )

    const claimAddedTags = parseClaimAddedTags(claimAddedEvents)

    const isTradingPending =
      (this.tradingRewards.lyra + this.shortCollateralRewards.lyra > 0 && !claimAddedTags.tradingRewards.LYRA) ||
      (this.tradingRewards.op + this.shortCollateralRewards.op > 0 && !claimAddedTags.tradingRewards.OP)

    // ignore lyra rewards due to 6mo lock
    const isStakingPending = this.stakingRewards.op > 0 && !claimAddedTags.stakingRewards.OP

    const isVaultsPending = globalEpoch.markets.every(market => {
      const vaultRewards = this.vaultRewards(market.address)
      const marketKey = market.baseToken.symbol
      return (
        (vaultRewards.lyra > 0 && !claimAddedTags.vaultRewards[marketKey]?.LYRA) ||
        (vaultRewards.op > 0 && !claimAddedTags.vaultRewards[marketKey]?.OP)
      )
    })

    this.isPendingRewards = !this.globalEpoch.isComplete || isTradingPending || isStakingPending || isVaultsPending

    this.wethLyraStaking = {
      opRewards: this.accountEpoch.wethLyraStakingRewards?.opRewards ?? 0,
      gUniTokensStaked: this.accountEpoch.wethLyraStakingRewards?.gUniTokensStaked ?? 0,
      percentShare: this.accountEpoch.wethLyraStakingRewards?.percentShare ?? 0,
    }
  }

  // Getters

  static async getByOwner(lyra: Lyra, address: string): Promise<AccountRewardEpoch[]> {
    // TODO: @dillon remove for arbitrum rewards
    if (lyra.deployment !== Deployment.Mainnet || lyra.network === Network.Arbitrum) {
      return []
    }
    const distributorContract = getGlobalContract(lyra, LyraGlobalContractId.MultiDistributor, lyra.optimismProvider)
    const [accountEpochDatas, globalEpochs, lyraBalances, balances, claimAddedEvents] = await Promise.all([
      fetchAccountRewardEpochData(lyra, address),
      GlobalRewardEpoch.getAll(lyra),
      lyra.account(address).lyraBalances(),
      lyra.account(address).balances(),
      distributorContract.queryFilter(distributorContract.filters.ClaimAdded(null, address, null, null, null)),
    ])
    return accountEpochDatas
      .map(accountEpochData => {
        const globalEpoch = globalEpochs.find(
          globalEpoch =>
            globalEpoch.startTimestamp === accountEpochData.startTimestamp &&
            globalEpoch.endTimestamp === accountEpochData.endTimestamp
        )
        if (!globalEpoch) {
          throw new Error('Missing corresponding global epoch for account epoch')
        }
        // Find claims added for or after epoch
        const epochClaimAddedEvents = claimAddedEvents.filter(
          claimAdded => claimAdded.args.epochTimestamp.toNumber() === globalEpoch.startTimestamp
        )
        return new AccountRewardEpoch(
          lyra,
          address,
          accountEpochData,
          globalEpoch,
          balances,
          lyraBalances,
          epochClaimAddedEvents
        )
      })
      .sort((a, b) => a.globalEpoch.endTimestamp - b.globalEpoch.endTimestamp)
  }

  static async getByStartTimestamp(
    lyra: Lyra,
    address: string,
    startTimestamp: number
  ): Promise<AccountRewardEpoch | null> {
    // TODO: @dillon remove for arbitrum rewards
    if (lyra.deployment !== Deployment.Mainnet || lyra.network === Network.Arbitrum) {
      return null
    }
    const epochs = await AccountRewardEpoch.getByOwner(lyra, address)
    const epoch = epochs.find(epoch => epoch.globalEpoch.startTimestamp === startTimestamp)
    return epoch ?? null
  }

  // Dynamic Fields

  vaultApy(marketAddressOrName: string): AccountRewardEpochAPY {
    const vaultTokenBalance = this.vaultTokenBalance(marketAddressOrName)
    if (vaultTokenBalance === 0) {
      return this.globalEpoch.minVaultApy(marketAddressOrName)
    } else {
      return this.globalEpoch.vaultApy(marketAddressOrName, this.stakedLyraBalance, vaultTokenBalance)
    }
  }

  vaultMaxBoost(marketAddressOrName: string): number {
    const vaultTokenBalance = this.vaultTokenBalance(marketAddressOrName)
    if (vaultTokenBalance === 0) {
      return this.globalEpoch.vaultMaxBoost(marketAddressOrName, 0)
    } else {
      return this.globalEpoch.vaultMaxBoost(marketAddressOrName, vaultTokenBalance)
    }
  }

  vaultApyMultiplier(marketAddressOrName: string): number {
    const vaultTokenBalance = this.vaultTokenBalance(marketAddressOrName)
    if (vaultTokenBalance === 0) {
      return 1
    } else {
      return this.globalEpoch.vaultApyMultiplier(marketAddressOrName, this.stakedLyraBalance, vaultTokenBalance)
    }
  }

  vaultTokenBalance(marketAddressOrName: string): number {
    const market = findMarketX(this.globalEpoch.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    const boostedLpDays = this.accountEpoch.boostedLpDays
      ? this.accountEpoch.boostedLpDays[marketKey]
        ? this.accountEpoch.boostedLpDays[marketKey]
        : 0
      : 0
    const avgVaultTokenBalance = this.globalEpoch.progressDays > 0 ? boostedLpDays / this.globalEpoch.progressDays : 0
    const currVaultTokenBalance = fromBigNumber(this.vaultTokenBalances[marketKey].balance)
    // Uses average for historical epochs, realtime for current epoch
    const vaultTokenBalance = this.globalEpoch.isComplete ? avgVaultTokenBalance : currVaultTokenBalance
    return vaultTokenBalance
  }

  vaultRewards(marketAddressOrName: string): AccountRewardEpochTokens {
    const market = findMarketX(this.globalEpoch.markets, marketAddressOrName)
    const marketKey = market.baseToken.symbol
    const mmvRewards = this.accountEpoch.MMVRewards
      ? this.accountEpoch.MMVRewards[marketKey]
        ? this.accountEpoch.MMVRewards[marketKey]
        : null
      : null
    if (!mmvRewards) {
      return {
        lyra: 0,
        op: 0,
      }
    }
    const isIgnored = !!mmvRewards.isIgnored
    return {
      lyra: !isIgnored ? mmvRewards.lyra ?? 0 : 0,
      op: !isIgnored ? mmvRewards.op ?? 0 : 0,
    }
  }
}
