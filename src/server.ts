import express from "express";
import { ethers, Interface } from "ethers";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import compression from "compression";
import { startSelfPing } from "./cron/selfPing.js";
import dotenv from "dotenv";
import { io as ClientIO } from "socket.io-client";
import fs from "fs";
import path from "path";

dotenv.config();

const variable = process.env.NODE_REAL_API_KEY!;
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

//  Trade type
type Trade = {
  hash: string;
  time: string;
  buyer?: string;
  seller?: string;
  amount: number;
  bnbAmount: number;
  action: string;
  source: string;
  ticker?: string;
  image?: string;
};


//  File-based trade store
const tradeFilePath = path.join(process.cwd(), "trades.json");

function saveTradesToFile(trades: Trade[]) {
  fs.writeFileSync(tradeFilePath, JSON.stringify(trades, null, 2));
}

function loadTradesFromFile(): Trade[] {
  if (fs.existsSync(tradeFilePath)) {
    const data = fs.readFileSync(tradeFilePath, "utf-8");
    return JSON.parse(data);
  }
  return [];
}

let tradeBuffer: Trade[] = loadTradesFromFile();

//  External transaction stream
const externalSocket = ClientIO("https://fudclub-test.up.railway.app/events", {
  transports: ["websocket"],
});

externalSocket.on("connect", () => {
  console.log("Connected to external transaction stream");
});

externalSocket.on("transactions:new", (tx) => {
  console.log("📦 Received external transaction:", tx);

  const trade: Trade = {
    hash: tx.hash ?? "unknown",
    time: new Date().toISOString(),
    buyer: tx.wallet ?? "unknown",
    seller: "",
    amount: tx.amountInToken ?? 0,
    bnbAmount: tx.amountInChainCurrency ?? 0,
    action: tx.type ?? "buy",
    source: "external",
    ticker: tx.tokenDetails?.ticker ?? "Unknown",
    image: tx.tokenDetails?.image ?? "/default_token.png",
  };

  console.log("✅ Normalized external trade:", trade);

  tradeBuffer.unshift(trade);
  if (tradeBuffer.length > 100) tradeBuffer = tradeBuffer.slice(0, 100);
  saveTradesToFile(tradeBuffer);
  io.emit("transaction:new", trade);
});


// Client connection
io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  console.log("📤 Sending trade history...");
  socket.emit("transaction:history", tradeBuffer);

  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});


// Ocicat trade listener
const pairAddress = "0x1df65d3a75aecd000a9c17c97e99993af01dbcd1";
const pairABI = [
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
];

function emitNewTrade(trade: Trade) {
  trade.source = "ocicat";
  trade.ticker = "OCICAT";
  trade.image = "/cat_bg.jpg";

  console.log("🐾 Emitting Ocicat trade:", trade);

  tradeBuffer.unshift(trade);
  if (tradeBuffer.length > 100) tradeBuffer = tradeBuffer.slice(0, 100);
  saveTradesToFile(tradeBuffer);
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
      let action: string;

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
        source: "ocicat",
      };

      emitNewTrade(trade);
    }
  );
}

//  Initial trade fetch
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

    const initialTrades = sortedLogs.slice(0, 30).map((log) => {
      const decoded = iface.decodeEventLog("Swap", log.data, log.topics);
      const amountOutBN = ethers.toBigInt(decoded.amount1Out);
      const amountInBN = ethers.toBigInt(decoded.amount0In);

      console.log(`📥 Loaded ${initialTrades.length} initial Ocicat trades`);


      return {
        hash: log.transactionHash,
        time: new Date().toISOString(),
        buyer: decoded.sender,
        seller: decoded.to,
        amount: parseFloat(ethers.formatUnits(amountOutBN, 6)),
        bnbAmount: parseFloat(ethers.formatUnits(amountInBN, 18)),
        action: amountOutBN > 0n ? "buy" : "sell",
        source: "ocicat",
      };
    });

    tradeBuffer = [...initialTrades, ...tradeBuffer].slice(0, 100);
    saveTradesToFile(tradeBuffer);
  } catch (err) {
    console.error("Failed to fetch initial trades:", err);
  }
}

// 🔁 WebSocket reconnect logic
let provider = new ethers.WebSocketProvider(
  `wss://bsc-mainnet.nodereal.io/ws/v1/${variable}`
);
let contract = new ethers.Contract(pairAddress, pairABI, provider);
attachSwapListener(contract);

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
