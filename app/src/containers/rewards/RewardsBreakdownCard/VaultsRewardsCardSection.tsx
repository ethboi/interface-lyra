import Box from '@lyra/ui/components/Box'
import { CardElement } from '@lyra/ui/components/Card'
import CardSection from '@lyra/ui/components/Card/CardSection'
import Flex from '@lyra/ui/components/Flex'
import Grid from '@lyra/ui/components/Grid'
import TextShimmer from '@lyra/ui/components/Shimmer/TextShimmer'
import Text from '@lyra/ui/components/Text'
import { MarginProps } from '@lyra/ui/types'
import formatBalance from '@lyra/ui/utils/formatBalance'
import formatPercentage from '@lyra/ui/utils/formatPercentage'
import { AccountRewardEpoch, GlobalRewardEpoch, Market, Network } from '@lyrafinance/lyra-js'
import React, { useMemo } from 'react'

import MarketImage from '@/app/components/common/MarketImage'
import TokenAmountText from '@/app/components/common/TokenAmountText'
import TokenAmountTextShimmer from '@/app/components/common/TokenAmountText/TokenAmountTextShimmer'
import TokenAPYRangeText from '@/app/components/common/TokenAPYRangeText'
import VaultAPYTooltip from '@/app/components/common/VaultAPYTooltip'
import useNetwork from '@/app/hooks/account/useNetwork'
import withSuspense from '@/app/hooks/data/withSuspense'
import useTradeBalances from '@/app/hooks/market/useTradeBalances'
import useLatestRewardEpoch from '@/app/hooks/rewards/useLatestRewardEpoch'
import formatTokenName from '@/app/utils/formatTokenName'

type Props = MarginProps

type RowProps = {
  accountRewardEpoch?: AccountRewardEpoch | null
  globalRewardEpoch: GlobalRewardEpoch
  market: Market
}

const VaultRewardsMyLiquidity = withSuspense(
  ({ market }: { market: Market }) => {
    const balances = useTradeBalances(market)
    // TODO: @dappbeast change to liquidity $$
    return (
      <Text variant="secondary">{formatBalance(balances.liquidityToken.balance, balances.liquidityToken.symbol)}</Text>
    )
  },
  () => <TextShimmer variant="secondary" width={50} />
)

const VaultRewardsMarketRow = ({ accountRewardEpoch, globalRewardEpoch, market }: RowProps) => {
  const marketName = market.name
  const marketAddress = market.address
  const { op: opRewards, lyra: lyraRewards } = accountRewardEpoch
    ? accountRewardEpoch.vaultRewards(marketAddress)
    : { op: 0, lyra: 0 }
  const { op: opApy, lyra: lyraApy } = accountRewardEpoch
    ? accountRewardEpoch.vaultApy(marketAddress)
    : globalRewardEpoch.minVaultApy(marketAddress)
  const maxApy = globalRewardEpoch.maxVaultApy(marketAddress).total
  const apyMultiplier = accountRewardEpoch ? accountRewardEpoch.vaultApyMultiplier(marketAddress) : 1
  const stakedLyraBalance = accountRewardEpoch ? accountRewardEpoch.stakedLyraBalance : 0

  return (
    <Grid mb={8} sx={{ gridTemplateColumns: ['1fr 1fr', '1fr 1fr 1fr 1fr 1fr'], gridColumnGap: 4, gridRowGap: 6 }}>
      <Flex flexDirection="column" justifyContent="space-between">
        <Text variant="secondary" color="secondaryText" mb={2}>
          Vault
        </Text>
        <Flex alignItems="flex-end">
          <MarketImage market={market} />
          <Text variant="secondary" ml={2}>
            {formatTokenName(market.baseToken)}
          </Text>
        </Flex>
      </Flex>
      <Flex flexDirection="column" justifyContent="space-between">
        <Text variant="secondary" color="secondaryText" mb={2}>
          Your Liquidity
        </Text>
        <VaultRewardsMyLiquidity market={market} />
      </Flex>
      <Flex flexDirection="column" justifyContent="space-between">
        <Text variant="secondary" color="secondaryText" mb={2}>
          APY
        </Text>
        {marketName.toLowerCase() === 'sol' ? (
          ' - '
        ) : (
          <VaultAPYTooltip
            marketName={marketName}
            opApy={opApy}
            lyraApy={lyraApy}
            apyMultiplier={apyMultiplier}
            stakedLyraBalance={stakedLyraBalance}
          >
            <TokenAPYRangeText
              tokenNameOrAddress={['stkLyra', 'OP']}
              variant="secondary"
              color="primaryText"
              leftValue={formatPercentage(opApy + lyraApy, true)}
              rightValue={formatPercentage(maxApy, true)}
            />
          </VaultAPYTooltip>
        )}
      </Flex>
      {lyraApy > 0 ? (
        <Flex flexDirection="column" justifyContent="space-between">
          <Text variant="secondary" color="secondaryText" mb={2}>
            Pending stkLYRA
          </Text>
          <TokenAmountText variant="secondary" tokenNameOrAddress="stkLyra" amount={lyraRewards} />
        </Flex>
      ) : null}
      {opApy > 0 ? (
        <Flex flexDirection="column" justifyContent="space-between">
          <Text variant="secondary" color="secondaryText" mb={2}>
            Pending OP
          </Text>
          <TokenAmountText variant="secondary" tokenNameOrAddress="op" amount={opRewards} />
        </Flex>
      ) : null}
    </Grid>
  )
}

const VaultRewardsMarketRows = withSuspense(
  () => {
    const network = useNetwork() // TODO: @dillon Use network again and replace Network.Optimism
    const epochs = useLatestRewardEpoch(Network.Optimism, true)
    const globalRewardEpoch = epochs?.global
    const accountRewardEpoch = epochs?.account
    const markets = useMemo(() => {
      return globalRewardEpoch
        ? globalRewardEpoch.markets.filter(market => {
            const { lyra, op } = globalRewardEpoch.totalVaultRewards(market.address)
            return lyra > 0 || op > 0
          })
        : []
    }, [globalRewardEpoch])
    return (
      <>
        {globalRewardEpoch
          ? markets.map(market => (
              <VaultRewardsMarketRow
                key={market.name}
                market={market}
                globalRewardEpoch={globalRewardEpoch}
                accountRewardEpoch={accountRewardEpoch}
              />
            ))
          : null}
      </>
    )
  },
  () => {
    return (
      <Box mb={8}>
        <TextShimmer variant="secondary" mb={2} />
        <TokenAmountTextShimmer variant="secondary" width={150} />
      </Box>
    )
  }
)

const VaultsRewardsCardSection = ({ ...marginProps }: Props): CardElement => {
  return (
    <CardSection {...marginProps}>
      <Text variant="heading" mb={8}>
        Vault Rewards
      </Text>
      <VaultRewardsMarketRows />
      <Text maxWidth={['100%', '75%']} variant="secondary" color="secondaryText">
        Lyra's vault program rewards liquidity providers with Staked LYRA and OP tokens every 2 weeks. Liquidity
        providers can stake LYRA to boost their rewards.
      </Text>
    </CardSection>
  )
}

export default VaultsRewardsCardSection
