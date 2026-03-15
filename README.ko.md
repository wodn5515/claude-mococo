# claude-mococo

**Discord 위의 AI 팀 컴퍼니.** 여러 AI 에이전트가 각자의 Discord 봇 신원으로 함께 작동합니다. 각 에이전트는 고유한 성격, 역할, 권한을 가지며 Discord 메시지를 통해 자율적으로 조율합니다.

버전: **0.9.0**

```
나: "Kil-biseo PR #42 리뷰해줘"

대장코코: "체커코코한테 넘길게요."
체커코코: → PR 코드 확인 → CI 상태 확인 → GitHub에 리뷰 코멘트 등록
대장코코: → 머지 필요 시 회장님께 보고
```

---

## 실제 운영 예시 (mococo-corps)

이 README는 실제 운영 중인 **mococo-corps** 환경을 기반으로 작성되었습니다. mococo-corps는 다음 구조로 운영됩니다:

| 봇 이름 | ID | 엔진 | 모델 | 역할 | 주요 권한 |
|---------|-----|------|------|------|----------|
| **대장코코** | `leader` | Claude | sonnet | 지휘·조율, 모든 메시지 응답, 하트비트 실행 | 읽기 전용 (파일 편집·git 불가) |
| **스택코코** | `stack` | Claude | opus | 백엔드 API, DB 설계·구현 | 파일 편집 + 로컬 커밋 (푸시·머지 불가) |
| **브러쉬코코** | `brush` | Claude | sonnet | UI/UX 구현, Figma 연동 | 파일 편집 + 로컬 커밋 (푸시·머지 불가) |
| **체커코코** | `checker` | Claude | sonnet | QA, PR 리뷰, 노션 문서화 | 읽기 전용 + PR 푸시·리뷰 가능 |

> 팀 구성은 자유롭게 설계할 수 있습니다. 위는 mococo-corps 기준 예시입니다.

---

## 빠른 시작

### 1. 설치

```bash
npm install -g claude-mococo
```

설치 없이 바로 실행:

```bash
npx claude-mococo init
npx claude-mococo add
npx claude-mococo start
```

AI 엔진 필요 (최소 하나):

```bash
claude --version                  # Claude CLI (추천)
npm install -g @openai/codex      # Codex CLI (선택)
npm install -g @google/gemini-cli # Gemini CLI (선택)
```

### 2. Discord 봇 만들기

각 에이전트마다 별도의 Discord 봇 계정이 필요합니다.

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. 이름 지정 (예: `대장코코`)
3. 사이드바 → **Bot**:
   - 봇 토큰 복사
   - **Privileged Gateway Intents** 3개 모두 활성화 (Presence, Server Members, **Message Content**)
4. 사이드바 → **OAuth2**:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
   - URL 복사 → 브라우저에서 열기 → 서버에 추가

에이전트 수만큼 반복합니다.

### 3. 워크스페이스 초기화

```bash
mkdir my-team && cd my-team
mococo init     # 워크스페이스 생성 (Discord 채널 ID 입력)
mococo add      # 에이전트 추가 (이름, 엔진, 토큰 등)
```

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
| `mococo add` | 에이전트 추가 (대화형) |
| `mococo start` | 모든 에이전트 시작 |
| `mococo dev` | 핫 리로드 개발 모드 |
| `mococo list` | 설정된 에이전트 목록 |
| `mococo edit <id>` | 에이전트 설정 편집 |
| `mococo remove <id>` | 에이전트 제거 |
| `mococo restart` | 리빌드 및 재시작 |

---

## 작동 방식

### 메시지 라우팅

- 멘션 없음 → `"isLeader": true`인 에이전트(대장코코)가 응답
- 특정 봇 `@멘션` → 해당 에이전트가 응답
- 에이전트가 다른 에이전트를 멘션 → 자동 호출

### 에이전트 성격 시스템

각 에이전트는 `prompt` 파일에 정의된 고유한 성격·말투·행동 원칙을 가집니다. 이것이 단순 챗봇과의 가장 큰 차이점입니다.

**예시 (체커코코):**
- MBTI: INTJ — 구조적 분석, 완벽주의
- 역할: QA/문서화 전담, 버그 발견 시 즉시 이슈 등록
- 원칙: "테스트 없으면 완료 없다"

성격 파일(`prompts/checker.md` 등)에 다음을 정의합니다:
- 말투와 호칭 규칙
- 역할 범위와 결정 권한
- 행동 원칙과 금지 사항
- 도구 사용 방식

### 권한 시스템

`teams.json`에서 에이전트별로 설정:

```jsonc
"permissions": {
  "deny": ["git push", "gh pr merge"]
}
```

전역 차단 (모든 에이전트):

```jsonc
"globalDeny": [
  "gh pr merge",
  "git push --force main",
  "git push --force master"
]
```

실제 mococo-corps 권한 구조:
- **대장코코:** 파일 편집·git push·gh pr 전부 차단. 판단·조율만.
- **스택코코/브러쉬코코:** 파일 편집·로컬 커밋 가능. push·merge 불가.
- **체커코코:** 읽기 전용 + PR 푸시·리뷰 가능. 머지 권한은 운영 설정에서 별도 관리.

### 메모리 시스템

각 에이전트는 응답마다 **단기 메모리**와 **장기 메모리**를 업데이트합니다:

- **단기 메모리:** 현재 진행 작업, 대기 항목, 캐시된 외부 데이터
- **장기 메모리:** 팀원 정보, 프로젝트 구조, 정책·규칙, 팀 역량

메모리는 대화 기록과 함께 에이전트 프롬프트에 주입됩니다.

### 하트비트 & 자율 작업

리더(대장코코)가 **3분마다** 하트비트를 실행합니다. `heartbeat.md`에 정의된 작업을 자동으로 처리합니다:

| 섹션 | 주기 | 예시 작업 |
|------|------|----------|
| `## Daily` | 하루 1회 | CI 실패 PR 확인, 오래된 PR 알림 |
| `## Weekly` | 주 1회 (월요일) | 주간 완료 작업 요약, 장기 미해결 이슈 점검 |
| `## Hourly` | 시간당 1회 | 서버 상태 모니터링 |
| `## Periodic` | 3분마다 | 코드 분석, 미할당 이슈 정리 |
| `## On-demand` | 수동 트리거 | 일회성 작업 |

**heartbeat.md 작성 예시:**

```markdown
## Daily
- [ ] 오픈 PR 중 CI 실패 건 확인 → 담당 에이전트에게 알림 @체커코코
- [ ] Google Calendar 오늘 일정 확인 → 요약 보고 @대장코코

## Periodic
- [ ] 서버 상태 확인 (포트 9876 응답 여부) @대장코코
- [ ] 미할당 이슈 리스트업 → 우선순위 판단 → 보고 @체커코코
```

- `- [ ]` = 활성 작업 (처리됨)
- `- [x]` = 비활성 작업 (스킵)
- `@에이전트` = 특정 에이전트에게 라우팅

상태는 `.mococo/heartbeat-state.json`에 저장되어 Daily/Weekly 중복 실행을 방지합니다.

### 디스패치 레저

리더가 다른 에이전트에게 작업을 위임하면 디스패치 레저에 기록됩니다. 리더는 완료 여부를 추적하고 미응답 시 팔로업합니다.

---

## 외부 연동 (MCP)

에이전트별로 MCP 서버를 설정할 수 있습니다:

### Google Calendar (대장코코)

```jsonc
"mcpServers": {
  "google-calendar": {
    "command": "npx",
    "args": ["-y", "@cocal/google-calendar-mcp"],
    "env": {
      "GOOGLE_OAUTH_CREDENTIALS": "$GOOGLE_OAUTH_CREDENTIALS"
    }
  }
}
```

### Figma (브러쉬코코)

```jsonc
"mcpServers": {
  "figma": {
    "type": "http",
    "url": "https://mcp.figma.com/mcp",
    "headers": {
      "X-Figma-Token": "$FIGMA_PERSONAL_ACCESS_TOKEN"
    }
  }
}
```

### Notion

Notion MCP를 연동하면 에이전트가 직접 문서를 생성하고 관리합니다. mococo-corps에서는 작업 완료 시 자동으로 노션 문서화를 수행합니다.

---

## 레포 관리 전략

에이전트들이 여러 레포를 관리할 때 레포별 규칙을 프롬프트에 정의합니다.

**mococo-corps 예시:**

| 레포 | 프로덕션 브랜치 | 작업 기준 브랜치 | PR 머지 권한 |
|------|--------------|----------------|------------|
| atom.io | `master` | `staging` | 회장님 |
| Kil-biseo | `main` | `main` | 체커코코 (리뷰+CI 통과 조건) |
| claude-mococo | `main` | `main` | 회장님 |
| orbi-advance | `prod` | `prod` | 회장님 |

레포별 정책은 에이전트 성격 파일 내 **레포별 관리 전략** 섹션에 명시합니다.

---

## 설정 레퍼런스

### teams.json 전체 구조

```jsonc
{
  "teams": {
    "leader": {                         // 에이전트 ID (임의 지정)
      "name": "대장코코",               // Discord에 표시되는 이름
      "color": "#5865F2",               // 봇 표시 색상 (optional)
      "avatar": "robot",                // 아바타 스타일 (optional)
      "engine": "claude",               // "claude" | "codex" | "gemini"
      "model": "sonnet",                // 모델명
      "maxBudget": 10,                  // 호출당 최대 비용 (USD, Claude만 해당)
      "prompt": "prompts/leader.md",    // 성격·지시사항 파일 경로
      "isLeader": true,                 // 멘션 없이도 모든 메시지에 응답
      "useTeams": false,                // 워크스페이스 레포 목록 컨텍스트 포함 여부
      "git": {
        "name": "wodn5515",
        "email": "wodn5515@gmail.com"
      },
      "mcpServers": { ... },            // MCP 서버 설정 (optional)
      "permissions": {
        "deny": ["git push", "gh pr", "Edit", "Write"]
      },
      "discordUserId": "1470298783760777269"  // 봇의 Discord User ID
    }
  },
  "globalDeny": [                       // 모든 에이전트에서 차단
    "gh pr merge",
    "git push --force main",
    "git push --force master"
  ],
  "conversationWindow": 30,             // 프롬프트에 포함할 최근 메시지 수
  "humanDiscordId": "401573048353816587" // 사람(회장님)의 Discord User ID
}
```

### 주요 필드 설명

| 필드 | 설명 |
|------|------|
| `engine` | `"claude"`: Claude CLI 사용 풀 에이전트. `"codex"`: Codex CLI. `"gemini"`: 텍스트 전용. |
| `isLeader` | `true`면 모든 메시지에 응답. 하트비트도 리더가 실행. |
| `useTeams` | `true`면 복잡한 병렬 작업 시 서브 에이전트를 스폰할 수 있음. (Claude Agent SDK 활용) |
| `teamRules` | 서브 에이전트 동작 규칙 배열. `useTeams: true`일 때 적용. |
| `channels` | 이 봇이 응답할 Discord 채널 ID 목록. 생략 시 전체 채널에서 응답. |
| `discordTokenEnv` | 봇 토큰 환경변수 이름. 기본값: `{ID_대문자}_DISCORD_TOKEN`. |
| `maxBudget` | Claude 호출당 최대 달러 지출. 무한 루프 방지용. |
| `discordUserId` | 봇의 Discord User ID. 첫 로그인 시 자동 저장 — 직접 설정하지 않음. |
| `humanDiscordId` | 사람(회장님)의 Discord ID. 에이전트가 사람을 태그할 때 사용. |
| `humanTitle` | 에이전트가 사용자를 부르는 호칭. 기본값: `"Boss"`. `shared-rules.md`에서 `{{humanTitle}}`로 참조. |

### 환경변수 (.env)

```bash
WORK_CHANNEL_ID=              # 작업할 Discord 채널 ID (비우면 전체 채널)
HOOK_PORT=9876                # HTTP 웹훅 수신 포트

# 봇 토큰 (봇 1개당 1개, teams.json의 discordTokenEnv로 참조)
LEADER_DISCORD_TOKEN=...
STACK_DISCORD_TOKEN=...
BRUSH_DISCORD_TOKEN=...
CHECKER_DISCORD_TOKEN=...

# MCP 연동
GOOGLE_OAUTH_CREDENTIALS=...     # Google Calendar
FIGMA_PERSONAL_ACCESS_TOKEN=...  # Figma
NOTION_API_KEY=...               # Notion

# GitHub
GITHUB_PAT=...                   # 푸시·PR 생성에 필요
```

---

## 프롬프트 & 페르소나 파일

각 에이전트의 성격·역할·규칙은 Markdown 파일에 정의합니다 (`teams.json`의 `prompt` 필드). 이 파일이 모든 프롬프트 앞에 붙고, 그 뒤에 대화 기록·메모리·팀 디렉토리 등이 자동으로 주입됩니다.

### 공유 규칙 (shared-rules.md)

`prompts/shared-rules.md`를 만들면 모든 에이전트 프롬프트에 공통 규칙이 주입됩니다. 두 가지 플레이스홀더를 지원합니다:

- `{{humanTitle}}` → `teams.json`의 `humanTitle`로 치환
- `{{leaderName}}` → 리더 에이전트 이름으로 치환

### 저장소별 규칙 (repo-specific)

`prompts/repo-specific/{저장소명}.md`를 만들면, 에이전트 프롬프트에 `repos/{저장소명}` 참조가 포함될 때 해당 규칙이 자동으로 추가됩니다.

---

## Discord 명령어

| 명령어 | 설명 |
|--------|------|
| `!status` | 전체 에이전트 상태 (작업 중/유휴, 엔진, 누적 비용) |
| `!teams` | 에이전트 목록과 엔진 정보 |
| `!repos` | 연결된 저장소 목록 |

---

## 수동 설치 (CLI 없이)

```bash
git clone https://github.com/wodn5515/claude-mococo.git
cd claude-mococo
npm install
npm run build
```

`teams.json`과 `prompts/` 파일을 직접 편집하고 `.env`에 토큰을 설정한 후:

```bash
npm start
```

---

## 문제 해결

| 문제 | 해결 |
|------|------|
| 봇이 응답하지 않음 | Discord Developer Portal에서 **Message Content Intent** 활성화 필수 |
| "No team has a Discord token" | `.env`에 토큰 환경변수 추가 후 `teams.json`의 `discordTokenEnv`와 이름 일치 확인 |
| GitHub 푸시 불가 | `.env`의 `GITHUB_PAT` 유효 여부 확인 |
| 커밋 작성자 오류 | `git.email`을 `USERNAME@users.noreply.github.com`으로 설정 |
| 하트비트 미동작 | 워크스페이스 루트에 `heartbeat.md` 존재 여부 확인 |
| 에이전트 무한 루프 | `teams.json`에 `maxBudget` 설정 확인 |
| MCP 연동 실패 | 해당 서비스의 API 키/토큰 `.env` 설정 및 MCP 서버 설치 확인 |
| 에이전트가 서로 멘션 인식 못 함 | `discordUserId` 값이 실제 봇 User ID와 일치하는지 확인 |

---

## 변경 이력

### v0.9.0

**신규 기능:**
- 스트레스/업무부하 기반 봇 페르소나 동적 변경 시스템 (#73)
- 에이전트 스트레스 시스템 + 하트비트 TaskRegistry 전환 (#79)
- AGENT.md 시스템 — 레포별 AI 에이전트 컨텍스트 자동 로딩 (#84)

**버그 수정:**
- 메모리 누수 — 타이머 중복 등록 및 로그인 실패 시 리소스 미해제 (#69)
- Race condition 6건 수정 (#70)
- Improvement scanner 오진율 개선 (#71)
- Cooldown Maps 메모리 누수 수정 및 중복 시작 방어 (#87)
- `appendToInbox` race condition 수정 (#88)
- 오픈소스 레포에서 내부 팀 설정 제거 (#89)

**리팩토링:**
- 프롬프트 토큰 최적화 — 반복 호출 시 압축 모드 (#74)

**문서:**
- README 한글/영어 전면 개정 (#66, #67)
- 체커코코 머지 권한 문서화 (#75)

---

## 라이선스

MIT
