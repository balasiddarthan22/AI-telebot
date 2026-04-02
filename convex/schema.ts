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

  messages: defineTable({
    telegramId: v.number(),
    role: v.union(v.literal("user"), v.literal("model")),
    content: v.string(),
  }).index("by_telegram_id", ["telegramId"]),

  remindedEvents: defineTable({
    telegramId: v.number(),
    eventId: v.string(),
  })
    .index("by_telegram_id", ["telegramId"])
    .index("by_telegram_and_event", ["telegramId", "eventId"]),
});
