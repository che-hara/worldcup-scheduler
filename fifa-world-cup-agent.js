import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BLUESKY_USERNAME = process.env.BLUESKY_USERNAME;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Teams to follow — ESPN abbreviation → display name
const TRACKED_TEAMS = {
  CAN: "Canada",
  POR: "Portugal",
  BRA: "Brazil",
  FRA: "France",
  ESP: "Spain",
};

// Max posts per match to avoid spamming
const MAX_POSTS_PER_MATCH = 8;

// ESPN soccer league slug for FIFA World Cup
const ESPN_LEAGUE = "fifa.world";

// ============================================================================
// BLUESKY API HELPERS
// ============================================================================

let blueskySession = null;

async function blueskyLogin() {
  const response = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: BLUESKY_USERNAME,
      password: BLUESKY_PASSWORD,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Bluesky login failed: ${err}`);
  }

  blueskySession = await response.json();
  console.log("✓ Logged into Bluesky");
  return blueskySession;
}

async function refreshBlueskySession() {
  if (!blueskySession?.refreshJwt) {
    return blueskyLogin();
  }
  const response = await fetch("https://bsky.social/xrpc/com.atproto.server.refreshSession", {
    method: "POST",
    headers: { Authorization: `Bearer ${blueskySession.refreshJwt}` },
  });
  if (!response.ok) {
    return blueskyLogin();
  }
  blueskySession = await response.json();
  console.log("✓ Refreshed Bluesky session");
  return blueskySession;
}

async function postToBluesky(text) {
  if (!blueskySession) {
    await blueskyLogin();
  }

  if (text.length > 300) {
    text = text.substring(0, 297) + "...";
  }

  const tryPost = async () => {
    return fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${blueskySession.accessJwt}`,
      },
      body: JSON.stringify({
        repo: blueskySession.did,
        collection: "app.bsky.feed.post",
        record: { text, createdAt: new Date().toISOString() },
      }),
    });
  };

  let response = await tryPost();

  if (response.status === 401) {
    await refreshBlueskySession();
    response = await tryPost();
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to post to Bluesky: ${error}`);
  }

  console.log(`✓ Posted: "${text}"`);
  return response.json();
}

// ============================================================================
// ESPN DATA FETCHING
// ============================================================================

async function getWorldCupScoreboard() {
  try {
    const response = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN_LEAGUE}/scoreboard`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.events || [];
  } catch (error) {
    console.error("Error fetching scoreboard:", error.message);
    return [];
  }
}

async function getMatchSummary(eventId) {
  try {
    const response = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN_LEAGUE}/summary?event=${eventId}`
    );
    if (!response.ok) return null;
    return response.json();
  } catch (error) {
    console.error(`Error fetching match ${eventId}:`, error.message);
    return null;
  }
}

// ============================================================================
// MATCH STATE PARSER
// ============================================================================

function getTrackedTeam(competitors) {
  for (const c of competitors) {
    const abbr = c.team?.abbreviation?.toUpperCase();
    const name = c.team?.displayName || c.team?.name || "";
    if (TRACKED_TEAMS[abbr]) return { abbr, name: TRACKED_TEAMS[abbr], competitor: c };
    // Fallback: match by name substring
    for (const [key, val] of Object.entries(TRACKED_TEAMS)) {
      if (name.toLowerCase().includes(val.toLowerCase())) {
        return { abbr: key, name: val, competitor: c };
      }
    }
  }
  return null;
}

function parseMatchState(event, summary) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const tracked = getTrackedTeam(competitors);
  if (!tracked) return null;

  const opponent = competitors.find(c => c !== tracked.competitor);
  const status = event.status?.type?.description || "Scheduled";
  const clock = event.status?.displayClock || "";
  const period = event.status?.period || 0;

  const trackedScore = parseInt(tracked.competitor.score) || 0;
  const opponentScore = parseInt(opponent?.score) || 0;
  const opponentName = opponent?.team?.displayName || opponent?.team?.name || "Opponent";

  // Detect penalty shootout from status or competition details
  const statusName = event.status?.type?.name || "";
  const isPenalties = statusName.toLowerCase().includes("shootout") ||
    status.toLowerCase().includes("penalty") ||
    period > 2;

  // Pull key events from summary details (goals, cards)
  const details = summary?.keyEvents || summary?.plays || [];
  const keyEvents = details.map(e => ({
    type: e.type?.text || e.type?.id || "",
    clock: e.clock?.displayValue || "",
    team: e.team?.displayName || "",
    text: e.text || e.headline || "",
  }));

  // Count red cards from details
  const redCards = details.filter(e => {
    const t = (e.type?.text || e.type?.id || "").toLowerCase();
    return t.includes("red") || t.includes("red card");
  });

  return {
    eventId: event.id,
    trackedTeam: tracked.name,
    trackedAbbr: tracked.abbr,
    opponentName,
    trackedScore,
    opponentScore,
    status,
    clock,
    period,
    isPenalties,
    keyEvents,
    redCardCount: redCards.length,
    isLive: status.toLowerCase().includes("progress") || status.toLowerCase() === "halftime",
    isOver: event.status?.type?.completed === true,
    matchLabel: `${tracked.name} vs ${opponentName}`,
  };
}

// ============================================================================
// EVENT DETECTION
// ============================================================================

function detectNewEvents(prev, curr) {
  const events = [];

  if (!prev) {
    if (curr.isLive) events.push({ type: "KICK_OFF" });
    return events;
  }

  // Game just kicked off
  if (!prev.isLive && curr.isLive) {
    events.push({ type: "KICK_OFF" });
  }

  // Game just ended
  if (!prev.isOver && curr.isOver) {
    events.push({ type: "FULL_TIME" });
  }

  // Halftime
  if (prev.status !== "Halftime" && curr.status === "Halftime") {
    events.push({ type: "HALFTIME" });
  }

  // Goal scored (score total increased)
  const prevTotal = prev.trackedScore + prev.opponentScore;
  const currTotal = curr.trackedScore + curr.opponentScore;
  if (currTotal > prevTotal) {
    const scoredFor = curr.trackedScore > prev.trackedScore;
    events.push({ type: "GOAL", scoredFor });
  }

  // New red card
  if (curr.redCardCount > prev.redCardCount) {
    events.push({ type: "RED_CARD" });
  }

  // Penalty shootout started
  if (!prev.isPenalties && curr.isPenalties) {
    events.push({ type: "PENALTIES" });
  }

  return events;
}

// ============================================================================
// CLAUDE AI POST GENERATION
// ============================================================================

async function generatePost(matchState, triggeredEvents) {
  const eventDescriptions = triggeredEvents.map(e => {
    switch (e.type) {
      case "KICK_OFF": return "Match just kicked off!";
      case "HALFTIME": return "Halftime whistle just blown.";
      case "FULL_TIME": return "Final whistle! Match is over.";
      case "GOAL": return e.scoredFor
        ? `${matchState.trackedTeam} just scored a goal! 🎉`
        : `${matchState.opponentName} just scored a goal.`;
      case "RED_CARD": return "A red card was just shown!";
      case "PENALTIES": return "Going to penalty shootout!";
      default: return e.type;
    }
  }).join(" ");

  const prompt = `You are an enthusiastic FIFA World Cup fan posting live match updates to Bluesky. You're especially excited when Canada, Portugal, Brazil, France, or Spain are playing.

MATCH:
- ${matchState.trackedTeam} vs ${matchState.opponentName}
- Score: ${matchState.trackedTeam} ${matchState.trackedScore} – ${matchState.opponentName} ${matchState.opponentScore}
- Status: ${matchState.status}${matchState.clock ? ` (${matchState.clock})` : ""}
${matchState.isPenalties ? "- ⚠️ PENALTY SHOOTOUT" : ""}

TRIGGER:
${eventDescriptions}

Write a SHORT, ENGAGING Bluesky post (max 280 characters) reacting to this moment. Use soccer/football emojis (⚽🏆🔥💥🎯🥅🇨🇦🇵🇹🇧🇷🇫🇷🇪🇸) where fitting. Be passionate, conversational, and specific to the moment. Always end with #FIFAWorldCup2026 #BlueJays (yes, include both — this account crosses sports).

Respond with ONLY the post text, nothing else.`;

  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 150,
    messages: [{ role: "user", content: prompt }],
  });

  return message.content[0].type === "text" ? message.content[0].text.trim() : "";
}

// ============================================================================
// MAIN AGENT LOOP
// ============================================================================

// Per-match state: eventId → { prevState, postCount }
const matchTrackers = new Map();

async function pollMatches() {
  const events = await getWorldCupScoreboard();

  // Filter to events involving tracked teams
  const relevant = events.filter(event => {
    const competitors = event.competitions?.[0]?.competitors || [];
    return getTrackedTeam(competitors) !== null;
  });

  if (relevant.length === 0) {
    console.log("⏳ No tracked team matches found on the scoreboard right now.");
    return;
  }

  for (const event of relevant) {
    const eventId = event.id;

    if (!matchTrackers.has(eventId)) {
      matchTrackers.set(eventId, { prevState: null, postCount: 0 });
    }

    const tracker = matchTrackers.get(eventId);

    // Skip already-maxed matches
    if (tracker.postCount >= MAX_POSTS_PER_MATCH) continue;

    const summary = await getMatchSummary(eventId);
    const currState = parseMatchState(event, summary);
    if (!currState) continue;

    const newEvents = detectNewEvents(tracker.prevState, currState);

    if (newEvents.length > 0) {
      console.log(`\n⚽ [${currState.matchLabel}] Events: ${newEvents.map(e => e.type).join(", ")}`);
      console.log(`   Score: ${currState.trackedScore} – ${currState.opponentScore} | ${currState.status}`);

      try {
        const post = await generatePost(currState, newEvents);
        if (post) {
          await postToBluesky(post);
          tracker.postCount++;
        }
      } catch (err) {
        console.error("Error generating/posting:", err.message);
      }
    } else {
      console.log(`[${currState.matchLabel}] ${currState.status} ${currState.trackedScore}–${currState.opponentScore} | no new events`);
    }

    tracker.prevState = currState;

    // Clean up finished matches after logging
    if (currState.isOver && tracker.postCount >= 1) {
      console.log(`🏁 Match finished: ${currState.matchLabel}`);
    }
  }
}

async function runFIFAAgent() {
  console.log("🏆 FIFA World Cup 2026 Bluesky Agent Started");
  console.log(`⚽ Tracking: ${Object.values(TRACKED_TEAMS).join(", ")}`);
  console.log("📡 Using ESPN API | Posting to Bluesky\n");

  // Run immediately, then every 30 seconds
  await pollMatches();

  setInterval(async () => {
    try {
      await pollMatches();
    } catch (err) {
      console.error("⚠️ Poll error:", err.message);
    }
  }, 30000);
}

// ============================================================================
// EXECUTION
// ============================================================================

runFIFAAgent().catch(console.error);
