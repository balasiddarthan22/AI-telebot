import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    telegramId: v.number(),
    username: v.optional(v.string()),
    firstName: v.string(),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    expiryDate: v.optional(v.number()),
  }).index("by_telegram_id", ["telegramId"]),
});
