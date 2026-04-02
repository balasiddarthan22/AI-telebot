import express from "express";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { createOAuth2Client } from "./services/calendar";

export function startOAuthServer(convex: ConvexClient) {
  const app = express();
  const port = 8080;

  app.get("/oauth/google/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter.");
      return;
    }

    const telegramId = Number(state);
    if (isNaN(telegramId)) {
      res.status(400).send("Invalid state parameter.");
      return;
    }

    try {
      const oauth2Client = createOAuth2Client();
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).send("Incomplete tokens received from Google.");
        return;
      }

      await convex.mutation(api.users.saveGoogleTokens, {
        telegramId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      });

      res.send(
        "<h2>Google Calendar connected!</h2><p>You can close this tab and return to Telegram.</p>"
      );
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send("Failed to exchange code for tokens. Please try /connect again.");
    }
  });

  app.listen(port, () => {
    console.log(`OAuth server listening on http://localhost:${port}`);
  });
}
