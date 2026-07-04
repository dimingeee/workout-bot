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

  // 테스트용: 슬랙에서 최근 30일 메시지를 가져온 뒤,
  // 실제 집계 대상은 2026-06-22 00:00 KST ~ 2026-07-06 00:00 KST로 제한합니다.
  const slackFetchStart = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  const targetStartMs = kstToMs(2026, 6, 22, 0, 0, 0);
  const targetEndMs = kstToMs(2026, 7, 6, 0, 0, 0);

  return {
    oldest: (slackFetchStart / 1000).toString(),
    latest: (now.getTime() / 1000).toString(),
    targetStartMs,
    targetEndMs,
    startDate: new Date(targetStartMs),
    endDate: new Date(targetEndMs - 1000),
  };
}

function formatKstMonthDay(d) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
  }).format(d);
}

function buildEventLog(events) {
  return events.map((e) => ({
    user: e.user,
    dateTimeKst: msToKstDateTime(e.time),
    source: e.source,
    reason: e.reason,
    fileName: e.fileName,
    uploadTimeKst: e.uploadTime ? msToKstDateTime(e.uploadTime) : "",
    ocrText: e.ocrText,
  }));
}

async function main() {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
    throw new Error("SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID가 비어 있습니다.");
  }

  const { oldest, latest, targetStartMs, targetEndMs, startDate, endDate } =
    getCustomRangeTs();

  const roster = await getRosterUserIds(slack, SLACK_CHANNEL_ID);

  console.log("슬랙 채널에서 메시지를 가져오는 중...");
  const allEvents = await fetchPhotoEvents(
    slack,
    SLACK_BOT_TOKEN,
    SLACK_CHANNEL_ID,
    oldest,
    latest
  );

  console.log(`총 수집된 사진 이벤트 수: ${allEvents.length}개`);

  const filteredEvents = allEvents.filter(
    (e) => e.time >= targetStartMs && e.time < targetEndMs
  );

  console.log(`타겟 기간(6/22~7/5) 내 필터링된 사진 수: ${filteredEvents.length}개`);
  console.log("수집 이벤트 상세:", JSON.stringify(buildEventLog(filteredEvents), null, 2));

  const { validDaysByUser, singleDays } = computeValidDays(filteredEvents, 30);

  const missed = roster.filter((u) => (validDaysByUser[u.id] || 0) < REQUIRED);
  const passed = roster.filter((u) => (validDaysByUser[u.id] || 0) >= REQUIRED);

  const dateLabel = `${formatKstMonthDay(startDate)} ~ ${formatKstMonthDay(endDate)}`;

  const missedText = missed.length
    ? missed
        .map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}/${REQUIRED}회`)
        .join("\n")
    : "이번 기간은 전원 완료했어요 🎉";

  const passedText =
    passed.map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}회`).join("\n") ||
    "-";

  const singleNoteLines = singleDays.map((s) => {
    return `• <@${s.user}> — ${s.date} (${s.reason}, 인정 안 됨)`;
  });

  const slackMsg = [
    `*📋 운동 인증 리포트 (테스트 기간: ${dateLabel})*`,
    "",
    `*미달자 (${missed.length}명)*`,
    missedText,
    "",
    `*완료자 (${passed.length}명)*`,
    passedText,
    ...(singleNoteLines.length
      ? ["", "*⚠️ 미인정 사유 내역 (참고)*", singleNoteLines.join("\n")]
      : []),
  ].join("\n");

  await slack.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: slackMsg,
    unfurl_links: false,
  });

  if (notion && NOTION_PAGE_ID) {
    try {
      await notion.blocks.children.append({
        block_id: NOTION_PAGE_ID,
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ text: { content: `${dateLabel} 리포트` } }],
            },
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
        ],
      });
    } catch (e) {
      console.error("Notion 기록 중 오류 발생:", e.message);
    }
  }

  console.log("리포트 전송 완료");
  console.log("최종 완료자:", passed.map((u) => u.name));
  console.log("최종 미달자:", missed.map((u) => u.name));
  console.log("미인정 내역:", singleDays);

  await closeOcrWorker();
}

main().catch(async (err) => {
  console.error(err);
  await closeOcrWorker();
  process.exit(1);
});
