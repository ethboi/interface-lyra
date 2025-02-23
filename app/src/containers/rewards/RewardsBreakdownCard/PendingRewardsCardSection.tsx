import Box from '@lyra/ui/components/Box'
import Button from '@lyra/ui/components/Button'
import { CardElement } from '@lyra/ui/components/Card'
import CardSection from '@lyra/ui/components/Card/CardSection'
import Grid from '@lyra/ui/components/Grid'
import { IconType } from '@lyra/ui/components/Icon'
import TextShimmer from '@lyra/ui/components/Shimmer/TextShimmer'
import Text from '@lyra/ui/components/Text'
import Countdown from '@lyra/ui/components/Text/CountdownText'
import useIsMobile from '@lyra/ui/hooks/useIsMobile'
import { MarginProps } from '@lyra/ui/types'
import formatNumber from '@lyra/ui/utils/formatNumber'
import { Network } from '@lyrafinance/lyra-js'
import React from 'react'
import { useNavigate } from 'react-router-dom'

import TokenAmountText from '@/app/components/common/TokenAmountText'
import TokenAmountTextShimmer from '@/app/components/common/TokenAmountText/TokenAmountTextShimmer'
import { PageId } from '@/app/constants/pages'
import useNetwork from '@/app/hooks/account/useNetwork'
import withSuspense from '@/app/hooks/data/withSuspense'
import useLatestRewardEpoch from '@/app/hooks/rewards/useLatestRewardEpoch'
import getPagePath from '@/app/utils/getPagePath'

type Props = MarginProps

const PendingRewardsCardGridItems = withSuspense(
  () => {
    const network = useNetwork() // TODO: @dillon Use network again and replace Network.Optimism
    const epochs = useLatestRewardEpoch(Network.Optimism, true)
    const account = epochs?.account
    const global = epochs?.global
    const epochEndTimestamp = global?.endTimestamp ?? 0
    const opStakingRewards = account?.stakingRewards.op ?? 0
    const opVaultRewards = account?.totalVaultRewards.op ?? 0
    const opTradingRewards = account?.tradingRewards.op ?? 0
    const opShortCollatRewards = account?.shortCollateralRewards.op ?? 0
    const wethLyraStakingRewards = account?.wethLyraStaking.opRewards ?? 0
    const opRewards =
      opStakingRewards + opVaultRewards + opTradingRewards + opShortCollatRewards + wethLyraStakingRewards
    return (
      <>
        <Box>
          <Text variant="secondary" color="secondaryText" mb={2}>
            Pending OP
          </Text>
          <TokenAmountText tokenNameOrAddress="op" variant="secondary" amount={opRewards} />
        </Box>
        <Box>
          <Text variant="secondary" color="secondaryText" mb={2}>
            Countdown
          </Text>
          <Countdown timestamp={epochEndTimestamp} fallback="Waiting for Rewards" variant="secondary" />
        </Box>
      </>
    )
  },
  () => {
    return (
      <>
        <Box>
          <TextShimmer variant="secondary" mb={2} />
          <TokenAmountTextShimmer variant="secondary" width={150} />
        </Box>
      </>
    )
  }
)

const PendingStakedLyraText = withSuspense(
  () => {
    const network = useNetwork()
    const account = useLatestRewardEpoch(network, true)?.account
    // Omit staking rewards due to 6mo lock
    const lyraVaultRewards = account?.totalVaultRewards.lyra ?? 0
    const lyraTradingRewards = account?.tradingRewards.lyra ?? 0
    const lyraShortCollatRewards = account?.shortCollateralRewards.lyra ?? 0
    const lyraRewards = lyraVaultRewards + lyraTradingRewards + lyraShortCollatRewards
    return (
      <Text variant="heading" color="secondaryText">
        {formatNumber(lyraRewards)} stkLYRA
      </Text>
    )
  },
  () => {
    return <TextShimmer variant="heading" />
  }
)

const PendingRewardsCardSection = ({ ...marginProps }: Props): CardElement => {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  return (
    <CardSection
      justifyContent="space-between"
      isHorizontal={isMobile ? false : true}
      isVertical
      width={!isMobile ? '50%' : undefined}
      {...marginProps}
    >
      <Box>
        <Text variant="heading" mb={1}>
          Pending
        </Text>
        <PendingStakedLyraText />
      </Box>
      <Grid my={8} sx={{ gridTemplateColumns: '1fr 1fr', gridColumnGap: 4 }}>
        <PendingRewardsCardGridItems />
      </Grid>
      <Grid sx={{ gridTemplateColumns: ['1fr', '1fr 1fr'], gridColumnGap: 4, gridRowGap: 4 }}>
        <Button
          size="lg"
          label="History"
          rightIcon={IconType.ArrowRight}
          onClick={() => navigate(getPagePath({ page: PageId.RewardsHistory }))}
          target="_blank"
        />
      </Grid>
    </CardSection>
  )
}

export default PendingRewardsCardSection
