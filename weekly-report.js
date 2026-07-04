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

function getCustomRangeTs() {
  const now = new Date();
  
  // 6월 22일 및 23일을 확실히 포함하기 위해, 슬랙 메시지 검색 범위(oldest)를 30일 전으로 대폭 늘립니다.
  const slackFetchStart = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  // 정산 타겟 기간을 6월 22일(월) 00:00 KST ~ 7월 5일(일) 23:59 KST까지 넓게 잡아서 테스트합니다.
  const targetStartMs = Date.UTC(2026, 5, 22, 0, 0, 0) - KST_OFFSET_MS; // 6월 22일 00:00 KST
  const targetEndMs = Date.UTC(2026, 6, 6, 0, 0, 0) - KST_OFFSET_MS;   // 7월 6일 00:00 KST (미포함)

  return {
    oldest: (slackFetchStart / 1000).toString(),
    latest: (now.getTime() / 1000).toString(),
    targetStartMs,
    targetEndMs,
    startDate: new Date(targetStartMs),
    endDate: new Date(targetEndMs - 1000),
  };
}

async function main() {
  const { oldest, latest, targetStartMs, targetEndMs, startDate, endDate } = getCustomRangeTs();

  const roster = await getRosterUserIds(slack, SLACK_CHANNEL_ID);
  
  console.log("슬랙 채널에서 메시지를 가져오는 중...");
  const allEvents = await fetchPhotoEvents(slack, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, oldest, latest);
  
  console.log(`총 수집된 사진 이벤트 수: ${allEvents.length}개`);
  
  // 지정한 타겟 범위 내에 있는 이벤트만 필터링
  const filteredEvents = allEvents.filter((e) => e.time >= targetStartMs && e.time < targetEndMs);
  console.log(`타겟 기간(6/22~7/5) 내 필터링된 사진 수: ${filteredEvents.length}개`);

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

  // --- Slack 메시지 생성 ---
  const missedText = missed.length
    ? missed
        .map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}/${REQUIRED}회`)
        .join("\n")
    : "이번 기간은 전원 완료했어요 🎉";

  const singleNoteLines = singleDays.map((s) => {
    const reasonStr = s.reason || "사진 1장만 확인됨";
    return `• <@${s.user}> — ${s.date} (${reasonStr}, 인정 안 됨)`;
  });

  const slackMsg = [
    `*📋 운동 인증 리포트 (테스트 기간: ${dateLabel})*`,
    "",
    `*미달자 (${missed.length}명)*`,
    missedText,
    "",
    `*완료자 (${passed.length}명)*`,
    passed.map((u) => `• <@${u.id}> — ${validDaysByUser[u.id] || 0}회`).join("\n") || "-",
    ...(singleNoteLines.length
      ? ["", "*⚠️ 미인정 사유 내역 (참고)*", singleNoteLines.join("\n")]
      : []),
  ].join("\n");

  await slack.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: slackMsg,
    unfurl_links: false,
  });

  // --- Notion 기록 ---
  try {
    await notion.blocks.children.append({
      block_id: NOTION_PAGE_ID,
      children: [
        {
          object: "block",
          type: "heading_2",
          heading_2: { rich_text: [{ text: { content: `${dateLabel} 리포트` } }] },
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

  console.log("리포트 전송 완료");
  console.log("최종 완료자:", passed.map((u) => u.name));
  console.log("최종 미달자:", missed.map((u) => u.name));
  console.log("미인정 내역:", singleDays);

  await closeOcrWorker();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});