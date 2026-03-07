import "dotenv/config";
import crypto from "crypto";
import express from "express";
import {
  handleOptions,
  handleWellKnown,
  handlePropfind,
  handleReport,
  handleGet,
  handlePut,
  handleDelete,
  handleProppatch,
} from "./caldav";
import { ensureDatabaseProperties } from "./notion";

const app = express();
const PORT = parseInt(process.env.PORT || "5232", 10);
const CALDAV_USERNAME = process.env.CALDAV_USERNAME || "user";
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD || "pass";
const REALM = "Saki CalDAV";
const DAV_HEADER = "1, 2, access-control, calendar-access";

// Raw body parsing for iCal and XML
app.use(
  express.raw({
    type: ["text/calendar", "application/xml", "text/xml"],
    limit: "1mb",
  })
);
app.use(
  express.text({
    type: "*/*",
    limit: "1mb",
    defaultCharset: "utf-8",
  })
);

// Request logging
app.use((req, res, next) => {
  const oldEnd = res.end;
  res.end = function (...args: any[]) {
    console.log(`${req.method} ${req.path} → ${res.statusCode}`);
    return (oldEnd as Function).apply(res, args);
  } as typeof res.end;
  next();
});

// OPTIONS - no auth required
app.options("*", handleOptions);

// --- Digest Auth ---
function md5(str: string): string {
  return crypto.createHash("md5").update(str).digest("hex");
}

// HA1 = MD5(username:realm:password)
const HA1 = md5(`${CALDAV_USERNAME}:${REALM}:${CALDAV_PASSWORD}`);

// Store used nonces to prevent replay (simple in-memory, with expiry)
const nonces = new Map<string, number>();

function generateNonce(): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(nonce, Date.now());
  return nonce;
}

// Clean old nonces every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [nonce, time] of nonces) {
    if (now - time > 300000) nonces.delete(nonce);
  }
}, 300000);

function parseDigestHeader(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const regex = /(\w+)=(?:"([^"]*)"|([\w]+))/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2] ?? match[3];
  }
  return params;
}

function sendAuthChallenge(res: express.Response): void {
  const nonce = generateNonce();
  res.set(
    "WWW-Authenticate",
    `Digest realm="${REALM}", nonce="${nonce}", qop="auth", algorithm=MD5`
  );
  res.set("DAV", DAV_HEADER);
  res.status(401).send("Authentication required");
}

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    sendAuthChallenge(res);
    return;
  }

  // Support both Digest and Basic
  if (authHeader.startsWith("Digest ")) {
    const params = parseDigestHeader(authHeader.slice(7));

    if (params.username !== CALDAV_USERNAME) {
      sendAuthChallenge(res);
      return;
    }

    // Verify nonce is known
    if (!nonces.has(params.nonce)) {
      sendAuthChallenge(res);
      return;
    }

    // HA2 = MD5(method:uri)
    const ha2 = md5(`${req.method}:${params.uri}`);

    let expected: string;
    if (params.qop === "auth") {
      // response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
      expected = md5(`${HA1}:${params.nonce}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`);
    } else {
      // response = MD5(HA1:nonce:HA2)
      expected = md5(`${HA1}:${params.nonce}:${ha2}`);
    }

    if (params.response !== expected) {
      sendAuthChallenge(res);
      return;
    }

    (req as any).username = CALDAV_USERNAME;
    next();
    return;
  }

  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    const username = decoded.substring(0, colonIdx);
    const password = decoded.substring(colonIdx + 1);

    if (username === CALDAV_USERNAME && password === CALDAV_PASSWORD) {
      (req as any).username = username;
      next();
      return;
    }
  }

  sendAuthChallenge(res);
});

// Routes
app.get("/.well-known/caldav", handleWellKnown);

// WebDAV/CalDAV methods
app.use((req, res, next) => {
  switch (req.method) {
    case "PROPFIND":
      handlePropfind(req, res);
      return;
    case "PROPPATCH":
      handleProppatch(req, res);
      return;
    case "REPORT":
      handleReport(req, res);
      return;
  }
  next();
});

// Event resource operations
app.get("/calendars/:user/default/:uid.ics", handleGet);
app.put("/calendars/:user/default/:uid.ics", handlePut);
app.delete("/calendars/:user/default/:uid.ics", handleDelete);

// Start server
async function main() {
  await ensureDatabaseProperties();
  app.listen(PORT, () => {
    console.log(`Saki CalDAV server running on http://localhost:${PORT}`);
    console.log(`CalDAV URL: http://localhost:${PORT}/calendars/${CALDAV_USERNAME}/default/`);
  });
}

main().catch(console.error);
