import express from "express";
import { ethers, Interface } from "ethers";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import compression from "compression";
import { startSelfPing } from "./cron/selfPing.js";
import dotenv from "dotenv";
import transactionsRouter from "./routes/transactions.js";
import { transactionStore } from "./store/transactions.js";
import { io as ClientIO } from "socket.io-client";

dotenv.config();

const variable = process.env.NODE_REAL_API_KEY!;
const app = express();
app.use(cors());
app.use(compression());
app.use("/transactions", transactionsRouter);

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 🔌 External WebSocket listener for transactions
const externalSocket = ClientIO("https://fudclub-test.up.railway.app/events", {
  transports: ["websocket"],
});

externalSocket.on("connect", () => {
  console.log("Connected to external transaction stream");
});

externalSocket.on("transactions:new", (tx) => {
  console.log("Received external transaction:", tx);
  transactionStore.unshift(tx);
  if (transactionStore.length > 100) {
    transactionStore.splice(100);
  }
  io.emit("transaction:new", tx);
});

// Emit full transaction history on first connection
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("transaction:history", transactionStore);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// 🛠 Trade logic
const pairAddress = "0x1df65d3a75aecd000a9c17c97e99993af01dbcd1";
const pairABI = [
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
];

type Trade = {
  hash: string;
  time: string;
  buyer: string;
  seller: string;
  amount: number;
  bnbAmount: number;
  action: "buy" | "sell";
};

let tradeBuffer: Trade[] = [];
const clientLastRequest: Record<string, number> = {};

function emitNewTrade(trade: Trade) {
  tradeBuffer.unshift(trade);
  if (tradeBuffer.length > 30) tradeBuffer = tradeBuffer.slice(0, 30);
  io.emit("trades", trade);
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
        ocicatRaw = amount1OutBN;
        bnbRaw = amount0InBN;
        action = "buy";
      } else if (amount1InBN > 0n) {
        ocicatRaw = amount1InBN;
        bnbRaw = amount0OutBN;
        action = "sell";
      } else return;

      const ocicatAmount = parseFloat(ethers.formatUnits(ocicatRaw, 6));
      const bnbAmount = parseFloat(ethers.formatUnits(bnbRaw, 18));
      if (ocicatAmount === 0 || bnbAmount === 0) return;

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
    if (!swapEvent) return;

    const logs = await rpcProvider.getLogs({
      address: pairAddress,
      fromBlock,
      toBlock: currentBlock,
      topics: [swapEvent.topicHash],
    });

    const sortedLogs = logs.sort((a, b) =>
      a.blockNumber !== b.blockNumber
        ? b.blockNumber - a.blockNumber
        : b.transactionIndex - a.transactionIndex
    );

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

//  Call fetchInitialTrades immediately
(async () => {
  await fetchInitialTrades();
})();

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

app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

startSelfPing();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
