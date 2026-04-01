import { Bot, Context } from "grammy";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { createOAuth2Client, getAuthUrl } from "../services/calendar";

export function registerCommands(bot: Bot, convex: ConvexClient) {
  bot.command("start", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    await convex.mutation(api.users.upsertUser, {
      telegramId: user.id,
      username: user.username,
      firstName: user.first_name,
    });

    await ctx.reply(
      `Hey ${user.first_name}! I'm your Calendar AI assistant.\n\n` +
        `Commands:\n` +
        `/connect — Link your Google Calendar\n` +
        `/events — List upcoming events\n` +
        `/help — Show this message\n\n` +
        `Or just tell me naturally: "Add a meeting tomorrow at 3pm"`
    );
  });

  bot.command("connect", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const oauth2Client = createOAuth2Client();
    const authUrl = getAuthUrl(oauth2Client, user.id);

    await ctx.reply(
      `Click the link below to connect your Google Calendar:\n\n${authUrl}\n\n` +
        `After authorizing, your calendar will be linked.`
    );
  });

  bot.command("events", async (ctx) => {
    const user = ctx.from;
    if (!user) return;

    const tokens = await convex.query(api.users.getUserTokens, {
      telegramId: user.id,
    });

    if (!tokens?.accessToken) {
      await ctx.reply(
        "You haven't connected your Google Calendar yet. Use /connect to get started."
      );
      return;
    }

    // Delegate to message handler with a list intent
    await ctx.reply("Fetching your upcoming events…");

    const { listUpcomingEvents } = await import("../services/calendar");
    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate,
    });

    try {
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

      await ctx.reply("Your upcoming events:\n\n" + lines.join("\n"));
    } catch (err) {
      await ctx.reply("Failed to fetch events. Try /connect to re-authorize.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `Calendar AI Bot — Commands:\n\n` +
        `/start — Register and see welcome message\n` +
        `/connect — Link your Google Calendar\n` +
        `/events — List upcoming events\n` +
        `/help — Show this message\n\n` +
        `Natural language examples:\n` +
        `• "Add team standup tomorrow at 9am for 30 minutes"\n` +
        `• "What's on my calendar this week?"\n` +
        `• "When are we all free on Friday?"`
    );
  });
}
