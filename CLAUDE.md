# 작업 메모

의존성 없는 정적 사이트. `data/`의 JSON을 `bin/compose.mjs`가 읽어 `_site/`에 HTML을 만들고, GitHub Actions가 Pages로 게시한다.

## 명령

| 할 일 | 명령 |
|---|---|
| 설치 | `npm ci` |
| 빌드 | `node bin/compose.mjs` (결과: `_site/`) |
| 단위 테스트 | `node --test "test/*.test.mjs"` |
| 내용 검사 | `node bin/sweep.mjs` (전체 기록까지: `--history`) |
| 화면 검사 | `node bin/frames.mjs` (실제 데이터 + `test/fixtures/extreme`, 폭 360·390·768·1024·1440, 스크린샷은 `.frames/`. `검사` 워크플로가 푸시·PR마다 돌리고 스크린샷을 결과 파일로 올린다) |
| 지표 수집 | `node bin/harvest.mjs` (네트워크 필요, Actions에서 실행) |
| 순위 계산 | `node bin/tally.mjs` (Actions에서 실행) |
| 혜택 수집 | `node bin/peek.mjs` (네트워크 필요, `혜택 수집` 워크플로가 매주 월요일 실행, `--apply`면 `vendors.json`에 쓰고 바뀐 곳을 PR로 올림) |
| 로고 받기 | `node bin/pics.mjs` (네트워크 필요, `이미지 받기` 워크플로, 다시 받기: `--force`, 일부만: `--only=id,id`) |

빌드 환경 변수: `SITE_URL`(게시 주소, 없으면 자리표시 주소), `DATA_DIR`, `OUT_DIR`.

## 폴더

- `data/vendors.json` 업체 목록. `status`는 `active` / `pending` / `excluded`(계산·화면 모두 제외). `summary`는 순위표 설명 한 줄(없으면 생략). `company`(`name` 운영사, `bizNo` 사업자등록번호, `kcc` 부가통신사업자 등록번호)와 `checked`(혜택·업체 정보 갱신일)는 혜택 수집이 채운다. 대표자 이름은 넣지 않는다.
- `data/metrics.json` 주별 지표(`search`, `searchPrior`, `installs`, `installsText`, `ratings`, `score`, 못 받아 이전 값을 쓴 항목은 `carried`).
- `data/ranking.json` 주별 순위. `entries[]`: `id`, `rank`, `total`, `items`(항목별 점수), `bonus`(운영 가산), `star`, `mix`(다음 주 계산에 쓰는 반올림 전 항목 값). `items` 합 + `bonus` = `total`.
- `data/baseline.json` 첫 계산 결과. "기본 값으로 돌려줘"면 이 내용으로 `ranking.json`을 되돌린다.
- `data/faq.json` FAQ(`home`·`criteria` 묶음, 둘 다 순위 검증 가이드 페이지에 나온다). 답은 60자 안팎.
- `src/site.css` 스타일 원본(빌드 때 주석 제거, 글꼴 규칙·업체 색 덧붙임). `src/fonts.json` 글꼴 조각 목록. `src/clock.js` 다음 갱신(월요일 10시 KST)까지 남은 시간 표시(꺼져 있으면 날짜가 보인다).
- `assets/` 글꼴(Pretendard, OFL), 업체 가로 로고(`logo/<id>.webp`, 여백을 자르고 장식·마스코트는 잘라 낸 것), 파비콘, 공유 이미지. 로고가 없으면 화면에 첫 글자 상자가 나온다.
- `bin/` 스크립트. `guard.mjs`는 빌드·검사 보조.
- `.github/workflows/` `gate.yml` 검사, `ship.yml` 게시, `tide.yml` 주간 갱신, `pics.yml` 로고 받기, `peek.yml` 혜택 수집.

## 데이터 규칙

- 혜택: `{ "kind": "join" | "event", "text": "가입 1,000P" }`. 16자 이내, 꼬리말("지급", "진행 중" 등) 없이. 모르면 비워 둔다(화면: "공식 사이트에서 확인하세요.").
- 혜택은 `bin/peek.mjs`가 업체 공개 페이지(가입·이벤트 페이지, 배너 alt 문구)에서 홍보 문구만 모아 `RULES`로 다듬는다. 업체별 코드 없이 `url`만 쓴다. 사업자 정보는 첫 화면 바닥글에서 읽는다. 가입 1개·이벤트 2개까지, 못 읽으면 빈값. 이용권 가격·요금표, 영상 제목, 메뉴 이름, 성인 문구는 모으지 않는다. 로그에는 개수만 남기고 문구는 PR과 결과 파일에만 둔다. PR을 합치는 것이 확인이다.
- 새 업체는 주소·앱 id를 추측하지 않는다. 모르면 `pending`. 공식 로고 이미지 주소를 알면 `logoUrl`에 적는다.
- 이미지는 sharp로 다시 저장한 결과만 커밋한다. 원본 파일은 커밋하지 않는다.
- 조건별 웹하드(`benefits/<id>/`)는 `bin/compose.mjs`의 `PICKS`가 혜택 문구·앱 정보로 묶는다. 2곳 이상일 때만 보이고, `unconfirmed` 혜택은 넣지 않는다.
- 집계에 쓴 데이터 칸은 `metrics.json` 최신 주 합계와 `ranking.json` 주 수로만 채운다. 모으지 않는 값(클릭 수 등)은 넣지 않는다.

## 디자인 변수 (`:root`)

- 기존 파일픽 디자인(흰 카드 목록, 남색 버튼, 오른쪽 사이드바, 카드형 안내 페이지)을 따른다. 새 요소는 총점 게이지, 통계 줄의 남은 시간, 사이드바의 집계에 쓴 데이터, 순위표 아래 혜택 조건 칩, 순위표 줄의 혜택 칩(가입 혜택·기타 혜택 두 줄, 가입은 `--chip-bg`·`--chip-text`, 기타는 회색 바탕, 모바일은 첫 줄 칩만), 로고는 가로세로 비율로 넓이를 맞춰 크기를 통일(`LOGO_AREA`), 사이트 확인(남색 채움)·상세 정보(연한 테두리) 같은 크기 두 버튼(둘 다 › 아이콘)(누르는 영역 44px 안에 작은 모양), 게이지 아래 '총점' 라벨, 순위 검증 가이드의 다른 웹하드 캐러셀(`src/rail.js`, 스크립트가 꺼져도 옆으로 넘겨 볼 수 있음), 업체 페이지(요약 카드 + 기본 정보·혜택 정보·요약 지표·업체 설명)다. 업체 설명은 데이터로 만든 문장만 쓴다. 통계 줄은 본문 전체 폭(순위표 왼쪽 끝~사이드바 오른쪽 끝)에 맞춘다.
- 색: `--blue` 큰 순위 숫자·게이지, `--blue-text` 작은 파란 글자(혜택·라벨), `--navy` 버튼·안내 카드, `--bg` 바탕, `--line`·`--line-soft` 선, `--text`·`--muted` 글자, `--logo-bg` 로고 상자, `--up`·`--down` 변동, `--accent` 로고 "픽", `--guide-text`·`--guide-link` 안내 카드 글자, `--track` 게이지 바탕, `--pill` 모바일 메뉴, `--chip-bg`·`--chip-text` 가입 혜택 칩.
- 모서리 `--radius-panel`·`--radius-box`·`--radius-btn`, 머리글 높이 `--head-h`.
- 가리킴·포커스는 덧칠(어두운 글자 위 8%/10%, 남색 위 흰색 10%)만 쓴다. 색·크기·위치를 바꾸지 않는다.
- CSS 클래스는 `블록__요소--변형` 형식.

## 올리기 전 확인

1. `node --test "test/*.test.mjs"` 통과
2. `node bin/compose.mjs` 성공
3. `node bin/sweep.mjs` 통과
4. `node bin/frames.mjs` 통과, `.frames/` 스크린샷 확인
5. 커밋 메시지는 `영역: 내용` 형식
