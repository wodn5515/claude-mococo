# claude-mococo

**Discord 위에서 동작하는 나만의 AI 팀.** 각각 고유한 Discord 봇, GitHub 계정, 성격을 가진 전문 AI 에이전트들입니다. 말을 걸면 팀끼리 소통하며 여러 저장소의 작업을 조율합니다.

```
나: "my-app에 위시리스트 기능이 필요해"

Leader (봇):    "위시리스트를 만드는 거군요. @Planning 분석 부탁합니다."
Planning (봇):  "계획 완료. @Backend API 만들어주세요. @Frontend UI 부탁합니다."
Backend (봇):   "API 완료. @Frontend 준비됐어요."
Frontend (봇):  "UI 완료. @Review feat/user-wishlist 리뷰 부탁합니다."
Review (봇):    "LGTM. PR: github.com/mococo-review/my-app/pull/42"
```

각 팀은 **고유한 Discord 봇**이며, **자체 GitHub 계정**으로 코드를 푸시합니다.

---

## 팀별 필요 사항

각 팀에 필요한 것:

| 항목 | 팀당 수량 | 설명 |
|------|----------|------|
| Discord Application + Bot | 팀당 1개 | Discord에서 독립적인 봇 유저 |
| GitHub 계정 | 팀당 1개 | 독립적인 git author + push 신원 |
| GitHub PAT | 팀당 1개 | `gh` CLI 작업용 (push, PR) |
| AI 엔진 CLI | 공유 | Claude/Codex/Gemini 구독 공유 |

**기본 6개 팀 기준으로 필요한 것:**
- Discord Application 6개 (각각 봇 유저 생성)
- GitHub 계정 6개 (각각 PAT 토큰 포함)
- Discord 서버 1개 + 작업 채널 1개 (모든 봇이 참여)
- Node.js 프로세스 1개 (모든 봇 관리)

**작게 시작할 수 있습니다** — 2~3개 팀만 먼저 설정하고, 나중에 추가하세요.

---

## 설치 가이드

### 1단계: 클론 및 설치

```bash
git clone https://github.com/YOUR_USER/claude-mococo.git
cd claude-mococo
npm install
```

### 2단계: AI 엔진 CLI 설치

```bash
# Claude CLI (필수 — 메인 엔진)
claude --version

# Codex CLI (선택 — Planning 팀에서 사용)
npm install -g @openai/codex

# Gemini CLI (선택 — Design 팀에서 사용)
npm install -g @google/gemini-cli
```

Codex나 Gemini가 없다면? `teams.json`에서 해당 팀의 engine을 `"claude"`로 변경하세요.

### 3단계: Discord 봇 생성 (팀당 1개)

**각 팀마다** (Leader, Planning, Backend, Frontend, Review, Design) 아래 과정을 반복합니다:

#### 3a. Discord Application 생성

1. https://discord.com/developers/applications 접속
2. **"New Application"** 클릭
3. 팀 이름으로 생성:
   - `mococo-leader`
   - `mococo-planning`
   - `mococo-backend`
   - `mococo-frontend`
   - `mococo-review`
   - `mococo-design`
4. **"Create"** 클릭

#### 3b. 봇 설정

1. 왼쪽 사이드바 → **"Bot"**
2. (선택) 이 봇의 프로필 사진 업로드
   - 각 팀이 구별되도록 서로 다른 아바타를 설정하세요
3. **"Reset Token"** 클릭 → **토큰 복사** → 안전한 곳에 저장
4. **Privileged Gateway Intents**에서 다음을 활성화:
   ```
   ✅ Presence Intent          → ON
   ✅ Server Members Intent    → ON
   ✅ Message Content Intent   → ON  ← 필수! 이것 없으면 메시지를 못 읽음
   ```
5. **"Save Changes"** 클릭

#### 3c. 서버에 봇 초대

1. 왼쪽 사이드바 → **"OAuth2"**
2. **Scopes**에서 체크: `bot`
3. **Bot Permissions**에서 체크:
   - `Send Messages` (메시지 보내기)
   - `Read Message History` (메시지 기록 읽기)
   - `Embed Links` (링크 임베드)
   - `Attach Files` (파일 첨부)
4. 생성된 URL 복사 → 브라우저에서 열기 → 서버 선택 → **"Authorize"**

**3a~3c를 각 팀마다 반복하세요.** 완료하면 서버에 6개의 봇이 있을 것입니다.

#### 3d. 작업 채널 ID 가져오기

1. Discord → **사용자 설정** → **고급** → **개발자 모드** 활성화
2. 작업 채널 (예: `#mococo-work`) 우클릭 → **"채널 ID 복사"**

### 4단계: GitHub 계정 생성 (팀당 1개)

각 팀이 고유한 GitHub 계정을 가져서 커밋과 PR이 다른 사람으로 표시됩니다.

#### 4a. 계정 생성

각 팀의 GitHub 계정을 만듭니다. 추천 유저네임:

| 팀 | GitHub 유저네임 | 이메일 |
|----|----------------|--------|
| Leader | `mococo-leader` | (아무 이메일) |
| Planning | `mococo-planning` | (아무 이메일) |
| Backend | `mococo-backend` | (아무 이메일) |
| Frontend | `mococo-frontend` | (아무 이메일) |
| Review | `mococo-review` | (아무 이메일) |
| Design | `mococo-design` | (아무 이메일) |

**팁:** 이메일 별칭을 사용할 수 있습니다 (예: `you+mococo-backend@gmail.com`).

#### 4b. Personal Access Token (PAT) 생성

각 GitHub 계정마다:

1. 해당 계정으로 로그인
2. https://github.com/settings/tokens?type=beta 접속 (Fine-grained 토큰)
3. **"Generate new token"** 클릭
4. 이름: `mococo`
5. Repository access: **All repositories** (또는 특정 저장소 선택)
6. Permissions:
   - **Contents**: Read and Write (push용)
   - **Pull requests**: Read and Write (PR 생성용)
   - **Metadata**: Read-only (필수)
7. **"Generate token"** 클릭 → 토큰 복사

**중요:** 코드를 푸시하는 팀만 PAT가 반드시 필요합니다:
- **PAT 필수:** Backend, Frontend, Review (커밋/푸시 수행)
- **PAT 선택:** Leader, Planning, Design (읽기/분석만 수행)

#### 4c. 팀을 Collaborator로 추가

팀이 작업할 각 저장소에서:

1. 저장소 → **Settings** → **Collaborators**
2. 각 팀의 GitHub 계정을 Collaborator로 추가 (Write 권한)

조직(Organization)을 사용한다면, 계정들을 Write 권한이 있는 팀에 추가하세요.

#### 4d. teams.json에 Git 신원 정보 업데이트

`teams.json`의 `git.email`을 각 계정의 noreply 이메일로 업데이트합니다.
이렇게 하면 커밋이 GitHub 프로필에 연결됩니다:

```jsonc
"backend": {
  "git": {
    "name": "Sam (Backend)",
    "email": "mococo-backend@users.noreply.github.com"
  }
}
```

noreply 이메일 형식: `USERNAME@users.noreply.github.com`

### 5단계: 환경 설정

```bash
cp .env.example .env
```

`.env`에 모든 토큰을 입력합니다:

```bash
# ── Discord ──────────────────────────────────────────
WORK_CHANNEL_ID=1234567890123456789

# ── Discord 봇 토큰 (팀당 1개) ──────────────────────
LEADER_DISCORD_TOKEN=MTIz...리더_봇_토큰
PLANNING_DISCORD_TOKEN=NDU2...플래닝_봇_토큰
BACKEND_DISCORD_TOKEN=Nzg5...백엔드_봇_토큰
FRONTEND_DISCORD_TOKEN=MDEy...프론트엔드_봇_토큰
REVIEW_DISCORD_TOKEN=MzQ1...리뷰_봇_토큰
DESIGN_DISCORD_TOKEN=Njc4...디자인_봇_토큰

# ── GitHub PAT (팀당 1개) ────────────────────────────
BACKEND_GITHUB_TOKEN=github_pat_xxxxx
FRONTEND_GITHUB_TOKEN=github_pat_xxxxx
REVIEW_GITHUB_TOKEN=github_pat_xxxxx
# 푸시하지 않는 팀은 비워둡니다:
LEADER_GITHUB_TOKEN=
PLANNING_GITHUB_TOKEN=
DESIGN_GITHUB_TOKEN=

# ── Hook 서버 ───────────────────────────────────────
HOOK_PORT=9876
```

### 6단계: 저장소 연결

```bash
ln -s /절대/경로/my-web-app repos/my-web-app
ln -s /절대/경로/my-api repos/my-api

# 확인
ls -la repos/
```

### 7단계: 실행

```bash
npm start        # 프로덕션
npm run dev      # 개발 모드 (자동 재시작)
```

다음과 같이 표시됩니다:

```
Hook receiver listening on :9876
Starting 6 team bots...
  Leader bot online as @mococo-leader#1234
  Planning bot online as @mococo-planning#5678
  Backend bot online as @mococo-backend#9012
  Frontend bot online as @mococo-frontend#3456
  Review bot online as @mococo-review#7890
  Design bot online as @mococo-design#2345
claude-mococo running — 6/6 teams online (engines: claude, codex, gemini)
```

### 8단계: 테스트

Discord 작업 채널에서:

```
!teams     → 모든 팀 목록 (온라인/오프라인 상태)
!repos     → 연결된 저장소 목록
!status    → 각 팀의 작업 중/유휴 상태
```

요청 테스트:

```
repos/my-web-app을 분석해줘
```

Leader 봇이 응답합니다. 특정 팀에 직접 말하려면 해당 봇을 @멘션하세요:

```
@mococo-backend repos/my-api의 API 라우트를 확인해줘
```

---

## 작동 방식

### 각 팀 = 독립 Discord 봇

웹훅 방식과 달리, 각 팀은 **실제 Discord 봇 유저**입니다:

```
Discord 서버:
  #mococo-work
    ├── mococo-leader (봇)     ← 모든 사람 메시지에 응답
    ├── mococo-planning (봇)   ← @멘션 시 응답
    ├── mococo-backend (봇)    ← @멘션 시 응답
    ├── mococo-frontend (봇)   ← @멘션 시 응답
    ├── mococo-review (봇)     ← @멘션 시 응답
    └── mococo-design (봇)     ← @멘션 시 응답
```

**왜 봇을 분리하나요?**
- 각 팀이 Discord에서 고유한 프로필 사진과 이름을 가짐
- 특정 팀의 봇을 직접 @멘션할 수 있음
- 메시지가 해당 봇에서 진짜로 발송됨 (웹훅 사칭이 아님)
- 각 봇의 온라인/오프라인 상태가 멤버 목록에 표시됨

### 각 팀 = 독립 GitHub 계정

Backend가 코드를 푸시하면 `mococo-backend` GitHub 유저로 표시됩니다:

```
commit abc1234
Author: Sam (Backend) <mococo-backend@users.noreply.github.com>

Pull Request #42 by mococo-review
```

`GH_TOKEN` 환경변수가 팀별로 설정되어, `gh` CLI 작업이 해당 팀의 GitHub 계정으로 수행됩니다.

### 메시지 라우팅

```
사람이 #mococo-work에 메시지 입력
  │
  ├─ 특정 봇을 @멘션했나? → 해당 팀이 응답
  │
  └─ @멘션 없음? → Leader 봇이 응답 (Leader만 모든 메시지를 감시)

팀 AI가 Discord에 응답
  │
  ├─ 응답에 @다른팀 언급? → 해당 팀 자동 호출
  │
  └─ 언급 없음? → 완료
```

### 멀티 엔진

```
각 팀의 엔진은 teams.json에 설정:
  ├─ "claude"  → claude -p (풀 에이전트: 파일 편집, git, 명령어)
  ├─ "codex"   → codex (텍스트 전용: 계획, 분석)
  └─ "gemini"  → gemini (텍스트 전용: 디자인, 대용량 컨텍스트)
```

---

## 팀 구성

| 팀 | 봇 이름 | 캐릭터 | 엔진 | 역할 |
|----|---------|--------|------|------|
| **Leader** | mococo-leader | Alex (CTO) | Claude | 작업 위임 |
| **Planning** | mococo-planning | Morgan | Codex | 계획 수립 |
| **Backend** | mococo-backend | Sam | Claude | 서버 코드 |
| **Frontend** | mococo-frontend | Riley | Claude | UI 코드 |
| **Review** | mococo-review | Casey | Claude | 리뷰, 푸시, PR |
| **Design** | mococo-design | Jordan | Gemini | UI/UX 가이드 |

---

## 커스터마이징

### 새 팀 추가

1. Discord Application + Bot 생성 (3단계)
2. GitHub 계정 + PAT 생성 (4단계)
3. `teams.json`에 추가:

```jsonc
"testing": {
  "name": "Testing",
  "color": "#F1C40F",
  "avatar": "test",
  "engine": "claude",
  "model": "sonnet",
  "maxBudget": 10,
  "prompt": "prompts/testing.md",
  "discordTokenEnv": "TESTING_DISCORD_TOKEN",
  "githubTokenEnv": "TESTING_GITHUB_TOKEN",
  "git": {
    "name": "Pat (Testing)",
    "email": "mococo-testing@users.noreply.github.com"
  },
  "permissions": {
    "deny": ["git push", "gh pr"]
  }
}
```

4. `.env`에 토큰 추가:
```
TESTING_DISCORD_TOKEN=xxx
TESTING_GITHUB_TOKEN=xxx
```

5. `prompts/testing.md` 생성 (성격과 역할 정의).

6. 봇 재시작.

### 최소 구성으로 시작

6개 팀 전부 필요하지 않습니다. 최소 구성:

```
Leader (필수 — 사람 메시지를 라우팅)
+ 작업 팀 1개 (예: Backend)
= Discord 봇 2개 + GitHub 계정 2개
```

필요에 따라 팀을 추가하세요.

### 저장소별 규칙

`prompts/repo-specific/<저장소명>.md` 생성:

```markdown
# my-web-app 규칙
- Tailwind CSS 사용
- Django 컨벤션 준수
```

해당 저장소 작업 시 자동으로 주입됩니다.

---

## 권한

| 팀 | 파일 편집 | 푸시 | PR 생성 | PR 머지 |
|----|----------|------|---------|---------|
| Leader | 불가 | 불가 | 불가 | 불가 |
| Planning | 불가 | 불가 | 불가 | 불가 |
| Backend | 가능 | 불가 | 불가 | 불가 |
| Frontend | 가능 | 불가 | 불가 | 불가 |
| Review | 가능 | 가능 | 가능 | **불가** |
| Design | 불가 | 불가 | 불가 | 불가 |

**글로벌 규칙:** 어떤 팀도 PR을 머지할 수 없습니다. 사람만 머지합니다.

---

## Discord 명령어

| 명령어 | 기능 |
|--------|------|
| `!status` | 모든 팀의 작업 중/유휴 + 온라인/오프라인 상태 |
| `!teams` | 팀 목록 (엔진, 온라인 상태 포함) |
| `!repos` | 연결된 저장소 목록 |

---

## 문제 해결

| 문제 | 해결 방법 |
|------|----------|
| 봇이 응답하지 않음 | 해당 봇의 Developer Portal에서 **Message Content Intent** 활성화 |
| "No team has a Discord token" | `.env`에 각 팀의 `<TEAM>_DISCORD_TOKEN=xxx` 추가 |
| Leader만 응답함 | 다른 봇들은 해당 봇을 직접 @멘션해야 응답 |
| "command not found: codex" | `npm install -g @openai/codex` 설치 또는 engine을 `"claude"`로 변경 |
| 팀이 GitHub에 푸시 불가 | `.env`의 해당 팀 `<TEAM>_GITHUB_TOKEN`이 유효한 PAT인지 확인 |
| 커밋 작성자가 잘못 표시됨 | `teams.json`의 `git.email`을 GitHub 계정의 noreply 이메일로 업데이트 |
| Hook 권한 오류 | `chmod +x hooks/*.sh` 실행 |

---

## 프로젝트 구조

```
claude-mococo/
├── package.json
├── tsconfig.json
├── teams.json                # 팀 설정 (신원, 엔진, 권한, 토큰 환경변수)
├── .env                      # 모든 토큰 (팀별 Discord, 팀별 GitHub)
├── CLAUDE.md                 # 모든 팀에 적용되는 공통 규칙
│
├── src/
│   ├── index.ts              # 진입점: 모든 팀 봇 + hook 서버 시작
│   ├── types.ts              # TypeScript 타입
│   ├── config.ts             # teams.json 로드, 환경변수에서 토큰 해석
│   ├── bot/
│   │   ├── client.ts         # 팀당 Discord.Client 생성
│   │   ├── router.ts         # 메시지 → 팀 라우팅
│   │   └── embeds.ts         # 리치 임베드 빌더
│   ├── teams/
│   │   ├── invoker.ts        # 프롬프트 빌드 → 엔진 실행 → 결과 수집
│   │   ├── context.ts        # 인메모리 대화 기록
│   │   └── concurrency.ts    # 팀 작업 중 추적, 큐잉
│   ├── orchestrator/
│   │   ├── engine-base.ts    # 추상 엔진 (공통 git+github 환경변수)
│   │   ├── claude-engine.ts  # Claude CLI 래퍼
│   │   ├── codex-engine.ts   # Codex CLI 래퍼
│   │   ├── gemini-engine.ts  # Gemini CLI 래퍼
│   │   ├── engines.ts        # 엔진 팩토리
│   │   └── prompt-builder.ts # 팀 프롬프트 + 컨텍스트 빌더
│   └── server/
│       └── hook-receiver.ts  # Hook 이벤트용 HTTP 서버
│
├── hooks/
│   ├── event-bridge.sh       # 이벤트를 Discord로 전달
│   └── permission-gate.sh    # 팀별 권한 적용
│
├── prompts/                  # 팀별 성격 파일
│   ├── leader.md, planning.md, backend.md,
│   ├── frontend.md, review.md, design.md
│   └── repo-specific/       # 저장소별 규칙
│
└── repos/                    # 심볼릭 링크된 저장소
```

## 라이선스

MIT
