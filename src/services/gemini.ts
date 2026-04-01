import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export interface ParsedIntent {
  action:
    | "add_event"
    | "list_events"
    | "find_free_time"
    | "delete_event"
    | "unknown";
  title?: string;
  date?: string;   // ISO 8601 date string
  time?: string;   // HH:MM 24h
  duration?: number; // minutes
  attendees?: string[];
  raw: string;
}

export async function parseCalendarIntent(
  userMessage: string,
  today: string
): Promise<ParsedIntent> {
  const prompt = `You are a calendar assistant. Parse the user's message into a structured intent.
Today's date is ${today}.

User message: "${userMessage}"

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

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  try {
    const parsed = JSON.parse(text);
    return { ...parsed, raw: userMessage };
  } catch {
    return { action: "unknown", raw: userMessage };
  }
}

export async function generateResponse(prompt: string): Promise<string> {
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}
