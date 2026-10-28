import test from "node:test";
import assert from "node:assert/strict";
import { tidy, readPage, choose, company } from "../bin/peek.mjs";

test("홍보 문구를 짧은 혜택으로 다듬는다", () => {
  const cases = [
    ["무료회원가입(1,000B 지급)", "join", "가입 1,000B"],
    ["가입시 1,000P, 7일간 매일 100P 추가 지급", "join", "가입 1,000P"],
    ["아직 회원이 아니세요? 간편 무료가입 하고 500P 받기", "join", "가입 500P"],
    ["본인인증 시 보너스 1,000B", "join", "본인인증 1,000B"],
    ["첫 달 단돈 100원 · 자동결제 이벤트 진행중", "event", "첫 달 100원"],
    ["30일 무제한 100원", "event", "30일 무제한 100원"],
    ["정액제 100원 결제 이벤트!", "event", "정액제 100원"],
    ["정액권100%페이백", "event", "정액권 100% 페이백"],
    ["안드로이드 어플 설치하면 쿠폰2장 즉시지급!", "event", "앱 설치 쿠폰 2장"],
    ["오픈기념 1회 한정! 결제금액의 10배 적립!", "event", "결제 10배 적립"],
    ["종편&케이블방송 할인 100원!", "event", "방송 100원 이용"],
    ["출석하고 광고보고 최대 3,300포인트 적립", "event", "출석 최대 3,300P"],
    ["평점 5점 리뷰 작성시 보너스 포인트 2,000p 지급", "event", "리뷰 작성 2,000P"],
  ];
  for (const [line, kind, text] of cases) assert.deepEqual(tidy(line), { kind, text }, line);
});

test("가격·영상 제목·메뉴·성인 문구는 버린다", () => {
  for (const line of ["간편하게 가입만해도 무료포인트 즉시 지급! 지식iN 답변하면 최대 5,000P 적립", "하루 300원으로 무제한 다운", "국내 최저가 20M당 1원!", "10,000원 20,000포인트 무료지급", "무료충전소", "쿠폰등록", "[FHD 1080p] 아바타", "드라마.E04.261027.720p", "성인영화 70% 할인", "2) 포인트 교환 수수료 : 교환 액의 50%"]) {
    assert.equal(tidy(line), null, line);
  }
});

test("가입·이벤트 링크와 배너 문구를 찾는다", () => {
  const html = '<a href="/member/join.php">회원가입</a><a href="/event/list">이벤트</a><a href="https://other.example/event">밖</a><img src="b.png" alt="첫 달 100원">';
  const page = readPage(html, "https://site.example/");
  assert.deepEqual(page.links.join, ["https://site.example/member/join.php"]);
  assert.deepEqual(page.links.event, ["https://site.example/event/list"]);
  assert.ok(page.lines.includes("첫 달 100원"));
});

test("가입 1개, 이벤트 2개까지 고르고 못 찾으면 빈값", () => {
  const found = [
    { kind: "join", text: "본인인증 1,000B" },
    { kind: "join", text: "가입 1,000P" },
    { kind: "event", text: "첫 달 100원" },
    { kind: "event", text: "생일 3,000P" },
    { kind: "event", text: "리뷰 작성 2,000P" },
  ];
  assert.deepEqual(choose(found), [
    { kind: "join", text: "가입 1,000P" },
    { kind: "event", text: "첫 달 100원" },
    { kind: "event", text: "생일 3,000P" },
  ]);
  assert.deepEqual(choose([]), []);
  assert.deepEqual(choose([{ kind: "event", text: "페이백 이벤트" }, { kind: "event", text: "정액권 100% 페이백" }]), [{ kind: "event", text: "정액권 100% 페이백" }]);
});

test("바닥글에서 사업자 정보를 읽고, 없으면 빈값", () => {
  assert.deepEqual(company(["상호 : (주)예시파일 | 대표 : 홍길동 | 사업자등록번호 : 123-45-67890", "특수한유형의 부가통신사업자 등록번호 : 제 2024-001 호"]), {
    name: "(주)예시파일",
    bizNo: "123-45-67890",
    kcc: "제2024-001호",
  });
  assert.equal(company(["무료충전소", "쿠폰등록"]), null);
  assert.deepEqual(company(["㈜예시미디어 | 대표이사 홍길동 | 사업자등록번호 : 123-45-67890"]), { name: "(주)예시미디어", bizNo: "123-45-67890" });
});
