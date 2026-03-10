# claude-mococo

**Discord 위의 AI 팀 컴퍼니.** 여러 AI 에이전트가 각자의 Discord 봇 신원으로 함께 작동합니다 — 고유한 성격, GitHub 신원, 엔진(Claude/Codex/Gemini), 권한을 가집니다. 오케스트레이션은 Discord 메시지를 통해 이루어집니다: 사람이 말하면 에이전트들이 조율하고, 코드를 커밋하고 PR을 올립니다.

```
나: "my-app에 로그인 페이지 만들어줘"

Leader (봇): "알겠습니다. @Backend 인증 라우트와 로그인 폼 구현 부탁해요."
Backend (봇): "바로 할게요."
             → 코드 커밋 → 브랜치 푸시
Review (봇): → 코드 리뷰 → PR 생성
```

---

## 빠른 시작

### 1. 설치

```bash
npm install -g claude-mococo
```

설치 없이 바로 실행도 가능합니다:

```bash
npx claude-mococo init
npx claude-mococo add
npx claude-mococo start
```

AI 엔진도 최소 하나 필요합니다:

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

실행할 에이전트 수만큼 반복합니다.

### 3. 워크스페이스 생성 및 어시스턴트 추가

```bash
mkdir my-team && cd my-team
mococo init                   # 워크스페이스 생성 (Discord 채널 ID 입력)
mococo add                    # 대화형 마법사 — 이름, 엔진, 토큰 등 입력
```

커밋에는 어시스턴트 이름이 작성자로 표시됩니다 (`teams.json`의 `git.name`으로 설정). 푸시나 PR 생성이 필요하면 `mococo add` 시 GitHub PAT를 입력하세요.

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
| `mococo start` | 모든 어시스턴트 시작 |
| `mococo dev` | 핫 리로드 개발 모드로 시작 |
| `mococo list` | 설정된 어시스턴트 목록 |
| `mococo edit <id>` | 어시스턴트 설정 편집 |
| `mococo remove <id>` | 어시스턴트 제거 |
| `mococo restart` | 리빌드 및 재시작 트리거 |

---

## 팀 아키텍처

일반적인 풀 팀 구성:

| 어시스턴트 | 엔진 | 모델 | 역할 | 권한 |
|-----------|------|------|------|------|
| **Leader** | Claude | opus | 팀 조율, 작업 위임, 모든 메시지에 응답 | 읽기 전용 |
| **Planner** | Codex | o3 | 아키텍처 계획 및 스펙 작성 | 읽기 전용 |
| **Backend** | Claude | sonnet | 서버 코드, API, 모델 구현 | 파일 편집 + 로컬 커밋 |
| **Frontend** | Claude | sonnet | UI, 컴포넌트, CSS 구현 | 파일 편집 + 로컬 커밋 |
| **Reviewer** | Claude | opus | 코드 리뷰, 브랜치 푸시, PR 생성 | 푸시 + PR 생성 |
| **Designer** | Gemini | gemini-2.5-pro | UI/UX 가이드 (텍스트 어드바이저) | 읽기 전용 |

하나부터 시작해서 필요할 때 더 추가할 수 있습니다.

---

## 작동 방식

### 메시지 라우팅

- 멘션 없음 → `"isLeader": true`인 어시스턴트가 응답
- 특정 봇을 `@멘션` → 해당 어시스턴트가 응답
- 어시스턴트가 다른 어시스턴트를 멘션 → 자동으로 호출

### 권한

`teams.json`에서 어시스턴트별로 설정:

```jsonc
"permissions": {
  "allow": ["git push", "gh pr create"],
  "deny": ["gh pr merge"]
}
```

일반적인 권한 단계:
- **Leader / Planner / Designer:** 읽기 전용. 파일 편집·git 불가.
- **Backend / Frontend:** 파일 편집, 로컬 커밋 가능. 푸시·PR 불가.
- **Reviewer:** 브랜치 푸시·PR 생성 가능. 머지 불가.
- **전체 에이전트:** `gh pr merge`, `git push --force main/master` 전역 차단.

### 엔진

- `"claude"` — 풀 에이전트 (파일, git, 쉘 명령어 — Claude CLI 사용)
- `"codex"` — 풀 에이전트 (Codex CLI — OpenAI)
- `"gemini"` — 텍스트 전용 어드바이저 (Gemini CLI)

### 메모리 & 인박스 시스템

각 에이전트는 **인박스** (`.mococo/inbox/{id}.md`)를 가지며 메시지가 도착할 때마다 기록됩니다. 호출 시 에이전트는 다음을 전달받습니다:
- 최근 대화 기록 (설정 가능한 윈도우)
- 인박스 요약
- 장기 메모리 (`.mococo/memory/`)
- `CLAUDE.md`의 공유 규칙

**Haiku 모델** (경량 Claude)이 트리아지 작업을 처리합니다: 인박스 요약, 개선점 스캔, 하트비트 판단.

### 하트비트 & 스케줄 태스크

리더가 **3분마다** 하트비트를 실행합니다. 워크스페이스 루트에 `heartbeat.md`가 있으면 스케줄 태스크가 파싱됩니다:

| 섹션 | 주기 | 설명 |
|------|------|------|
| `## Daily` | 하루 1회 (첫 번째 하트비트) | 매일 반복 태스크 |
| `## Weekly` | 주 1회 (월요일 첫 번째 하트비트) | 매주 반복 태스크 |
| `## Hourly` | 시간당 1회 | 시간별 모니터링 태스크 |
| `## Periodic` | 하트비트마다 (~3분) | 경량 모니터링 |
| `## On-demand` | 수동 트리거만 | 일회성 태스크 |

태스크 형식:

```markdown
- [ ] 태스크 설명 @담당자
```

- `- [ ]` = 활성 (처리됨)
- `- [x]` = 비활성 (스킵)
- `@담당자` = 선택 사항, 특정 어시스턴트에게 라우팅

상태는 `.mococo/heartbeat-state.json`에 추적되어 Daily/Weekly 태스크 중복 실행을 방지합니다.

### 디스패치 레저

리더가 다른 에이전트에게 작업을 위임하면 디스패치 레저에 기록됩니다. 리더는 위임된 작업 완료 여부를 추적하고 필요 시 팔로업합니다.

---

## 설정 레퍼런스

### teams.json 필드

| 필드 | 설명 |
|------|------|
| `engine` | `"claude"`, `"codex"`, 또는 `"gemini"` |
| `model` | 모델명 (예: `"sonnet"`, `"opus"`, `"o3"`, `"gemini-2.5-pro"`) |
| `maxBudget` | 호출당 최대 비용 (Claude만 해당) |
| `prompt` | 성격/지시사항 파일 경로 |
| `isLeader` | `true`면 모든 메시지에 응답 (@멘션 불필요) |
| `discordTokenEnv` | 봇 토큰이 저장된 환경변수 이름 |
| `git.name` / `git.email` | 커밋 작성자 정보 |
| `permissions.allow` / `permissions.deny` | 허용/차단 쉘 명령어 |
| `mcpServers` | MCP 서버 설정 (예: Google Calendar) |

### 전역 설정

| 필드 | 설명 |
|------|------|
| `globalDeny` | 전체 에이전트에서 차단할 명령어 |
| `conversationWindow` | 프롬프트에 포함할 최근 메시지 수 (기본값: 30) |
| `humanTitle` | 에이전트에게 표시될 사람 호칭 (기본값: `"Boss"`) |

### 환경변수

```bash
WORK_CHANNEL_ID=              # 작업할 Discord 채널 (비우면 전체 채널)
HOOK_PORT=9876                # HTTP 웹훅 수신 포트

# 봇 토큰 (봇 1개당 1개)
LEADER_DISCORD_TOKEN=...
BACKEND_DISCORD_TOKEN=...
FRONTEND_DISCORD_TOKEN=...
PLANNING_DISCORD_TOKEN=...
REVIEW_DISCORD_TOKEN=...
DESIGN_DISCORD_TOKEN=...

# 선택적 연동
GOOGLE_OAUTH_CREDENTIALS=...  # Google Calendar MCP (Leader용)
GITHUB_PAT=...                # 푸시/PR에 필요
```

### Discord 명령어

| 명령어 | 설명 |
|--------|------|
| `!status` | 모든 어시스턴트 상태 (작업 중/유휴, 엔진, 비용) |
| `!teams` | 어시스턴트 목록과 엔진 |
| `!repos` | 연결된 저장소 목록 |

---

## 수동 설정 (CLI 없이)

```bash
git clone https://github.com/wodn5515/claude-mococo.git
cd claude-mococo
npm install
npm run build
```

`teams.json`을 직접 편집하고, `prompts/`에 프롬프트 파일을 만들고, `.env`에 토큰을 설정한 후 실행:

```bash
npm start
```

---

## 문제 해결

| 문제 | 해결 |
|------|------|
| 봇이 응답 안 함 | Discord Developer Portal에서 **Message Content Intent** 활성화 |
| "No team has a Discord token" | `.env`에 토큰 환경변수 추가 |
| GitHub 푸시 불가 | `.env`의 GitHub PAT 확인 |
| 커밋 작성자 틀림 | `git.email`을 `USERNAME@users.noreply.github.com`으로 설정 |
| "command not found: codex" | 설치하거나 engine을 `"claude"`로 변경 |
| 하트비트 미동작 | 워크스페이스 루트에 `heartbeat.md` 존재 여부 확인 |
| 에이전트 무한 루프 | `teams.json`에 `maxBudget` 설정 확인 |

---

## 라이선스

MIT
