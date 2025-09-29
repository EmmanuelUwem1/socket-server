import express from "express";
import { ethers, Interface } from "ethers";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import compression from "compression";

const variable = "76fe10d22ab94317bceaa64fa2974ee0";

const app = express();
app.use(cors());
app.use(compression());

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

type Trade = {
  hash: string;
  time: string;
  buyer: string;
  seller: string;
  amount: number;
  bnbAmount: number;
  action: "buy" | "sell";
};

const pairAddress = "0x1df65d3a75aecd000a9c17c97e99993af01dbcd1";
const pairABI = [
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
];

let tradeBuffer: Trade[] = [];
const clientLastRequest: Record<string, number> = {};

function emitNewTrade(trade: Trade) {
  tradeBuffer.unshift(trade);
  if (tradeBuffer.length > 30) tradeBuffer = tradeBuffer.slice(0, 30);
  console.log("New Trade:", trade);
  io.emit("trades", trade); // emit only the latest trade
}

function attachSwapListener(contract: ethers.Contract) {
  contract.on(
    "Swap",
    (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      const amount0InBN = ethers.toBigInt(amount0In);
      const amount1InBN = ethers.toBigInt(amount1In);
      const amount0OutBN = ethers.toBigInt(amount0Out);
      const amount1OutBN = ethers.toBigInt(amount1Out);

      let ocicatRaw: bigint;
      let bnbRaw: bigint;
      let action: "buy" | "sell";

      if (amount1OutBN > 0n) {
        // BUY: Ocicat out, BNB in
        ocicatRaw = amount1OutBN;
        bnbRaw = amount0InBN;
        action = "buy";
      } else if (amount1InBN > 0n) {
        // SELL: Ocicat in, BNB out
        ocicatRaw = amount1InBN;
        bnbRaw = amount0OutBN;
        action = "sell";
      } else {
        // Invalid trade: no Ocicat movement
        return;
      }

      const ocicatAmount = parseFloat(ethers.formatUnits(ocicatRaw, 6));
      const bnbAmount = parseFloat(ethers.formatUnits(bnbRaw, 18));

      if (ocicatAmount === 0 || bnbAmount === 0) return; // skip empty trades

      const trade: Trade = {
        hash: event?.log?.transactionHash ?? "unknown",
        time: new Date().toISOString(),
        buyer: sender,
        seller: to,
        amount: ocicatAmount,
        bnbAmount: bnbAmount,
        action,
      };

      emitNewTrade(trade);
    }
  );
}




async function fetchInitialTrades() {
  try {
    const rpcProvider = new ethers.JsonRpcProvider(
      `https://bsc-mainnet.nodereal.io/v1/${variable}`
    );

    const iface = new Interface(pairABI);
    const currentBlock = await rpcProvider.getBlockNumber();
    const fromBlock = currentBlock - 500;

    const swapEvent = iface.getEvent("Swap");
    if (!swapEvent) {
      console.error("Swap event not found in ABI");
      return;
    }

    const logs = await rpcProvider.getLogs({
      address: pairAddress,
      fromBlock,
      toBlock: currentBlock,
      topics: [swapEvent.topicHash],
    });

    const sortedLogs = logs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return b.blockNumber - a.blockNumber;
      }
      return b.transactionIndex - a.transactionIndex;
    });

    tradeBuffer = sortedLogs.slice(0, 30).map((log) => {
      const decoded = iface.decodeEventLog("Swap", log.data, log.topics);
      const amountOutBN = ethers.toBigInt(decoded.amount1Out);
      const amountInBN = ethers.toBigInt(decoded.amount0In);

      return {
        hash: log.transactionHash,
        time: new Date().toISOString(),
        buyer: decoded.sender,
        seller: decoded.to,
        amount: parseFloat(ethers.formatUnits(amountOutBN, 6)),
        bnbAmount: parseFloat(ethers.formatUnits(amountInBN, 18)),
        action: amountOutBN > 0n ? "buy" : "sell",
      };
    });
  } catch (err) {
    console.error("Failed to fetch initial trades:", err);
  }
}

let provider = new ethers.WebSocketProvider(
  `wss://bsc-mainnet.nodereal.io/ws/v1/${variable}`
);
let contract = new ethers.Contract(pairAddress, pairABI, provider);
attachSwapListener(contract);

io.on("connection", async (socket) => {
  const ip = socket.handshake.address;
  const now = Date.now();

  if (now - (clientLastRequest[ip] || 0) < 5000) {
    socket.disconnect(true);
    return;
  }

  clientLastRequest[ip] = now;
  console.log(`Client connected: ${ip}`);

  if (tradeBuffer.length === 0) {
    await fetchInitialTrades();
  }

  socket.emit("trades", tradeBuffer); // send full buffer once

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${ip}`);
  });
});

setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`Memory: RSS ${mem.rss}, Heap Used ${mem.heapUsed}`);
}, 60000);

(provider.websocket as any).on("close", () => {
  console.log("WebSocket closed. Reconnecting...");
  setTimeout(() => {
    provider = new ethers.WebSocketProvider(
      `wss://bsc-mainnet.nodereal.io/ws/v1/${variable}`
    );
    contract = new ethers.Contract(pairAddress, pairABI, provider);
    attachSwapListener(contract);
    console.log("Reconnected and listener reattached.");
  }, 3000);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
