import { WebClient } from "@slack/web-api";
import { Client as NotionClient } from "@notionhq/client";
import {
  getRosterUserIds,
  fetchPhotoEvents,
  computeValidDays,
  closeOcrWorker,
  msToKstDateTime,
} from "./lib.js";

const {
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  NOTION_API_KEY,
  NOTION_PAGE_ID,
  REQUIRED_TIMES_PER_WEEK = "2",
} = process.env;

const REQUIRED = parseInt(REQUIRED_TIMES_PER_WEEK, 10);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const slack = new WebClient(SLACK_BOT_TOKEN);
const notion = NOTION_API_KEY ? new NotionClient({ auth: NOTION_API_KEY }) : null;

function kstToMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - KST_OFFSET_MS;
}

function getCustomRangeTs() {
  const now = new Date();

  const slackFetchStart = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const targetStartMs = kstToMs(2026, 6, 22, 0, 0, 0);
  const targetEndMs = kstToMs(2026, 7, 6, 0, 0, 0);

  return
