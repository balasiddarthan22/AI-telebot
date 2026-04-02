import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const BOMB_SYSTEM_PROMPT =
  "You are Bomb, a Gen Z AI assistant. You talk like a chill Gen Z friend — short, casual, no corporate speak, no emojis. Never mention Google Calendar unless the user asks about it first.";

export interface ParsedIntent {
  action:
    | "add_event"
    | "list_events"
    | "find_free_time"
    | "delete_event"
    | "unknown";
  title?: string;
  date?: string;
  time?: string;
  duration?: number;
  attendees?: string[];
  raw: string;
}

export type ChatMessage = { role: "user" | "model"; content: string };

// Retry wrapper for 503 errors
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.status === 503 && i < retries - 1) {
        await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

export async function parseCalendarIntent(
  userMessage: string,
  today: string
): Promise<ParsedIntent> {
  const prompt = `You are a calendar assistant. Parse the user's message into a structured intent.
Today's date is ${today}.

User message: "${userMessage}"

Rules:
- Use "list_events" ONLY for explicit requests to see/show/list events (e.g. "show my schedule", "what's on my calendar")
- Use "add_event" ONLY for explicit requests to add/create/schedule something
- Use "find_free_time" ONLY for explicit requests to find free time/availability
- Use "delete_event" ONLY for explicit requests to delete/remove/cancel an event
- Use "unknown" for questions, comments, follow-ups, or anything that is NOT a direct calendar action

Reply ONLY with valid JSON matching this shape (no markdown, no explanation):
{
  "action": "add_event" | "list_events" | "find_free_time" | "delete_event" | "unknown",
  "title": "event title if applicable",
  "date": "YYYY-MM-DD if mentioned",
  "time": "HH:MM in 24h format if mentioned",
  "duration": number of minutes if mentioned (default 60),
  "attendees": ["@username"] if mentioned
}

Only include fields that are relevant. Always include "action".`;

  return withRetry(async () => {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    try {
      const parsed = JSON.parse(text);
      return { ...parsed, raw: userMessage };
    } catch {
      return { action: "unknown", raw: userMessage };
    }
  });
}

export async function generateResponse(
  userMessage: string,
  history: ChatMessage[] = [],
  context?: string,
  firstName?: string
): Promise<string> {
  const systemLine = firstName
    ? `${BOMB_SYSTEM_PROMPT} The user's name is ${firstName}.`
    : BOMB_SYSTEM_PROMPT;

  const contextLine = context
    ? `\nThe user's upcoming calendar events:\n${context}\n`
    : "";

  const fullSystem = systemLine + contextLine;

  return withRetry(async () => {
    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: fullSystem }] },
        { role: "model", parts: [{ text: "got it, i'm bomb. what's good?" }] },
        ...history.map((m) => ({
          role: m.role,
          parts: [{ text: m.content }],
        })),
      ],
    });

    const result = await chat.sendMessage(userMessage);
    return result.response.text().trim();
  });
}
