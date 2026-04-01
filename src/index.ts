import "dotenv/config";
import { Bot } from "grammy";
import { ConvexClient } from "convex/browser";
import { registerCommands } from "./handlers/commands";
import { registerMessageHandler } from "./handlers/messages";

const token = process.env.TELEGRAM_BOT_TOKEN;
const convexUrl = process.env.CONVEX_URL;

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing from .env");
if (!convexUrl) throw new Error("CONVEX_URL is missing from .env");

const bot = new Bot(token);
const convex = new ConvexClient(convexUrl);

registerCommands(bot, convex);
registerMessageHandler(bot, convex);

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start();
console.log("Bot is running…");
