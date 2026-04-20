import { createServer } from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"];

export async function obtainRefreshToken(opts: {
  clientId: string;
  clientSecret: string;
  /** e.g. http://127.0.0.1:3333/oauth2callback */
  redirectUri: string;
}): Promise<{ refreshToken: string }> {
  const oauth2Client = new google.auth.OAuth2(opts.clientId, opts.clientSecret, opts.redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  const code = await listenForOAuthCode(opts.redirectUri, authUrl);
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("No refresh_token returned. Try revoking app access and re-consenting with prompt=consent.");
  }
  return { refreshToken: tokens.refresh_token };
}

function listenForOAuthCode(redirectUri: string, authUrl: string): Promise<string> {
  const u = new URL(redirectUri);
  if (u.protocol !== "http:") {
    throw new Error("Local OAuth redirect must be http for this helper");
  }
  const port = Number(u.port || 80);
  const pathname = u.pathname || "/";

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        if (!req.url) return;
        const incoming = new URL(req.url, `http://${req.headers.host}`);
        if (incoming.pathname !== pathname) {
          res.writeHead(404);
          res.end();
          return;
        }
        const err = incoming.searchParams.get("error");
        if (err) {
          res.writeHead(400);
          res.end(`Error: ${err}`);
          server.close();
          reject(new Error(err));
          return;
        }
        const code = incoming.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("Missing code");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Authorization received. You can close this tab.");
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      // eslint-disable-next-line no-console
      console.log("\nOpen this URL in your browser to authorize Gmail:\n");
      // eslint-disable-next-line no-console
      console.log(authUrl);
      // eslint-disable-next-line no-console
      console.log(`\nWaiting for redirect to ${redirectUri} ...\n`);
    });

    server.on("error", reject);
  });
}
