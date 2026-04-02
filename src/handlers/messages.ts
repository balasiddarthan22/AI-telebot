import { Bot } from "grammy";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { parseCalendarIntent, generateResponse, ChatMessage } from "../services/gemini";
import {
  createOAuth2Client,
  listUpcomingEvents,
  addEvent,
  getFreeBusy,
  findFreeSlots,
  CalendarEvent,
} from "../services/calendar";

// Pending confirmations: telegramId -> event to confirm
const pendingConfirmations = new Map<number, CalendarEvent>();

function getOAuthClientForUser(
  tokens: { accessToken?: string | null; refreshToken?: string | null; expiryDate?: number | null },
  convex: ConvexClient,
  telegramId: number
) {
  const client = createOAuth2Client();
  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiryDate ?? undefined,
  });

  // Silently save refreshed tokens back to Convex
  client.on("tokens", async (newTokens) => {
    if (newTokens.access_token) {
      try {
        await convex.mutation(api.users.saveGoogleTokens, {
          telegramId,
          accessToken: newTokens.access_token,
          refreshToken: newTokens.refresh_token ?? tokens.refreshToken ?? "",
          expiryDate: newTokens.expiry_date ?? Date.now() + 3600 * 1000,
        });
      } catch {
        // non-critical, ignore
      }
    }
  });

  return client;
}

function formatEventsGroupedByDay(events: CalendarEvent[]): string {
  const groups = new Map<string, CalendarEvent[]>();

  for (const e of events) {
    const day = e.start.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(e);
  }

  const lines: string[] = [];
  for (const [day, dayEvents] of groups) {
    lines.push(`${day}`);
    for (const e of dayEvents) {
      const time = e.start.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
      lines.push(`  • ${e.title} — ${time}`);
    }
  }
  return lines.join("\n");
}

export function registerMessageHandler(bot: Bot, convex: ConvexClient) {
  bot.on("message:text", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    try {
      const userData = await convex.query(api.users.getUserTokens, {
        telegramId: user.id,
      });

      const today = new Date().toISOString().split("T")[0];
      const firstName = userData?.firstName ?? user.first_name;

      // Save user message to history
      await convex.mutation(api.users.saveMessage, {
        telegramId: user.id,
        role: "user",
        content: text,
      });

      const history = (await convex.query(api.users.getRecentMessages, {
        telegramId: user.id,
      })) as ChatMessage[];

      // No calendar connected — still allow general chat
      if (!userData?.accessToken) {
        const intent = await parseCalendarIntent(text, today);
        if (intent.action !== "unknown") {
          const reply = "You haven't connected your Google Calendar yet. Use /connect to get started.";
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
          return;
        }
        const reply = await generateResponse(text, history.slice(0, -1), undefined, firstName);
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      const oauth2Client = getOAuthClientForUser(userData, convex, user.id);

      // Handle pending confirmation
      if (pendingConfirmations.has(user.id)) {
        const pending = pendingConfirmations.get(user.id)!;
        const answer = text.trim().toLowerCase();

        if (answer === "yes" || answer === "y" || answer === "yeah" || answer === "yep") {
          pendingConfirmations.delete(user.id);
          await addEvent(oauth2Client, pending);
          const display = pending.start.toLocaleString("en-US", {
            weekday: "long", month: "long", day: "numeric",
            hour: "numeric", minute: "2-digit",
          });
          const reply = `Done, added "${pending.title}" on ${display}.`;
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        } else {
          pendingConfirmations.delete(user.id);
          const reply = "Cancelled, nothing was added.";
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        }
        return;
      }

      const intent = await parseCalendarIntent(text, today);

      switch (intent.action) {
        case "list_events": {
          const events = await listUpcomingEvents(oauth2Client);
          if (events.length === 0) {
            const reply = "No upcoming events found.";
            await ctx.reply(reply);
            await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
            return;
          }
          const reply = "Your upcoming events:\n\n" + formatEventsGroupedByDay(events);
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
          break;
        }

        case "add_event": {
          if (!intent.title || !intent.date) {
            const reply = "Need at least a title and date — could you be more specific?";
            await ctx.reply(reply);
            await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
            return;
          }

          const [hour, minute] = (intent.time ?? "09:00").split(":").map(Number);
          const start = new Date(
            `${intent.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`
          );
          const end = new Date(start.getTime() + (intent.duration ?? 60) * 60 * 1000);
          const event: CalendarEvent = { title: intent.title, start, end };

          const display = start.toLocaleString("en-US", {
            weekday: "long", month: "long", day: "numeric",
            hour: "numeric", minute: "2-digit",
          });

          pendingConfirmations.set(user.id, event);
          const reply = `Add "${intent.title}" on ${display}? (yes/no)`;
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
          break;
        }

        case "find_free_time": {
          const targetDate = intent.date ?? today;
          const dayStart = new Date(`${targetDate}T08:00:00`);
          const dayEnd = new Date(`${targetDate}T20:00:00`);

          const busy = await getFreeBusy(oauth2Client, dayStart, dayEnd);
          const freeSlots = findFreeSlots(busy, dayStart, dayEnd, 60);

          if (freeSlots.length === 0) {
            const reply = `No free slots on ${targetDate}.`;
            await ctx.reply(reply);
            await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
            return;
          }

          const lines = freeSlots.map((s) => {
            const from = s.start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
            const to = s.end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
            return `• ${from} – ${to}`;
          });

          const reply = `Free time on ${targetDate}:\n\n` + lines.join("\n");
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
          break;
        }

        default: {
          const events = await listUpcomingEvents(oauth2Client);
          const eventSummary =
            events.length === 0
              ? "No upcoming events."
              : events.map((e) => `- ${e.title} on ${e.start.toDateString()}`).join("\n");

          const reply = await generateResponse(text, history.slice(0, -1), eventSummary, firstName);
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        }
      }
    } catch (err) {
      console.error("Message handler error:", err);
      await ctx.reply("Something went wrong. Please try again.");
    }
  });
}
