import { Router } from "express";
import { ethers, Interface } from "ethers";

const tradesRouter = Router();

tradesRouter.get("/:curveAddress", async (req, res) => {
  const curveAddress = req.params.curveAddress;

  if (!ethers.isAddress(curveAddress)) {
    return res.status(400).json({ error: "Invalid curve address" });
  }

  try {
    const provider = new ethers.JsonRpcProvider(
      "https://data-seed-prebsc-1-s1.binance.org:8545"
    );

    const curveABI = [
      "event Bought(address indexed buyer, uint256 ethIn, uint256 tokensOut)",
      "event Sold(address indexed seller, uint256 tokensIn, uint256 ethOut)",
    ];

    const iface = new Interface(curveABI);

    const boughtEvent = iface.getEvent("Bought");
    const soldEvent = iface.getEvent("Sold");

    if (!boughtEvent || !soldEvent) {
      return res.status(500).json({ error: "Event not found in ABI" });
    }

    const boughtTopic = boughtEvent.topicHash;
    const soldTopic = soldEvent.topicHash;

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = currentBlock - 500;

    const logs = await provider.getLogs({
      address: curveAddress,
      fromBlock,
      toBlock: currentBlock,
      topics: [[boughtTopic, soldTopic]],
    });

    const trades = logs.map((log) => {
      const isBuy = log.topics[0] === boughtTopic;
      const decoded = iface.decodeEventLog(
        isBuy ? "Bought" : "Sold",
        log.data,
        log.topics
      );

      return {
        hash: log.transactionHash,
        time: new Date().toISOString(),
        buyer: isBuy ? decoded.buyer : curveAddress,
        seller: isBuy ? curveAddress : decoded.seller,
        amount: parseFloat(
          ethers.formatUnits(isBuy ? decoded.tokensOut : decoded.tokensIn, 18)
        ),
        bnbAmount: parseFloat(
          ethers.formatUnits(isBuy ? decoded.ethIn : decoded.ethOut, 18)
        ),
        action: isBuy ? "buy" : "sell",
      };
    });

    res.status(200).json(trades);
  } catch (err) {
    console.error("Error fetching trades:", err);
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

export default tradesRouter;
