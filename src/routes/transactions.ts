
import { Router } from "express";
import { transactionStore } from "../store/transactions.js";

const transactionsRouter = Router();

transactionsRouter.get("/", (req, res) => {
  res.status(200).json(transactionStore);
});

export default transactionsRouter;
