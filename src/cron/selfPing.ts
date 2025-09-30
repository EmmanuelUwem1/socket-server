import cron from "node-cron";
import https from "https";



const PING_URL =  process.env.PING_URL!;
;

export const startSelfPing = () => {
  cron.schedule("*/13 * * * *", () => {
    https
      .get(PING_URL, (res) => {
        console.log(`Pinged ${PING_URL} - Status: ${res.statusCode}`);
      })
      .on("error", (err) => {
        console.error("Ping failed:", err.message);
      });
  });
};
