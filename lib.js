import { createWorker } from "tesseract.js";
import sharp from "sharp";

const KST_TZ = "Asia/Seoul";
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEFAULT_YEAR = parseInt(process.env.TEST_YEAR || "2026", 10);

export function msToKstDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

export function msToKstDateTime(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export async function getRosterUserIds(slack, channelId) {
  const memberIds = [];
  let cursor;

  do {
    const res = await slack.conversations.members({
      channel: channelId,
      cursor,
      limit: 200,
    });

    memberIds.push(...res.members);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const roster = [];

  for (const id of memberIds) {
    const info = await slack.users.info({ user: id });
    const u = info.user;

    if (!u.is_bot && !u.deleted && id !== "USLACKBOT") {
      roster.push({
        id,
        name: u.profile.display_name || u.real_name || u.name,
      });
    }
  }

  return roster;
}

const DATE_TIME_REGEX =
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일?[\s\S]{0,25}?(오전|오후)\s*(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?/;

const DATE_TIME_NOCOLON_REGEX =
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일?[\s\S]{0,25}?(오전|오후)\s*(\d{3,4})(?!\d)/;

function splitNoColonTime(digits)
