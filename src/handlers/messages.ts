import { Bot } from "grammy";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { parseCalendarIntent } from "../services/gemini";
import {
  createOAuth2Client,
  listUpcomingEvents,
  addEvent,
  getFreeBusy,
  findFreeSlots,
} from "../services/calendar";

function getOAuthClientForUser(tokens: {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiryDate?: number | null;
}) {
  const client = createOAuth2Client();
  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiryDate ?? undefined,
  });
  return client;
}

export function registerMessageHandler(bot: Bot, convex: ConvexClient) {
  bot.on("message:text", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const text = ctx.message.text;

    // Ignore commands (handled elsewhere)
    if (text.startsWith("/")) return;

    const tokens = await convex.query(api.users.getUserTokens, {
      telegramId: user.id,
    });

    if (!tokens?.accessToken) {
      await ctx.reply(
        "Please connect your Google Calendar first using /connect."
      );
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const intent = await parseCalendarIntent(text, today);
    const oauth2Client = getOAuthClientForUser(tokens);

    switch (intent.action) {
      case "list_events": {
        const events = await listUpcomingEvents(oauth2Client);
        if (events.length === 0) {
          await ctx.reply("No upcoming events found.");
          return;
        }
        const lines = events.map((e) => {
          const start = e.start.toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          return `• ${e.title} — ${start}`;
        });
        await ctx.reply("Upcoming events:\n\n" + lines.join("\n"));
        break;
      }

      case "add_event": {
        if (!intent.title || !intent.date) {
          await ctx.reply(
            "I need at least a title and date to add an event. Could you be more specific?"
          );
          return;
        }

        const [hour, minute] = (intent.time ?? "09:00").split(":").map(Number);
        const start = new Date(`${intent.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`);
        const end = new Date(start.getTime() + (intent.duration ?? 60) * 60 * 1000);

        await addEvent(oauth2Client, { title: intent.title, start, end });

        const display = start.toLocaleString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        await ctx.reply(`Added "${intent.title}" on ${display}.`);
        break;
      }

      case "find_free_time": {
        const targetDate = intent.date ?? today;
        const dayStart = new Date(`${targetDate}T08:00:00`);
        const dayEnd = new Date(`${targetDate}T20:00:00`);

        const busy = await getFreeBusy(oauth2Client, dayStart, dayEnd);
        const freeSlots = findFreeSlots(busy, dayStart, dayEnd, 60);

        if (freeSlots.length === 0) {
          await ctx.reply(`No free slots found on ${targetDate}.`);
          return;
        }

        const lines = freeSlots.map((s) => {
          const from = s.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const to = s.end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          return `• ${from} – ${to}`;
        });

        await ctx.reply(`Free time on ${targetDate}:\n\n` + lines.join("\n"));
        break;
      }

      default: {
        await ctx.reply(
          "I'm not sure what you mean. Try:\n" +
            '• "Add meeting tomorrow at 2pm"\n' +
            '• "What\'s on my calendar today?"\n' +
            '• "When am I free on Friday?"'
        );
      }
    }
  });
}
