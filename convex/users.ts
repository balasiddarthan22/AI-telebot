import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getUser = query({
  args: { telegramId: v.number() },
  handler: async (ctx, { telegramId }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_telegram_id", (q) => q.eq("telegramId", telegramId))
      .first();
  },
});

export const upsertUser = mutation({
  args: {
    telegramId: v.number(),
    username: v.optional(v.string()),
    firstName: v.string(),
  },
  handler: async (ctx, { telegramId, username, firstName }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_telegram_id", (q) => q.eq("telegramId", telegramId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { username, firstName });
      return existing._id;
    }

    return await ctx.db.insert("users", { telegramId, username, firstName });
  },
});

export const saveGoogleTokens = mutation({
  args: {
    telegramId: v.number(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiryDate: v.number(),
  },
  handler: async (ctx, { telegramId, accessToken, refreshToken, expiryDate }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_telegram_id", (q) => q.eq("telegramId", telegramId))
      .first();

    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, { accessToken, refreshToken, expiryDate });
  },
});

export const getUserTokens = query({
  args: { telegramId: v.number() },
  handler: async (ctx, { telegramId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_telegram_id", (q) => q.eq("telegramId", telegramId))
      .first();

    if (!user) return null;
    return {
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
      expiryDate: user.expiryDate,
      firstName: user.firstName,
    };
  },
});

export const getAllConnectedUsers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users
      .filter((u) => u.accessToken && u.refreshToken)
      .map((u) => ({
        telegramId: u.telegramId,
        firstName: u.firstName,
        accessToken: u.accessToken!,
        refreshToken: u.refreshToken!,
        expiryDate: u.expiryDate,
      }));
  },
});

// Conversation history

export const saveMessage = mutation({
  args: {
    telegramId: v.number(),
    role: v.union(v.literal("user"), v.literal("model")),
    content: v.string(),
  },
  handler: async (ctx, { telegramId, role, content }) => {
    await ctx.db.insert("messages", { telegramId, role, content });

    // Keep only the last 20 messages per user
    const all = await ctx.db
      .query("messages")
      .withIndex("by_telegram_id", (q) => q.eq("telegramId", telegramId))
      .collect();

    if (all.length > 20) {
      const toDelete = all
        .sort((a, b) => a._creationTime - b._creationTime)
        .slice(0, all.length - 20);
      for (const msg of toDelete) {
        await ctx.db.delete(msg._id);
      }
    }
  },
});

export const getRecentMessages = query({
  args: { telegramId: v.number() },
  handler: async (ctx, { telegramId }) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_telegram_id", (q) => q.eq("telegramId", telegramId))
      .collect();

    return msgs
      .sort((a, b) => a._creationTime - b._creationTime)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));
  },
});

// Reminders

export const isEventReminded = query({
  args: { telegramId: v.number(), eventId: v.string() },
  handler: async (ctx, { telegramId, eventId }) => {
    const existing = await ctx.db
      .query("remindedEvents")
      .withIndex("by_telegram_and_event", (q) =>
        q.eq("telegramId", telegramId).eq("eventId", eventId)
      )
      .first();
    return !!existing;
  },
});

export const markEventReminded = mutation({
  args: { telegramId: v.number(), eventId: v.string() },
  handler: async (ctx, { telegramId, eventId }) => {
    await ctx.db.insert("remindedEvents", { telegramId, eventId });
  },
});
