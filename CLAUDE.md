# 작업 메모

의존성 없는 정적 사이트. `data/`의 JSON을 `bin/compose.mjs`가 읽어 `_site/`에 HTML을 만들고, GitHub Actions가 Pages로 게시한다.

## 명령

| 할 일 | 명령 |
|---|---|
| 설치 | `npm ci` |
| 빌드 | `node bin/compose.mjs` (결과: `_site/`) |
| 단위 테스트 | `node --test "test/*.test.mjs"` |
| 내용 검사 | `node bin/sweep.mjs` (전체 기록까지: `--history`) |
| 화면 검사 | `node bin/frames.mjs` (실제 데이터 + `test/fixtures/extreme`, 스크린샷은 `.frames/`) |
| 지표 수집 | `node bin/harvest.mjs` (네트워크 필요, Actions에서 실행) |
| 순위 계산 | `node bin/tally.mjs` (Actions에서 실행) |
| 로고 받기 | `node bin/pics.mjs` (네트워크 필요, `이미지 받기` 워크플로, 다시 받기: `--force`, 일부만: `--only=id,id`) |

빌드 환경 변수: `SITE_URL`(게시 주소, 없으면 자리표시 주소), `DATA_DIR`, `OUT_DIR`.

## 폴더

- `data/vendors.json` 업체 목록. `status`는 `active` / `pending` / `excluded`(계산·화면 모두 제외).
- `data/metrics.json` 주별 지표(`search`, `searchPrior`, `installs`, `installsText`, `ratings`, `score`, 못 받아 이전 값을 쓴 항목은 `carried`).
- `data/ranking.json` 주별 순위. `entries[]`: `id`, `rank`, `total`, `items`(항목별 점수), `bonus`(운영 가산), `star`. `items` 합 + `bonus` = `total`.
- `data/baseline.json` 첫 계산 결과. "기본 값으로 돌려줘"면 이 내용으로 `ranking.json`을 되돌린다.
- `data/faq.json` 첫 화면(`home`)·기준 페이지(`criteria`) FAQ. 답은 60자 안팎.
- `src/site.css` 스타일 원본(빌드 때 주석 제거, 글꼴 규칙·업체 색 덧붙임). `src/fonts.json` 글꼴 조각 목록.
- `assets/` 글꼴(Pretendard, OFL), 업체 가로 로고(`logo/<id>.webp`, 여백을 자르고 장식·마스코트는 잘라 낸 것), 파비콘, 공유 이미지. 로고가 없으면 화면에 첫 글자 상자가 나온다.
- `bin/` 스크립트. `guard.mjs`는 빌드·검사 보조.
- `.github/workflows/` `gate.yml` 검사, `ship.yml` 게시, `tide.yml` 주간 갱신, `pics.yml` 로고 받기.

## 데이터 규칙

- 혜택: `{ "kind": "join" | "event", "text": "가입 1,000P" }`. 16자 이내, 꼬리말("지급", "진행 중" 등) 없이. 모르면 비워 둔다(화면: "공식 사이트에서 확인하세요.").
- 새 업체는 주소·앱 id를 추측하지 않는다. 모르면 `pending`. 공식 로고 이미지 주소를 알면 `logoUrl`에 적는다.
- 이미지는 sharp로 다시 저장한 결과만 커밋한다. 원본 파일은 커밋하지 않는다.

## 디자인 변수 (`:root`)

- 색: `--c-bg` 바탕, `--c-panel` 카드, `--c-line`·`--c-line-strong` 선, `--c-text`·`--c-text-2` 글자, `--c-key` 강조(순위 숫자·게이지·채운 버튼), `--c-top`·`--c-top-1` 1~3위 행, `--c-join`·`--c-event` 혜택 칩, `--c-extra` 운영 가산, `--c-up`·`--c-down` 변동, `--c-star` 별, `--c-track` 게이지 바탕.
- 간격 `--s-1`~`--s-8`, 모서리 `--r-1`·`--r-2`·`--r-icon`, 머리글 높이 `--head-h`.
- 가리킴·포커스는 `--rgb-text` 8%/10% 덧칠만 쓴다. 색·크기·위치를 바꾸지 않는다.
- CSS 클래스는 `블록__요소--변형` 형식.

## 올리기 전 확인

1. `node --test "test/*.test.mjs"` 통과
2. `node bin/compose.mjs` 성공
3. `node bin/sweep.mjs` 통과
4. `node bin/frames.mjs` 통과, `.frames/` 스크린샷 확인
5. 커밋 메시지는 `영역: 내용` 형식
