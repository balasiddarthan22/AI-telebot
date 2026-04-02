import "dotenv/config";
import { Bot } from "grammy";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { registerCommands } from "./handlers/commands";
import { registerMessageHandler } from "./handlers/messages";
import { startOAuthServer } from "./server";
import { createOAuth2Client, listUpcomingEvents } from "./services/calendar";

const token = process.env.TELEGRAM_BOT_TOKEN;
const convexUrl = process.env.CONVEX_URL;

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing from .env");
if (!convexUrl) throw new Error("CONVEX_URL is missing from .env");

const bot = new Bot(token);
const convex = new ConvexClient(convexUrl);

registerCommands(bot, convex);
registerMessageHandler(bot, convex);
startOAuthServer(convex);

// Reminder polling — check every minute for events starting in ~15 minutes
const REMINDER_WINDOW_MS = 15 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

async function checkReminders() {
  try {
    const users = await convex.query(api.users.getAllConnectedUsers, {});
    const now = Date.now();

    for (const user of users) {
      try {
        const oauth2Client = createOAuth2Client();
        oauth2Client.setCredentials({
          access_token: user.accessToken,
          refresh_token: user.refreshToken,
          expiry_date: user.expiryDate,
        });

        const events = await listUpcomingEvents(oauth2Client, 20);

        for (const event of events) {
          if (!event.id) continue;

          const msUntilStart = event.start.getTime() - now;
          if (msUntilStart > 0 && msUntilStart <= REMINDER_WINDOW_MS) {
            const alreadySent = await convex.query(api.users.isEventReminded, {
              telegramId: user.telegramId,
              eventId: event.id,
            });

            if (!alreadySent) {
              const minutesAway = Math.round(msUntilStart / 60000);
              await bot.api.sendMessage(
                user.telegramId,
                `Heads up — "${event.title}" starts in ${minutesAway} minutes.`
              );
              await convex.mutation(api.users.markEventReminded, {
                telegramId: user.telegramId,
                eventId: event.id,
              });
            }
          }
        }
      } catch {
        // Skip this user if their tokens are broken
      }
    }
  } catch (err) {
    console.error("Reminder check error:", err);
  }
}

setInterval(checkReminders, CHECK_INTERVAL_MS);

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start();
console.log("Bot is running…");
