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
    };
  },
});
