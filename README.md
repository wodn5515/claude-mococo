# claude-mococo v2

**AI 봇 분양소.** Discord 봇들이 실제 레포지토리에서 직접 작업하고, 자율적으로 코드를 분석하고 개선합니다.

**AI Bot Adoption Center.** Discord bots work directly in real repositories, autonomously analyzing and improving code.

---

## How It Works / 작동 방식

```
터미널 1: mococo run leader      # 대장코코 — 조율, 지시
터미널 2: mococo run stack       # 스택코코 — 백엔드 구현
터미널 3: mococo run brush       # 브러쉬코코 — 프론트엔드 구현
터미널 4: mococo run checker     # 체커코코 — 코드 리뷰, PR
터미널 5: mococo run security    # 방패코코 — 보안 스캔 (자동)
터미널 6: mococo run improver    # 개선코코 — 구조 개선 (자동)
```

Each bot runs as an independent process. When a bot needs to work on a repo, it `cd`s to the actual directory and runs `claude --print`, using the repo's native `CLAUDE.md` and `.claude/` settings.

각 봇은 독립 프로세스로 실행됩니다. 레포 작업이 필요하면 실제 디렉토리로 이동해서 `claude --print`를 실행하고, 해당 레포의 `CLAUDE.md`와 `.claude/` 설정을 네이티브로 사용합니다.

### Message Flow / 메시지 흐름

```
Discord 메시지 수신
  │
  ▼
[Phase 1: Triage] — Haiku LLM이 판단
  - 어떤 레포에서 작업할지?
  - 직접 응답만 하면 되는지?
  - 무시해도 되는 메시지인지?
  │
  ▼
[Phase 2: Execution] — 해당 레포 디렉토리에서 claude --print
  - 레포의 CLAUDE.md, .claude/ 설정 자동 적용
  - 봇 페르소나 + 작업 이력(worklog)을 시스템 프롬프트로 주입
  │
  ▼
결과 → 메모리 업데이트 → worklog 기록 → Discord 응답
```

---

## Prerequisites / 사전 요구사항

- **Node.js** >= 18
- **Claude CLI** installed and authenticated (`claude --version`)
- **One Discord bot application per agent** ([discord.com/developers](https://discord.com/developers/applications))

---

## Quick Start / 빠른 시작

### 1. Install / 설치

```bash
npm install -g claude-mococo
```

Or run without installing / 설치 없이 실행:

```bash
npx claude-mococo init
npx claude-mococo adopt leader
npx claude-mococo run leader
```

From source / 소스에서 빌드:

```bash
git clone https://github.com/wodn5515/claude-mococo.git
cd claude-mococo
npm install && npm run build
npm link   # makes `mococo` command available globally
```

### 2. Initialize adoption center / 분양소 초기화

```bash
mococo init
```

Creates `~/.mococo/` with the following structure:

```
~/.mococo/
├── global.json          # Global settings (humanDiscordId, globalDeny)
├── bots/                # Per-bot config, persona, memory
├── repos/               # Shared repo memory (worklog, context)
└── shared/              # Shared data (members, inbox)
```

### 3. Create Discord bots / 디스코드 봇 생성

For each bot you want to run:

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → Copy token, enable **Message Content Intent**
3. **OAuth2** → Scopes: `bot` → Permissions: `Send Messages`, `Read Message History`
4. Invite bot to your server using the generated URL

### 4. Adopt bots / 봇 분양

```bash
# Leader — coordinates, delegates, doesn't write code
mococo adopt leader

# Backend developer
mococo adopt stack

# Frontend developer
mococo adopt brush

# Code reviewer — pushes branches, creates PRs
mococo adopt checker

# (Optional) Security scanner — runs on cron, read-only
mococo adopt security

# (Optional) Code improver — runs when idle, read-only
mococo adopt improver
```

The interactive wizard asks for: name, engine, model, Discord token, allowed directories, git identity.

대화형 위저드가 이름, 엔진, 모델, Discord 토큰, 접근 허용 디렉토리, git 신원을 물어봅니다.

### 5. Configure specialist bots / 전문 봇 설정

After adopting, edit the config and persona files directly:

분양 후 설정 파일과 페르소나 파일을 직접 수정합니다:

#### Leader (대장코코)

`~/.mococo/bots/leader/config.json`:
```json
{
  "name": "대장코코",
  "engine": "claude",
  "model": "sonnet",
  "isLeader": true,
  "allowedDirs": [
    "/home/jake/projects/my-app",
    "/home/jake/projects/api-server"
  ],
  "permissions": {
    "deny": ["git push", "gh pr", "Edit", "Write"]
  },
  "discordTokenEnv": "LEADER_DISCORD_TOKEN",
  "git": { "name": "Leader", "email": "leader@users.noreply.github.com" },
  "maxBudget": 5
}
```

#### Backend (스택코코)

`~/.mococo/bots/stack/config.json`:
```json
{
  "name": "스택코코",
  "engine": "claude",
  "model": "sonnet",
  "allowedDirs": [
    "/home/jake/projects/my-app",
    "/home/jake/projects/api-server"
  ],
  "permissions": {
    "deny": ["git push", "gh pr merge"]
  },
  "discordTokenEnv": "STACK_DISCORD_TOKEN",
  "git": { "name": "Stack", "email": "stack@users.noreply.github.com" },
  "maxBudget": 10
}
```

#### Security Scanner (방패코코) — Cron, read-only

`~/.mococo/bots/security/config.json`:
```json
{
  "name": "방패코코",
  "engine": "claude",
  "model": "sonnet",
  "allowedDirs": [
    "/home/jake/projects/my-app",
    "/home/jake/projects/api-server"
  ],
  "permissions": {
    "deny": ["Edit", "Write", "git push", "gh pr"]
  },
  "schedule": {
    "cron": "0 */3 * * *",
    "reportChannel": "DISCORD_CHANNEL_ID"
  },
  "discordTokenEnv": "SECURITY_DISCORD_TOKEN",
  "git": { "name": "Security", "email": "security@users.noreply.github.com" },
  "maxBudget": 5
}
```

`~/.mococo/bots/security/persona.md`:
```markdown
# 방패코코

You are a security specialist bot. Your ONLY job is to find security vulnerabilities.

## What you scan for
- SQL injection, XSS, CSRF
- Hardcoded secrets, exposed API keys
- Authentication/authorization flaws
- Insecure dependencies
- Path traversal, command injection

## Rules
- NEVER modify code. Report only.
- Be specific: file path, line number, severity, description
- Severity levels: CRITICAL, HIGH, MEDIUM, LOW
- Skip false positives. Only report what you are confident about.
- Tag @대장코코 for CRITICAL/HIGH findings
```

#### Code Improver (개선코코) — Idle trigger, read-only

`~/.mococo/bots/improver/config.json`:
```json
{
  "name": "개선코코",
  "engine": "claude",
  "model": "sonnet",
  "allowedDirs": [
    "/home/jake/projects/my-app"
  ],
  "permissions": {
    "deny": ["Edit", "Write", "git push", "gh pr"]
  },
  "schedule": {
    "onIdle": true,
    "idleDelayMinutes": 15,
    "reportChannel": "DISCORD_CHANNEL_ID"
  },
  "discordTokenEnv": "IMPROVER_DISCORD_TOKEN",
  "git": { "name": "Improver", "email": "improver@users.noreply.github.com" },
  "maxBudget": 5
}
```

`~/.mococo/bots/improver/persona.md`:
```markdown
# 개선코코

You are a code quality specialist. You find structural improvements, not bugs.

## What you look for
- Code duplication that should be extracted
- Overly complex functions that should be split
- Missing error handling at system boundaries
- Test coverage gaps
- Dead code, unused imports
- Naming inconsistencies
- Architecture improvements

## Rules
- NEVER modify code. Report only.
- Prioritize by impact: what would improve maintainability the most?
- Be actionable: "Extract X into a shared util" not "code could be better"
- Tag @대장코코 with your findings
```

### 6. Set environment variables / 환경변수 설정

```bash
export LEADER_DISCORD_TOKEN="..."
export STACK_DISCORD_TOKEN="..."
export BRUSH_DISCORD_TOKEN="..."
export CHECKER_DISCORD_TOKEN="..."
export SECURITY_DISCORD_TOKEN="..."
export IMPROVER_DISCORD_TOKEN="..."
```

Or add to your shell profile (`~/.bashrc`, `~/.zshrc`).

### 7. Run bots / 봇 실행

Each bot in its own terminal tab:

각 봇을 별도 터미널 탭에서 실행:

```bash
# Tab 1
mococo run leader

# Tab 2
mococo run stack

# Tab 3
mococo run checker

# Tab 4 — security scanner (auto-runs every 3 hours)
mococo run security

# Tab 5 — code improver (auto-runs when idle 15min)
mococo run improver
```

### 8. Talk to them / 대화

In Discord:
```
You: "my-app에 로그인 기능 추가해줘"
대장코코: "@스택코코 /api/auth 엔드포인트 만들어. @브러쉬코코 로그인 페이지 UI 만들어."
스택코코: (cd /home/jake/my-app → claude --print → 코드 작성 → commit) "완료 @대장코코"
브러쉬코코: (same flow) "완료 @대장코코"
대장코코: "@체커코코 리뷰해줘"
체커코코: (reviews, pushes, opens PR) "PR #42 생성 완료"
```

Meanwhile, in the background:
```
방패코코: [3시간마다] "my-app 보안 스캔 결과: 이상 없음"
개선코코: [idle 15분 후] "@대장코코 my-app의 src/utils/auth.ts에서 중복 코드 발견. extractToken() 함수로 추출 권장."
```

---

## CLI Commands / CLI 명령어

| Command | Description |
|---------|-------------|
| `mococo init` | Create ~/.mococo/ adoption center / 분양소 생성 |
| `mococo adopt <id>` | Adopt a new bot (interactive) / 새 봇 분양 |
| `mococo run <id>` | Run a bot in current terminal / 봇 실행 |
| `mococo list` | List all adopted bots / 봇 목록 |
| `mococo release <id>` | Remove a bot / 봇 삭제 |

---

## Directory Structure / 디렉토리 구조

```
~/.mococo/
├── global.json                     # Global settings
├── bots/
│   ├── leader/
│   │   ├── config.json             # Bot config
│   │   ├── persona.md              # Personality, role, rules
│   │   └── memory.md               # Personal memory (auto-updated)
│   ├── stack/
│   │   └── ...
│   ├── security/
│   │   └── ...
│   └── improver/
│       └── ...
├── repos/                          # Shared across ALL bots
│   ├── my-app/
│   │   ├── context.md              # Repo info (architecture, stack)
│   │   └── worklog.md              # Work history (who did what when)
│   └── api-server/
│       └── ...
└── shared/
    ├── members.md                  # Discord server members
    └── inbox/                      # Inter-bot messages
```

---

## Schedule Options / 스케줄 설정

Add `schedule` to any bot's `config.json`:

| Field | Type | Description |
|-------|------|-------------|
| `cron` | string | Cron expression (e.g. `"0 */2 * * *"` = every 2 hours) |
| `onIdle` | boolean | Auto-trigger when no activity for `idleDelayMinutes` |
| `idleDelayMinutes` | number | Minutes of idle before trigger (default: 10) |
| `reportChannel` | string | Discord channel ID to post scheduled results |

### Cron examples / Cron 예시

```
"*/30 * * * *"     — every 30 minutes / 30분마다
"0 */2 * * *"      — every 2 hours / 2시간마다
"0 9 * * *"        — daily at 9am / 매일 오전 9시
"0 9 * * 1"        — every Monday 9am / 매주 월요일 9시
```

---

## Bot Roles Guide / 봇 역할 가이드

| Role | Schedule | Permissions | Description |
|------|----------|-------------|-------------|
| **Leader** | none | read-only | Coordinates team, delegates work / 팀 조율, 작업 배분 |
| **Backend** | none | edit + commit | Implements server code / 서버 코드 구현 |
| **Frontend** | none | edit + commit | Implements UI / UI 구현 |
| **Reviewer** | none | push + PR | Reviews code, opens PRs / 코드 리뷰, PR 생성 |
| **Security** | cron | read-only | Scans for vulnerabilities / 보안 취약점 스캔 |
| **Improver** | idle | read-only | Finds code quality issues / 코드 품질 개선점 발견 |
| **Tester** | cron | read-only | Finds test coverage gaps / 테스트 커버리지 분석 |
| **Bug Hunter** | idle | read-only | Finds error-prone logic / 에러 로직 탐색 |

Mix and match as needed. Each bot is defined by its **persona + config** — the system is generic.

필요에 따라 조합하세요. 각 봇은 **페르소나 + 설정**으로 정의됩니다 — 시스템 자체는 범용입니다.

---

## AGENT.md (Repo Context)

Place an `AGENT.md` at your repository root. When a bot works in that repo, Claude CLI loads it automatically — no mococo configuration needed.

레포지토리 루트에 `AGENT.md`를 배치하세요. 봇이 해당 레포에서 작업할 때 Claude CLI가 자동으로 로딩합니다.

```markdown
# My App — AGENT.md

## Overview
Next.js 14 + TypeScript e-commerce app.

## Tech Stack
- Next.js 14 (App Router), React 18, Tailwind CSS
- Prisma ORM, PostgreSQL
- NextAuth.js for authentication

## Key Commands
- `npm run dev` — start dev server
- `npm test` — run tests
- `npm run lint` — lint check

## Conventions
- Korean comments, English code
- All API routes in src/app/api/
- Tests in __tests__/ next to source files
```

---

## Troubleshooting / 문제 해결

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Enable **Message Content Intent** in Discord Developer Portal |
| "Missing env var" | Set the Discord token env var before running |
| Bot can't access repo | Add the path to `allowedDirs` in config.json |
| Scheduled task not running | Check `schedule` config and `reportChannel` is valid |
| Bot responds to wrong messages | Set `channels` in config.json to restrict |
| "claude: command not found" | Install Claude CLI: `npm install -g @anthropic-ai/claude-code` |

---

## License

MIT
