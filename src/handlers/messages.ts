import { Bot, Context } from "grammy";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { parseCalendarIntent, generateResponse, transcribeAudio, ChatMessage } from "../services/gemini";
import {
  createOAuth2Client,
  listUpcomingEvents,
  addEvent,
  deleteEvent,
  updateEvent,
  getFreeBusy,
  findFreeSlots,
  CalendarEvent,
} from "../services/calendar";

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

function matchEventsByTitle(events: CalendarEvent[], query: string): CalendarEvent[] {
  const q = query.toLowerCase();
  return events.filter((e) => e.title.toLowerCase().includes(q));
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

async function processMessage(
  ctx: Context,
  text: string,
  convex: ConvexClient,
  user: { id: number; first_name: string; username?: string }
) {
  const today = new Date().toISOString().split("T")[0];

  const userData = await convex.query(api.users.getUserTokens, {
    telegramId: user.id,
  });

  const firstName = userData?.firstName ?? user.first_name;

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
  const intent = await parseCalendarIntent(text, today);

  switch (intent.action) {
    case "list_events": {
      let timeMin: Date | undefined;
      let timeMax: Date | undefined;
      let label = "upcoming events";

      if (intent.date) {
        timeMin = new Date(`${intent.date}T00:00:00`);
        timeMax = new Date(`${intent.date}T23:59:59`);
        const displayDate = timeMin.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
        label = `schedule for ${displayDate}`;
      }

      const events = await listUpcomingEvents(oauth2Client, 50, timeMin, timeMax);
      if (events.length === 0) {
        const reply = intent.date ? `Nothing on your schedule for that day.` : "No upcoming events found.";
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }
      const reply = `Your ${label}:\n\n` + formatEventsGroupedByDay(events);
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

      await addEvent(oauth2Client, event);

      const display = start.toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });

      const reply = `Added "${intent.title}" on ${display}.`;
      await ctx.reply(reply);
      await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
      break;
    }

    case "delete_event": {
      // If no title but a date is given, look up events on that day
      let allEvents = await listUpcomingEvents(oauth2Client, 50);
      let matches: CalendarEvent[];

      if (!intent.title && intent.date) {
        const dayStart = new Date(`${intent.date}T00:00:00`);
        const dayEnd = new Date(`${intent.date}T23:59:59`);
        matches = allEvents.filter((e) => e.start >= dayStart && e.start <= dayEnd);

        if (matches.length === 0) {
          const reply = `No events found on ${intent.date} to delete.`;
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
          return;
        }

        if (matches.length > 1) {
          const list = matches
            .map((e, i) => {
              const dt = e.start.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
              return `${i + 1}. ${e.title} — ${dt}`;
            })
            .join("\n");
          const reply = `Multiple events on that day — which one?\n\n${list}\n\nSay the name to delete it.`;
          await ctx.reply(reply);
          await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
          return;
        }
      } else if (!intent.title) {
        const reply = "Which event do you want to delete? Give me the name.";
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      } else {
        matches = matchEventsByTitle(allEvents, intent.title);
      }

      if (matches.length === 0) {
        const reply = `Couldn't find any upcoming event matching "${intent.title}".`;
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      if (matches.length > 1) {
        const list = matches
          .map((e, i) => {
            const dt = e.start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            return `${i + 1}. ${e.title} — ${dt}`;
          })
          .join("\n");
        const reply = `Found multiple matches — be more specific (include the date or time):\n\n${list}`;
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      const target = matches[0];
      await deleteEvent(oauth2Client, target.id!);
      const dt = target.start.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
      const reply = `Deleted "${target.title}" on ${dt}.`;
      await ctx.reply(reply);
      await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
      break;
    }

    case "reschedule_event": {
      console.log("[reschedule] intent:", JSON.stringify(intent));

      if (!intent.title) {
        const reply = "Which event do you want to reschedule? Give me the name.";
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      // Gemini often puts the new date/time in `date`/`time` instead of `newDate`/`newTime`
      const resolvedDate = intent.newDate ?? intent.date;
      const resolvedTime = intent.newTime ?? intent.time;

      if (!resolvedDate) {
        const reply = "What date do you want to move it to?";
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      const allEvents = await listUpcomingEvents(oauth2Client, 50);
      const matches = matchEventsByTitle(allEvents, intent.title);

      if (matches.length === 0) {
        const reply = `Couldn't find any upcoming event matching "${intent.title}".`;
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      if (matches.length > 1) {
        const list = matches
          .map((e, i) => {
            const dt = e.start.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            return `${i + 1}. ${e.title} — ${dt}`;
          })
          .join("\n");
        const reply = `Found multiple matches — be more specific (include the date or time):\n\n${list}`;
        await ctx.reply(reply);
        await convex.mutation(api.users.saveMessage, { telegramId: user.id, role: "model", content: reply });
        return;
      }

      const target = matches[0];
      const durationMs = target.end.getTime() - target.start.getTime();
      const [newHour, newMinute] = (resolvedTime ?? "09:00").split(":").map(Number);
      const newStart = new Date(
        `${resolvedDate}T${String(newHour).padStart(2, "0")}:${String(newMinute).padStart(2, "0")}:00`
      );
      const newEnd = new Date(newStart.getTime() + durationMs);

      await updateEvent(oauth2Client, target.id!, newStart, newEnd);

      const display = newStart.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
      const reply = `Rescheduled "${target.title}" to ${display}.`;
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
}

export function registerMessageHandler(bot: Bot, convex: ConvexClient) {
  bot.on("message:text", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    try {
      await processMessage(ctx, text, convex, user);
    } catch (err) {
      console.error("Message handler error:", err);
      await ctx.reply("Something went wrong. Please try again.");
    }
  });

  bot.on("message:voice", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    try {
      const file = await ctx.getFile();
      const token = process.env.TELEGRAM_BOT_TOKEN!;
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      const audioBytes = Buffer.from(await response.arrayBuffer());

      const transcription = await transcribeAudio(audioBytes, "audio/ogg");
      if (!transcription) {
        await ctx.reply("Couldn't make out what you said. Try again?");
        return;
      }

      await ctx.reply(`_"${transcription}"_`, { parse_mode: "Markdown" });
      await processMessage(ctx, transcription, convex, user);
    } catch (err) {
      console.error("Voice handler error:", err);
      await ctx.reply("Something went wrong processing your voice message.");
    }
  });
}
