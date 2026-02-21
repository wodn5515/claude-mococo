# claude-mococo

[English](README.md)

**Discord 위의 AI 어시스턴트.** 각 어시스턴트는 AI 엔진(Claude, Codex, Gemini)으로 구동되는 실제 Discord 봇입니다. 고유한 GitHub 계정, 성격, 권한을 가집니다. 하나부터 시작해서 필요할 때 더 추가하세요.

```
나: "my-app에 로그인 페이지 만들어줘"

어시스턴트 (봇): "알겠습니다. 인증 라우트와 로그인 폼을 만들게요."
              → 코드 커밋 → 브랜치 푸시 → PR 생성
```

---

## 빠른 시작

### 1. 설치

```bash
npm install -g claude-mococo
```

AI 엔진 CLI도 최소 하나 필요합니다:

```bash
claude --version                  # Claude CLI (추천)
npm install -g @openai/codex      # Codex CLI (선택)
npm install -g @google/gemini-cli # Gemini CLI (선택)
```

### 2. Discord 봇 만들기

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. 이름 지정 (예: `my-assistant`)
3. 사이드바 → **Bot**:
   - 봇 토큰 복사
   - **Privileged Gateway Intents** 3개 모두 활성화 (Presence, Server Members, **Message Content**)
4. 사이드바 → **OAuth2**:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
   - URL 복사 → 브라우저에서 열기 → 서버에 추가

> 어시스턴트마다 별도의 Discord 봇이 필요합니다. 위 과정을 반복하세요.

### 3. 워크스페이스 생성 및 어시스턴트 추가

```bash
mkdir my-team && cd my-team
mococo init                   # 워크스페이스 생성
mococo add                    # 대화형 마법사
```

`init`과 `add` 모두 언어 플래그를 지원합니다:

```bash
mococo init --lang ko         # 한국어 프롬프트
mococo add --lang en          # 영어 프롬프트 (기본값)
```

`--lang` 생략 시 시작할 때 물어봅니다: `Use Korean? (한국어로 진행할까요?) [y/N]`

### 4. 저장소 연결 및 시작

```bash
ln -s /경로/my-app repos/my-app
mococo start
```

Discord 채널에서 봇에게 말을 걸면 됩니다.

---

## CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `mococo init` | 현재 디렉토리에 워크스페이스 생성 |
| `mococo add` | 어시스턴트 추가 (대화형 마법사) |
| `mococo edit <id>` | 어시스턴트 설정 편집 |
| `mococo start` | 모든 어시스턴트 시작 |
| `mococo dev` | 개발 모드 (트리거 시 자동 리빌드) |
| `mococo restart` | 리빌드+재시작 트리거 (`dev`와 함께 사용) |
| `mococo list` | 설정된 어시스턴트 목록 |
| `mococo remove <id>` | 어시스턴트 제거 |

**공통 옵션:** `--lang <en|ko>` — `init`, `add`, `edit`의 CLI 언어 설정.

---

## 상세 명령어 레퍼런스

### `mococo init`

새 워크스페이스를 생성하거나 기존 워크스페이스를 업데이트합니다.

```bash
mkdir my-team && cd my-team
mococo init
```

**실행 화면:**

```
Use Korean? (한국어로 진행할까요?) [y/N]: y

워크스페이스를 초기화합니다...

Discord 작업 채널 ID (전체 채널이면 비워두세요): 1234567890123456
Discord 사용자 ID (이름 우클릭 → 사용자 ID 복사): 9876543210987654

워크스페이스가 생성되었습니다:
  teams.json   — 어시스턴트 설정
  .env         — 토큰 및 설정
  prompts/     — 성격 파일
  repos/       — 연결된 저장소
  hooks/       — Claude Code 훅

다음: `mococo add`를 실행하여 첫 어시스턴트를 추가하세요.
```

**생성되는 파일:**

| 파일/디렉토리 | 용도 |
|---------------|------|
| `teams.json` | 메인 설정 — 모든 어시스턴트 정의 |
| `.env` | 토큰 및 환경 변수 |
| `.gitignore` | `.env`, `.mococo/`, `repos/*` 제외 |
| `prompts/` | 각 어시스턴트의 성격 파일 |
| `prompts/shared-rules.md` | 모든 어시스턴트가 공유하는 공통 규칙 |
| `repos/` | 실제 저장소로의 심볼릭 링크 |
| `hooks/` | Claude Code git 훅 |
| `.mococo/` | 내부 상태 디렉토리 |

**재초기화:** `teams.json`이 이미 존재하면, `mococo init`은 모든 어시스턴트를 보존하고 전역 설정(채널 ID, 사용자 ID, 훅)만 업데이트합니다.

---

### `mococo add`

새 AI 어시스턴트를 추가하는 대화형 마법사입니다. 모든 설정 옵션을 단계별로 안내합니다.

```bash
mococo add
# 또는 한국어로:
mococo add --lang ko
```

**전체 마법사 진행 화면:**

```
한국어로 진행할까요? [y/N]: y

새 에이전트 추가

── 신원 ──
어시스턴트 ID (소문자, 예: hr): backend
표시 이름 (예: Backend) (Backend): 백엔드 개발자
리더입니까 (모든 메시지에 응답)? [y/N]: N

── 캐릭터 ──
MBTI:
  > 1. ENTJ — 전략가, 결단력, 큰 그림을 보는 리더
    2. ISTJ — 규칙 준수, 체계적, 정확성 중심
    3. ENFJ — 사람 중심, 공감 능력, 팀 조화
    4. INTP — 분석적, 논리적, 깊이 파는 탐구자
    5. 직접 입력
선택 (1): 2

말투:
  > 1. 모두에게 존댓말
    2. 사람에게 존댓말 + 동료에게 반말
    3. 직접 입력
선택 (1): 2

성격 특성 (행동 예시 포함, 쉼표 구분):
  예: "체계적 — 모든 요구사항을 구조화, 신중함 — 불확실하면 검증"
  특성: 꼼꼼함 — 엣지 케이스를 잡아냄, 효율적 — 최소 코드로 최대 효과

습관 (쉼표 구분):
  예: "결론→근거→다음 단계 순서로 보고"
  습관: 항상 테스트부터 작성, API 변경 시 즉시 문서화

── 역할 ──
핵심 역할 (1-2문장): API 설계, 데이터베이스, 서버 로직을 담당하는 백엔드 개발자.

담당 범위 (쉼표 구분):
  범위: API 개발, 데이터베이스 설계, 서버 아키텍처

담당 아님 (쉼표 구분):
  담당 아님: UI/UX, 프론트엔드 스타일링

독립 결정 권한: API 구조, DB 스키마, 코드 스타일
승인 필요 사항: 대규모 아키텍처 변경, 새 프레임워크 도입

전문 분야 (쉼표 구분):
  전문 분야: Python, FastAPI, PostgreSQL, Docker

추가 규칙 (쉼표 구분):
  규칙: 입력값 항상 검증, 내부 에러를 클라이언트에 노출 금지

에이전트 팀 모드 활성화 (병렬 서브 에이전트)? [y/N]: N

── 엔진 ──
Engine:
  > 1. claude
    2. codex
    3. gemini
선택 (1): 1
모델 (sonnet): opus
호출당 최대 예산 ($) (10): 10

── 토큰 ──
Discord 봇 토큰: MTIz...your-token-here

── 채널 ──
봇이 응답할 채널 ID (쉼표 구분, 비우면 전체 채널):
  채널:

── 권한 ──
권한 프리셋:
    1. 전체 — 푸시, PR 생성 가능
  > 2. 개발자 — 파일 수정 가능, 푸시 불가
    3. 읽기 전용 — 수정 불가, 푸시 불가
선택 (2): 1

── Git 신원 ──
Git 작성자 이름 (백엔드 개발자 (mococo)): 백엔드 개발자
Git 작성자 이메일 (backend@users.noreply.github.com):

"백엔드 개발자" (backend) 추가 완료.
  설정:    teams.json
  프롬프트:  prompts/backend.md  (편집 가능)
  토큰:    .env

`mococo start`로 실행하세요.
```

**생성되는 것:**
- `teams.json`에 모든 설정이 포함된 항목
- `.env`에 `{ID}_DISCORD_TOKEN=...` 추가
- `prompts/{id}.md` — 자동 생성된 성격 파일 (자유롭게 편집 가능)

---

### `mococo edit <id>`

기존 어시스턴트의 설정을 편집합니다.

```bash
mococo edit backend
```

**메뉴:**

```
어시스턴트 편집 중 "백엔드 개발자" (backend)

편집할 항목:
  > 1. name        — 표시 이름
    2. character   — MBTI, 말투, 성격, 습관
    3. role        — 범위, 권한, 전문성
    4. engine      — 엔진 및 모델
    5. budget      — 최대 예산
    6. channels    — 채널 제한
    7. permissions — 권한 프리셋
    8. git         — Git 작성자 정보
    9. all         — 전부 편집
선택 (8):
```

- **character** 또는 **role** 편집 시 성격 파일(`prompts/{id}.md`) 재생성 여부를 물어봅니다
- 개별 섹션을 편집하거나 `all`을 선택해 전체를 다시 설정할 수 있습니다

---

### `mococo list` / `mococo ls`

설정된 모든 어시스턴트를 테이블로 표시합니다.

```bash
mococo list
```

**출력 예시:**

```
  ID               Name             Engine     Model              Leader
  ──────────────── ──────────────── ────────── ────────────────── ──────
  leader           팀 리더          claude     sonnet             yes
  backend          백엔드 개발자     claude     opus
  designer         디자이너          gemini     gemini-2.5-pro
```

---

### `mococo remove <id>` / `mococo rm <id>`

어시스턴트를 제거하고 관련 파일을 정리합니다.

```bash
mococo remove backend
```

**제거되는 것:**
- `teams.json`에서 해당 항목
- `prompts/{id}.md` — 성격 파일
- `.env`에서 `{ID}_*` 토큰 라인

---

### `mococo start`

설정된 모든 어시스턴트를 시작합니다.

```bash
mococo start
```

**동작 과정:**
1. 워크스페이스에서 `.env` 로드
2. `teams.json` 설정 로드
3. 각 어시스턴트의 Discord 토큰 존재 여부 검증
4. HTTP 훅 수신 서버 시작 (기본 포트: 9876)
5. 유효한 토큰이 있는 각 어시스턴트의 Discord 봇 생성

**출력:**

```
Starting 3 assistant(s)...
mococo running — 3/3 assistants online (engines: claude, gemini)
```

**요구 사항:**
- mococo 워크스페이스(`teams.json`이 있는 디렉토리)에서 실행
- 각 어시스턴트에 `.env`의 `{ID}_DISCORD_TOKEN` 필요

---

### `mococo dev`

개발 모드로 시작합니다. 재시작 트리거를 감시하며, 트리거 시 TypeScript를 리빌드하고 봇을 재시작합니다.

```bash
mococo dev
```

`nodemon`을 사용하여 변경사항을 감시합니다.

---

### `mococo restart`

`dev` 모드 실행 중 리빌드 및 재시작을 트리거합니다.

```bash
# `mococo dev` 실행 중인 다른 터미널에서:
mococo restart
```

---

## 설정 레퍼런스

### teams.json

메인 설정 파일입니다. `mococo init`으로 생성되고, `mococo add`/`edit`으로 업데이트됩니다.

```jsonc
{
  "teams": {
    "leader": {
      "name": "팀 리더",
      "color": "#5865F2",
      "avatar": "crown",
      "engine": "claude",
      "model": "sonnet",
      "maxBudget": 10,
      "prompt": "prompts/leader.md",
      "isLeader": true,
      "useTeams": false,
      "channels": [],
      "git": {
        "name": "팀 리더",
        "email": "leader@users.noreply.github.com"
      },
      "permissions": {
        "allow": ["git push", "gh pr create"],
        "deny": ["gh pr merge"]
      },
      "mcpServers": {}
    }
  },
  "globalDeny": ["gh pr merge", "git push --force main", "git push --force master"],
  "conversationWindow": 30,
  "humanDiscordId": "123456789012345678",
  "humanTitle": "사장님"
}
```

**어시스턴트별 필드:**

| 필드 | 타입 | 설명 |
|------|------|------|
| `name` | string | Discord에서의 표시 이름 |
| `color` | hex string | Discord 임베드 색상 |
| `avatar` | string | 아바타 키 (`robot`, `crown`, `brain`, `gear`, `palette`, `shield`, `eye`, `test`, `book`) |
| `engine` | string | `"claude"`, `"codex"`, 또는 `"gemini"` |
| `model` | string | 모델명 (예: `"sonnet"`, `"opus"`, `"o3"`, `"gemini-2.5-pro"`) |
| `maxBudget` | number | 호출당 최대 비용 — 달러 (Claude만 해당) |
| `prompt` | string | 성격/지시사항 파일 경로 |
| `isLeader` | boolean | `true`면 모든 메시지에 응답 (@멘션 불필요) |
| `useTeams` | boolean | 에이전트 팀 모드 활성화 (병렬 서브 에이전트) |
| `teamRules` | string[] | 서브 에이전트 행동 규칙 |
| `channels` | string[] | 응답할 채널 ID (비어 있으면 전체) |
| `discordUserId` | string | 첫 봇 로그인 시 자동 설정 |
| `git.name` | string | Git 커밋 작성자 이름 |
| `git.email` | string | Git 커밋 작성자 이메일 |
| `mcpServers` | object | MCP 서버 설정 (환경 변수는 `$VAR` 문법) |
| `permissions.allow` | string[] | 허용된 쉘 명령어 |
| `permissions.deny` | string[] | 차단된 쉘 명령어 |

**전역 필드:**

| 필드 | 타입 | 설명 |
|------|------|------|
| `globalDeny` | string[] | 모든 어시스턴트에게 차단되는 명령어 |
| `conversationWindow` | number | 컨텍스트에 포함할 최근 메시지 수 |
| `humanDiscordId` | string | Discord 사용자 ID |
| `humanTitle` | string | 어시스턴트가 사용자를 부르는 호칭 (예: "사장님", "Boss") |

### .env

환경 변수 파일입니다. `mococo init`으로 생성됩니다.

```bash
# 필수
WORK_CHANNEL_ID=1234567890123456   # 비워두면 전체 채널
HOOK_PORT=9876                      # HTTP 웹훅 수신 포트

# 선택
MEMBER_TRACKING_CHANNEL_ID=         # 멤버 이벤트 채널
DECISION_LOG_CHANNEL_ID=            # 리더 결정 로그 채널
GITHUB_TOKEN=ghp_xxxxx             # 푸시/PR용 GitHub PAT

# 어시스턴트별 하나씩 (`mococo add` 시 자동 추가)
LEADER_DISCORD_TOKEN=your-token-here
BACKEND_DISCORD_TOKEN=your-token-here
```

### prompts/{id}.md

자동 생성되는 성격 파일입니다. 자유롭게 편집할 수 있습니다 — 이 파일에서 각 어시스턴트의 캐릭터, 역할, 규칙이 정의됩니다.

**생성 구조:**

```markdown
# 어시스턴트 이름

You are **어시스턴트 이름**, an AI assistant on Discord.
When addressing the human, always call them **사장님**.

## Character
- **MBTI:** ISTJ — 규칙 준수, 체계적, 정확성 중심
- **Speech style:**
  - To the human: strictly formal and respectful
  - To other agents: casual and direct
- **Personality:**
  - 꼼꼼함 — 엣지 케이스를 잡아냄
- **Habits:**
  - 항상 테스트부터 작성

## Role
API 설계, 데이터베이스, 서버 로직을 담당하는 백엔드 개발자.

**Scope:**
- API 개발
- 데이터베이스 설계

**Not in scope:**
- UI/UX

**Decision authority:**
- Independent: API 구조, DB 스키마
- Needs approval: 대규모 아키텍처 변경

## Expertise
- Python
- FastAPI

## Rules
- 입력값 항상 검증
```

### prompts/shared-rules.md

모든 어시스턴트에 자동으로 포함되는 공통 규칙입니다. `mococo init` 시 `defaults/shared-rules.md`에서 복사됩니다.

포함 내용:
- 우선순위 체계 (규칙 > 역할 > 성격)
- 명령 체계 (사람 > 리더 > 본인)
- 절대 금지 사항 (머지 금지, 크레덴셜 노출 금지)
- 태그 및 대화 관리
- 메모리 및 행동 가이드라인
- 신규 에이전트 환영 프로토콜

`{{humanTitle}}`과 `{{leaderName}}` 플레이스홀더를 사용하며, 런타임에 실제 값으로 치환됩니다.

---

## 사용 시나리오

### 시나리오 1: 단일 어시스턴트

가장 간단한 구성 — 모든 것을 처리하는 봇 하나.

```bash
mkdir my-project && cd my-project
mococo init
mococo add
# → ID: assistant, Engine: claude, Model: opus
# → 권한: 전체

ln -s /경로/my-app repos/my-app
mococo start
```

Discord에서 `@assistant`를 멘션:

```
나: @assistant 회원가입 폼에 입력값 검증 추가해줘
봇: 이메일 형식, 비밀번호 강도, 필수 필드 검증을 추가하겠습니다.
    → 변경 → 커밋 → 푸시 → PR 생성
```

### 시나리오 2: 멀티 어시스턴트 팀

리더가 전문가에게 작업을 위임하는 팀 구성.

```bash
mkdir my-team && cd my-team
mococo init

# 리더 추가 (모든 메시지에 응답, 작업 위임)
mococo add
# → ID: leader, isLeader: yes, Engine: claude, Model: sonnet
# → 권한: 읽기 전용 (리더는 코딩하지 않고 위임만)

# 백엔드 개발자 추가
mococo add
# → ID: backend, Engine: claude, Model: opus
# → 권한: 전체

# 프론트엔드 개발자 추가
mococo add
# → ID: frontend, Engine: claude, Model: opus
# → 권한: 전체

# 저장소 연결
ln -s /경로/api repos/api
ln -s /경로/web repos/web
mococo start
```

Discord 채널에서 말하면 됩니다 (@멘션 불필요 — 리더가 자동으로 받음):

```
나: 유저 프로필 페이지 만들어줘. API 엔드포인트도 필요해.

리더: 조율하겠습니다.
      @backend GET /api/users/:id 엔드포인트 만들어라
      @frontend 프로필 페이지 컴포넌트 만들어라

backend: API 엔드포인트 작업합니다...
         → 코드 커밋 → 푸시 → PR 생성

frontend: 프로필 컴포넌트 작업합니다...
          → 코드 커밋 → 푸시 → PR 생성
```

---

## 작동 방식

**메시지 라우팅:**
- 특정 봇을 `@멘션` → 해당 어시스턴트가 응답
- 멘션 없음 → `"isLeader": true`인 어시스턴트가 응답

**크로스 어시스턴트 호출:**
어시스턴트가 다른 어시스턴트를 멘션하면 (예: `@Backend 확인 부탁`) → 자동으로 호출됩니다.

**엔진:**
- `"claude"` — 풀 에이전트 (파일 수정, git, 쉘 명령어)
- `"codex"` — 텍스트 전용 어드바이저
- `"gemini"` — 텍스트 전용 어드바이저

**권한**은 어시스턴트별로 제어합니다:

```jsonc
"permissions": {
  "allow": ["git push", "gh pr create"],   // 명시적 허용
  "deny": ["gh pr merge"]                   // 명시적 차단
}
```

**Discord 명령어** (채팅에 입력):

| 명령어 | 설명 |
|--------|------|
| `!status` | 모든 어시스턴트 상태 (작업 중/유휴, 온라인/오프라인) |
| `!teams` | 어시스턴트 목록과 엔진 |
| `!repos` | 연결된 저장소 목록 |

---

## 워크스페이스 구조

설정 완료 후 워크스페이스는 다음과 같습니다:

```
my-team/
├── teams.json              # 어시스턴트 설정
├── .env                    # 토큰 및 설정
├── .gitignore              # .env, .mococo/, repos/* 제외
├── prompts/
│   ├── shared-rules.md     # 모든 어시스턴트 공통 규칙
│   ├── leader.md           # 리더 성격
│   ├── backend.md          # 백엔드 성격
│   └── frontend.md         # 프론트엔드 성격
├── repos/
│   ├── .gitkeep
│   ├── api -> /경로/api            # 심볼릭 링크
│   └── web -> /경로/web            # 심볼릭 링크
├── hooks/                  # Claude Code git 훅
└── .mococo/                # 내부 상태
```

---

## 수동 설정 (CLI 없이)

저장소를 직접 클론해서 설정할 수도 있습니다:

```bash
git clone https://github.com/wodn5515/claude-mococo.git
cd claude-mococo
npm install
npm run build
```

`teams.json`을 직접 편집하고, `prompts/`에 프롬프트 파일을 만들고, `.env`에 토큰을 설정한 후 `npm start`로 실행합니다.

---

## 문제 해결

| 문제 | 해결 |
|------|------|
| 봇이 응답 안 함 | Discord Developer Portal에서 **Message Content Intent** 활성화 |
| "No assistant has a Discord token" | `.env`에 토큰 추가 (`{ID}_DISCORD_TOKEN=...`) |
| GitHub 푸시 불가 | `.env`에 유효한 PAT로 `GITHUB_TOKEN` 설정 |
| 커밋 작성자 틀림 | `git.email`을 `USERNAME@users.noreply.github.com`으로 설정 |
| "command not found: codex" | 설치하거나 (`npm i -g @openai/codex`) engine을 `"claude"`로 변경 |
| 봇이 잘못된 채널에서 응답 | `teams.json`의 `channels` 또는 `.env`의 `WORK_CHANNEL_ID` 설정 |

---

## 라이선스

MIT
