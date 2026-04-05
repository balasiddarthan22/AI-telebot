import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const BOMB_SYSTEM_PROMPT =
  "You are Bomb, a Gen Z AI assistant. You talk like a chill Gen Z friend — short, casual, no corporate speak, no emojis. Never mention Google Calendar unless the user asks about it first. IMPORTANT: You cannot add, delete, reschedule, or modify calendar events yourself — the system handles that. Never tell the user you have performed a calendar action. If they ask you to do something calendar-related, tell them the system will handle it or ask them to be more specific.";

export interface ParsedIntent {
  action:
    | "add_event"
    | "list_events"
    | "find_free_time"
    | "delete_event"
    | "reschedule_event"
    | "unknown";
  title?: string;
  date?: string;
  time?: string;
  duration?: number;
  attendees?: string[];
  newDate?: string;
  newTime?: string;
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
- Use "list_events" ONLY for explicit requests to see/show/list events (e.g. "show my schedule", "what's on my calendar"). Always include "date" when a specific day is mentioned or implied (e.g. "today", "tomorrow", "this week" → use start of that range). If no date is mentioned, omit "date" to show all upcoming events.
- Use "add_event" ONLY for explicit requests to add/create/schedule something new
- Use "find_free_time" ONLY for explicit requests to find free time/availability
- Use "delete_event" for any request to delete/remove/cancel an event. If the user says "delete today's event" or similar without a specific title, set "date" to today and omit "title" so the system can look up what's on that day. Include "title" only when the user names a specific event.
- Use "reschedule_event" ONLY for explicit requests to reschedule/move/change the time of an existing event. Include "title" for the event to find, "date"/"time" for the original event (if mentioned), and "newDate"/"newTime" for the new time.
- Use "unknown" for questions, comments, follow-ups, or anything that is NOT a direct calendar action

Reply ONLY with valid JSON matching this shape (no markdown, no explanation):
{
  "action": "add_event" | "list_events" | "find_free_time" | "delete_event" | "reschedule_event" | "unknown",
  "title": "event title if applicable",
  "date": "YYYY-MM-DD if mentioned (original date for reschedule)",
  "time": "HH:MM in 24h format if mentioned (original time for reschedule)",
  "duration": number of minutes if mentioned (default 60),
  "attendees": ["@username"] if mentioned,
  "newDate": "YYYY-MM-DD new date for reschedule",
  "newTime": "HH:MM in 24h format new time for reschedule"
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

export async function transcribeAudio(audioBytes: Buffer, mimeType: string): Promise<string> {
  return withRetry(async () => {
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: audioBytes.toString("base64"),
        },
      },
      { text: "Transcribe this audio exactly as spoken. Return only the transcription, nothing else." },
    ]);
    return result.response.text().trim();
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
