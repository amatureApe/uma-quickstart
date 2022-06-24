import { MIN_INT_VALUE } from "@uma/common";
import { OptimisticOracle } from "@uma/contracts-node/dist/packages/contracts-node/typechain/core/ethers";
import { EventBasedPredictionMarket, ExpandedERC20, OptimisticOracleV2 } from "../typechain";
import { amountToSeedWallets } from "./constants";
import { eventBasedPredictionMarketFixture } from "./fixtures/EventBasedPredictionMarket.Fixture";
import { umaEcosystemFixture } from "./fixtures/UmaEcosystem.Fixture";
import { BigNumber, Contract, ethers, expect, SignerWithAddress, toWei } from "./utils";

let eventBasedPredictionMarket: EventBasedPredictionMarket, usdc: Contract;
let optimisticOracle: OptimisticOracleV2, longToken: ExpandedERC20, shortToken: ExpandedERC20;
let deployer: SignerWithAddress, sponsor: SignerWithAddress, holder: SignerWithAddress, disputer: SignerWithAddress;

describe("EventBasedPredictionMarket functions", function () {
  const proposeAndSettleOptimisticOraclePrice = async (price: BigNumber) => {
    const ancillaryData = await eventBasedPredictionMarket.customAncillaryData();
    const identifier = await eventBasedPredictionMarket.priceIdentifier();
    const expirationTimestamp = await eventBasedPredictionMarket.expirationTimestamp();
    const optimisticOracleLivenessTime = await eventBasedPredictionMarket.optimisticOracleLivenessTime();

    await optimisticOracle.proposePrice(
      eventBasedPredictionMarket.address,
      identifier,
      expirationTimestamp,
      ancillaryData,
      price
    );

    await optimisticOracle.setCurrentTime((await optimisticOracle.getCurrentTime()).add(optimisticOracleLivenessTime));

    await optimisticOracle.settle(eventBasedPredictionMarket.address, identifier, expirationTimestamp, ancillaryData);
  };

  beforeEach(async function () {
    [deployer, sponsor, holder, disputer] = await ethers.getSigners();

    ({ optimisticOracle } = await umaEcosystemFixture());
    ({ eventBasedPredictionMarket, usdc, longToken, shortToken } = await eventBasedPredictionMarketFixture());

    // mint some fresh tokens for the sponsor, deployer and disputer.
    await usdc.mint(sponsor.address, amountToSeedWallets);
    await usdc.mint(deployer.address, amountToSeedWallets);
    await usdc.mint(disputer.address, amountToSeedWallets);

    // Approve the EventBasedPredictionMarket to spend tokens
    await usdc.connect(sponsor).approve(eventBasedPredictionMarket.address, amountToSeedWallets);
    await usdc.approve(eventBasedPredictionMarket.address, amountToSeedWallets);

    // Approve the Optimistic Oracle to spend bond tokens
    await usdc.approve(optimisticOracle.address, amountToSeedWallets);
    await usdc.connect(disputer).approve(optimisticOracle.address, amountToSeedWallets);

    await eventBasedPredictionMarket.initializeMarket();
  });

  it("Event-based mint, redeem and expire lifecycle.", async function () {
    // Create some sponsor tokens. Send half to the holder account.
    expect(await usdc.balanceOf(sponsor.address)).to.equal(amountToSeedWallets);
    expect(await longToken.balanceOf(sponsor.address)).to.equal(0);
    expect(await shortToken.balanceOf(sponsor.address)).to.equal(0);

    await eventBasedPredictionMarket.connect(sponsor).create(toWei(100));
    expect(await longToken.balanceOf(sponsor.address)).to.equal(toWei(100));
    expect(await shortToken.balanceOf(sponsor.address)).to.equal(toWei(100));
    expect(await usdc.balanceOf(sponsor.address)).to.equal(amountToSeedWallets.sub(toWei(100)));

    // Send half the long tokens to the holder. This would happen by the holder buying them on a dex.
    await longToken.connect(sponsor).transfer(holder.address, toWei("50"));

    // Token sponsor redeems half their remaining long tokens, along with the associated short tokens.
    await eventBasedPredictionMarket.connect(sponsor).redeem(toWei("25"));

    // Sponsor should have 25 remaining long tokens and 75 remaining short tokens. They should have been refunded 25 collateral.
    expect(await usdc.balanceOf(sponsor.address)).to.equal(amountToSeedWallets.sub(toWei(100)).add(toWei(25))); // -100 after mint + 25 redeemed.
    expect(await longToken.balanceOf(sponsor.address)).to.equal(toWei("25"));
    expect(await shortToken.balanceOf(sponsor.address)).to.equal(toWei("75"));

    // holder should not be able to call redeem as they only have the long token and redemption requires a pair.
    await expect(eventBasedPredictionMarket.connect(holder).redeem(toWei(25))).to.be.revertedWith(
      "VM Exception while processing transaction: reverted with reason string 'ERC20: burn amount exceeds balance'"
    );

    // Propose and settle the optimistic oracle price.
    // In this case we are answering a YES_OR_NO_QUERY price request with a YES answer.
    await proposeAndSettleOptimisticOraclePrice(toWei(1));

    // The EventBasedPredictionMarket should have received the settlement price with the priceSettled callback.
    expect(await eventBasedPredictionMarket.receivedSettlementPrice()).to.equal(true);

    // Holder redeems his long tokens.
    await eventBasedPredictionMarket.connect(holder).settle(toWei("50"), 0);
    expect(await eventBasedPredictionMarket.receivedSettlementPrice()).to.equal(true);
    expect(await usdc.balanceOf(holder.address)).to.equal(toWei(50)); // holder should have gotten 1 collateral per synthetic.
    expect(await longToken.balanceOf(holder.address)).to.equal(0); // the long tokens should have been burned.

    // Sponsor redeem remaining tokens. They return the remaining 25 long and 75 short.
    // Long tokens should return 25 collateral.
    // Short tokens should return 0 collateral.
    const initialSponsorBalance = await usdc.balanceOf(sponsor.address);
    await eventBasedPredictionMarket.connect(sponsor).settle(toWei("25"), toWei("75"));
    expect(await usdc.balanceOf(sponsor.address)).to.equal(initialSponsorBalance.add(toWei(25)));
    expect(await longToken.balanceOf(sponsor.address)).to.equal(0);
    expect(await shortToken.balanceOf(sponsor.address)).to.equal(0);

    // long short pair should have no collateral left in it as everything has been redeemed.
    expect(await usdc.balanceOf(eventBasedPredictionMarket.address)).to.equal(0);
  });

  it("Unresolved questions pay back 0.5 units of collateral for long and short tokens.", async function () {
    await eventBasedPredictionMarket.connect(sponsor).create(toWei(100));
    expect(await longToken.balanceOf(sponsor.address)).to.equal(toWei(100));
    expect(await shortToken.balanceOf(sponsor.address)).to.equal(toWei(100));

    // Propose and settle the optimistic oracle price.
    // In this case we propose as a price that the answer cannot be solved.
    await proposeAndSettleOptimisticOraclePrice(toWei("0.5"));

    // Sponsor redeems his long tokens.
    await eventBasedPredictionMarket.connect(sponsor).settle(toWei("100"), 0);
    expect(await usdc.balanceOf(sponsor.address)).to.equal(amountToSeedWallets.sub(toWei(50)));
    expect(await longToken.balanceOf(holder.address)).to.equal(0);

    // Sponsor redeems his short tokens.
    await eventBasedPredictionMarket.connect(sponsor).settle(0, toWei("100"));
    expect(await usdc.balanceOf(sponsor.address)).to.equal(amountToSeedWallets);
    expect(await shortToken.balanceOf(holder.address)).to.equal(0);
  });

  it("Early expiring is not allowed.", async function () {
    const ancillaryData = await eventBasedPredictionMarket.customAncillaryData();
    const identifier = await eventBasedPredictionMarket.priceIdentifier();
    const expirationTimestamp = await eventBasedPredictionMarket.expirationTimestamp();

    await expect(
      optimisticOracle.proposePrice(
        eventBasedPredictionMarket.address,
        identifier,
        expirationTimestamp,
        ancillaryData,
        MIN_INT_VALUE
      )
    ).to.be.revertedWith(
      "VM Exception while processing transaction: reverted with reason string 'Cannot propose 'too early''"
    );
  });

  it("EventBasedPredictionMarket lifecycle events.", async function () {
    await eventBasedPredictionMarket.connect(sponsor).create(toWei(100));

    const createEvents = await eventBasedPredictionMarket.queryFilter(
      eventBasedPredictionMarket.filters.TokensCreated()
    );
    expect(createEvents[0].args.sponsor === sponsor.address);

    // Send half the long tokens to the holder. This would happen by the holder buying them on a dex.
    await longToken.connect(sponsor).transfer(holder.address, toWei("50"));

    // Token sponsor redeems half their remaining long tokens, along with the associated short tokens.
    await eventBasedPredictionMarket.connect(sponsor).redeem(toWei("25"));

    const tokensRedeemedEvents = await eventBasedPredictionMarket.queryFilter(
      eventBasedPredictionMarket.filters.TokensRedeemed()
    );
    expect(tokensRedeemedEvents[0].args.sponsor === sponsor.address);

    await proposeAndSettleOptimisticOraclePrice(toWei(1));

    // Holder redeems his long tokens.
    await eventBasedPredictionMarket.connect(holder).settle(toWei("50"), 0);

    const positionSettledEvents = await eventBasedPredictionMarket.queryFilter(
      eventBasedPredictionMarket.filters.PositionSettled()
    );
    expect(positionSettledEvents[0].args.sponsor === holder.address);
  });

  it("Event-based dispute workflow with auto re-request on dispute.", async function () {
    const requestSubmissionTimestamp = await eventBasedPredictionMarket.expirationTimestamp();
    const proposalSubmissionTimestamp = parseInt(requestSubmissionTimestamp.toString()) + 100;
    await optimisticOracle.setCurrentTime(proposalSubmissionTimestamp);

    const ancillaryData = await eventBasedPredictionMarket.customAncillaryData();
    const identifier = await eventBasedPredictionMarket.priceIdentifier();
    const expirationTimestamp = await eventBasedPredictionMarket.expirationTimestamp();

    await optimisticOracle.proposePrice(
      eventBasedPredictionMarket.address,
      identifier,
      expirationTimestamp,
      ancillaryData,
      0
    );

    const disputeSubmissionTimestamp = proposalSubmissionTimestamp + 100;
    await optimisticOracle.setCurrentTime(disputeSubmissionTimestamp);
    await optimisticOracle
      .connect(disputer)
      .disputePrice(eventBasedPredictionMarket.address, identifier, expirationTimestamp, ancillaryData);

    // Check that the price has been re-requested with a new expiration timestamp corresponding to the dispute timestamp.
    expect(await eventBasedPredictionMarket.expirationTimestamp()).to.equal(disputeSubmissionTimestamp);
    expect(await usdc.balanceOf(eventBasedPredictionMarket.address)).to.equal(0);

    // Sponsor creates some Long short tokens
    await eventBasedPredictionMarket.connect(sponsor).create(toWei(100));

    // Propose and settle a new undisputed price
    await proposeAndSettleOptimisticOraclePrice(toWei(1));

    // Check that the price has been settled and Long short tokens can be refunded.
    const sponsorInitialBalance = await usdc.balanceOf(sponsor.address);
    await eventBasedPredictionMarket.connect(sponsor).settle(toWei("100"), toWei("0"));
    expect(await usdc.balanceOf(sponsor.address)).to.equal(sponsorInitialBalance.add(toWei(100)));
  });
});