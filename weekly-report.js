import { WebClient } from "@slack/web-api";
import { Client as NotionClient } from "@notionhq/client";
import {
  getRosterUserIds,
  fetchPhotoEvents,
  computeValidDays,
  msToKstDateTime,
} from "./lib.js";

const {
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  ANTHROPIC_API_KEY,
  NOTION_API_KEY,
  NOTION_PAGE_ID,
  REQUIRED_TIMES_PER_WEEK = "2",
} = process.env;

const REQUIRED = parseInt(REQUIRED_TIMES_PER_WEEK, 10);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const END_OF_WEEK_GRACE_MS = 6 * 60 * 60 * 1000; // 자정 넘긴 세션의 종료 사진이 다음주로 밀려나가지 않도록 여유를 둠

const slack = new WebClient(SLACK_BOT_TOKEN);
const notion = NOTION_API_KEY ? new NotionClient({ auth: NOTION_API_KEY }) : null;

const { TEST_AS_OF_DATE } = process.env;

function kstToMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - KST_OFFSET_MS;
}

// "지난주 월요일 00:00 ~ 이번주 월요일 00:00(KST)" 구간(=지난주 한 주)을 반환.
// 어느 요일에 실행하든 항상 정확한 월~일 경계를 계산함 (TEST_AS_OF_DATE로 기준일을 강제할 수 있음 - 테스트용)
function getLastWeekRangeTs() {
  const now = new Date();
  const asOf = TEST_AS_OF_DATE ? new Date(`${TEST_AS_OF_DATE}T12:00:00+09:00`) : now;

  const kstAsOf = new Date(asOf.getTime() + KST_OFFSET_MS);
  const y = kstAsOf.getUTCFullYear();
  const m = kstAsOf.getUTCMonth();
  const d = kstAsOf.getUTCDate();
  const weekday = kstAsOf.getUTCDay(); // 0=일, 1=월, ..., 6=토

  const todayMidnightKstAsUtcMs = Date.UTC(y, m, d, 0, 0, 0) - KST_OFFSET_MS;
  const daysSinceMonday = (weekday + 6) % 7; // 월=0, 화=1, ..., 일=6

  const thisMondayMidnightMs = todayMidnightKstAsUtcMs - daysSinceMonday * 24 * 60 * 60 * 1000;

  const end = thisMondayMidnightMs; // 이번주 월요일 00:00 KST (미포함 경계) = 지난주가 끝나는 지점
  const start = end - 7 * 24 * 60 * 60 * 1000; // 지난주 월요일 00:00 KST

  // 슬랙 조회 범위는 늦게 올리는 경우를 대비해 2주 더 넓게 잡고,
  // 실제 판별은 targetStartMs~targetEndMs(지난주)로 한정함
  const slackFetchStart = start - 14 * 24 * 60 * 60 * 1000;

  return {
    oldest: (slackFetchStart / 1000).toString(),
    latest: (now.getTime() / 1000).toString(),
    targetStartMs: start,
    targetEndMs: end,
    startDate: new Date(start),
    endDate: new Date(end - 1000),
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
  }));
}

async function main() {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
    throw new Error("SLACK_BOT_TOKEN 또는 SLACK_CHANNEL_ID가 비어 있습니다.");
  }
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY가 비어 있습니다.");
  }

  const { oldest, latest, targetStartMs, targetEndMs, startDate, endDate } =
    getLastWeekRangeTs();

  const roster = await getRosterUserIds(slack, SLACK_CHANNEL_ID);

  console.log("슬랙 채널에서 메시지를 가져오는 중...");
  const allEvents = await fetchPhotoEvents(
    slack,
    SLACK_BOT_TOKEN,
    ANTHROPIC_API_KEY,
    SLACK_CHANNEL_ID,
    oldest,
    latest
  );

  console.log(`총 수집된 사진 이벤트 수: ${allEvents.length}개`);

  const filteredEvents = allEvents.filter(
    (e) => e.time >= targetStartMs && e.time < targetEndMs + END_OF_WEEK_GRACE_MS
  );

  console.log(`지난주 기간 내 필터링된 사진 수: ${filteredEvents.length}개`);
  console.log("수집 이벤트 상세:", JSON.stringify(buildEventLog(filteredEvents), null, 2));

  const { validDaysByUser, singleDays } = computeValidDays(filteredEvents, 30);

  const missed = roster.filter((u) => (validDaysByUser[u.id] || 0) < REQUIRED);
  const passed = roster.filter((u) => (validDaysByUser[u.id] || 0) >= REQUIRED);

  const dateLabel = `${formatKstMonthDay(startDate)} ~ ${formatKstMonthDay(endDate)}`;

  const missedText = missed.length
    ? missed
        .map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}/${REQUIRED}회`)
        .join("\n")
    : "이번 주는 전원 완료했어요 🎉";

  const passedText =
    passed.map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}회`).join("\n") || "-";

  const singleNoteLines = singleDays.map((s) => {
    return `• <@${s.user}> — ${s.date} (${s.reason}, 인정 안 됨)`;
  });

  const slackMsg = [
    `*📋 주간 운동 리포트 (${dateLabel})*`,
    "",
    `*미달자 (${missed.length}명)*`,
    missedText,
    "",
    `*완료자 (${passed.length}명)*`,
    passedText,
    ...(singleNoteLines.length
      ? ["", "*⚠️ 참고 (인정 안 된 날짜)*", singleNoteLines.join("\n")]
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
                { text: { content: `완료: ${passed.map((u) => u.name).join(", ") || "-"}` } },
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
  console.log("참고(인정 안 된 날짜):", singleDays);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});