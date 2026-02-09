# claude-mococo

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

### 3. 워크스페이스 생성 및 어시스턴트 추가

```bash
mkdir my-team && cd my-team
mococo init                   # 워크스페이스 생성 (Discord 채널 ID 입력)
mococo add                    # 대화형 마법사 — 이름, 엔진, 토큰 등 입력
```

커밋에는 어시스턴트 이름이 작성자로 표시됩니다 (`teams.json`의 `git.name`으로 설정). 어시스턴트가 푸시나 PR을 생성해야 하면 `mococo add` 시 GitHub PAT를 입력하세요.

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
| `mococo list` | 설정된 어시스턴트 목록 |
| `mococo remove <id>` | 어시스턴트 제거 |

---

## 어시스턴트 추가하기

```bash
mococo add        # 새 어시스턴트마다 반복
```

각 어시스턴트는:
- 고유한 Discord 봇 (채팅에서 별도 신원)
- 고유한 git 작성자 이름 (커밋 메시지에 표시)
- `teams.json`의 별도 항목 (엔진, 성격, 권한)

이렇게 팀을 구성할 수 있습니다:

| 어시스턴트 | 엔진 | 역할 |
|-----------|------|------|
| Leader | Claude | 다른 어시스턴트에게 작업 위임 |
| Planner | Codex | 계획 및 스펙 작성 |
| Coder | Claude | 코드 작성 |
| Reviewer | Claude | 리뷰 및 PR 생성 |
| Designer | Gemini | UI/UX 가이드 |

혼자 하나만 써도 됩니다. 선택은 자유입니다.

---

## 작동 방식

**메시지 라우팅:**
- 특정 봇을 `@멘션` → 해당 어시스턴트가 응답
- 멘션 없음 → `"isLeader": true`인 어시스턴트가 응답

**어시스턴트가 다른 어시스턴트를 멘션하면** (예: `@Reviewer 확인 부탁`) → 자동으로 호출됩니다.

**권한**은 `teams.json`에서 어시스턴트별로 제어합니다:

```jsonc
"permissions": {
  "allow": ["git push", "gh pr create"],
  "deny": ["gh pr merge"]
}
```

**엔진:** `"claude"`는 풀 에이전트(파일, git, 명령어). `"codex"`와 `"gemini"`는 텍스트 전용 어드바이저.

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
| `git.name` / `git.email` | 커밋 작성자 정보 |
| `permissions.allow` / `permissions.deny` | 허용/차단 쉘 명령어 |

### Discord 명령어

| 명령어 | 설명 |
|--------|------|
| `!status` | 모든 어시스턴트 상태 (작업 중/유휴, 온라인/오프라인) |
| `!teams` | 어시스턴트 목록과 엔진 |
| `!repos` | 연결된 저장소 목록 |

---

## 수동 설정 (CLI 없이)

저장소를 직접 클론해서 설정할 수도 있습니다:

```bash
git clone https://github.com/anthropics/claude-mococo.git
cd claude-mococo
npm install
```

`teams.json`을 직접 편집하고, `prompts/`에 프롬프트 파일을 만들고, `.env`에 토큰을 설정한 후 `npm start`로 실행합니다.

---

## 문제 해결

| 문제 | 해결 |
|------|------|
| 봇이 응답 안 함 | Discord Developer Portal에서 **Message Content Intent** 활성화 |
| "No team has a Discord token" | `.env`에 토큰 환경변수 추가 |
| GitHub 푸시 불가 | `.env`의 GitHub PAT 확인 |
| 커밋 작성자 틀림 | `git.email`을 `USERNAME@users.noreply.github.com`으로 설정 |
| "command not found: codex" | 설치하거나 engine을 `"claude"`로 변경 |

## 라이선스

MIT
