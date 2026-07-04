import { WebClient } from "@slack/web-api";
import { Client as NotionClient } from "@notionhq/client";
import { getRosterUserIds, fetchPhotoEvents, computeValidDays, closeOcrWorker } from "./lib.js";

const {
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  NOTION_API_KEY,
  NOTION_PAGE_ID,
  REQUIRED_TIMES_PER_WEEK = "2",
} = process.env;

const REQUIRED = parseInt(REQUIRED_TIMES_PER_WEEK, 10);

const slack = new WebClient(SLACK_BOT_TOKEN);
const notion = new NotionClient({ auth: NOTION_API_KEY });

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getLastWeekRangeTs() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();

  const todayMidnightKstAsUtcMs = Date.UTC(y, m, d, 0, 0, 0) - KST_OFFSET_MS;

  const end = todayMidnightKstAsUtcMs;
  const start = end - 7 * 24 * 60 * 60 * 1000;
  const slackFetchStart = end - 21 * 24 * 60 * 60 * 1000;

  return {
    oldest: (slackFetchStart / 1000).toString(),
    latest: (now.getTime() / 1000).toString(),
    targetStartMs: start,
    targetEndMs: end,
    startDate: new Date(start),
    endDate: new Date(end - 1000),
  };
}

async function main() {
  const { oldest, latest, targetStartMs, targetEndMs, startDate, endDate } = getLastWeekRangeTs();

  const roster = await getRosterUserIds(slack, SLACK_CHANNEL_ID);
  const allEvents = await fetchPhotoEvents(slack, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, oldest, latest);
  const filteredEvents = allEvents.filter((e) => e.time >= targetStartMs && e.time < targetEndMs);

  const { validDaysByUser, singleDays } = computeValidDays(filteredEvents, 30);

  const missed = roster.filter((u) => (validDaysByUser[u.id] || 0) < REQUIRED);
  const passed = roster.filter((u) => (validDaysByUser[u.id] || 0) >= REQUIRED);

  const fmt = (d) =>
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "long",
      day: "numeric",
    }).format(d);
  const dateLabel = `${fmt(startDate)} ~ ${fmt(endDate)}`;

  const missedText = missed.length
    ? missed
        .map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}/${REQUIRED}회`)
        .join("\n")
    : "이번 주는 전원 완료했어요 🎉";

  const singleNoteLines = singleDays.map((s) => {
    return `• <@${s.user}> — ${s.date} (사진 1장만 확인됨, 인정 안 됨)`;
  });

  const slackMsg = [
    `*📋 지난주 운동 리포트 (${dateLabel})*`,
    "",
    `*미달자 (${missed.length}명)*`,
    missedText,
    "",
    `*완료자 (${passed.length}명)*`,
    passed.map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}회`).join("\n") || "-",
    ...(singleNoteLines.length
      ? ["", "*⚠️ 사진 1장만 올라온 날 (참고)*", singleNoteLines.join("\n")]
      : []),
  ].join("\n");

  await slack.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: slackMsg,
    unfurl_links: false,
  });

  await notion.blocks.children.append({
    block_id: NOTION_PAGE_ID,
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ text: { content: `${dateLabel} 주간 리포트` } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              text: {
                content:
                  missed.length === 0
                    ? "전원 완료 🎉"
                    : `미달: ${missed.map((u) => u.name).join(", ")}`,
              },
            },
          ],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              text: {
                content: `완료: ${passed.map((u) => u.name).join(", ") || "-"}`,
              },
            },
          ],
        },
      },
    ],
  });

  console.log("리포트 전송 완료");
  await closeOcrWorker();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});