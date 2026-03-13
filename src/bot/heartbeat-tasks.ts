// ---------------------------------------------------------------------------
// Heartbeat TaskRegistry — replaces heartbeat.md with type-safe task definitions
// ---------------------------------------------------------------------------

export type HeartbeatSchedule = 'daily' | 'weekly' | 'hourly' | 'periodic' | 'on-demand';

export interface HeartbeatTaskDef {
  id: string;
  description: string;
  schedule: HeartbeatSchedule;
  assignee: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Static task registry — migrated from heartbeat.md
// ---------------------------------------------------------------------------

const staticTasks: HeartbeatTaskDef[] = [
  // --- Daily ---
  {
    id: 'daily-closed-pr-issues',
    description: '각 레포 closed PR 목록 확인 → 연결된 이슈 중 close 가능한 이슈 close 처리',
    schedule: 'daily',
    assignee: '체커코코',
    enabled: true,
  },
  {
    id: 'daily-ci-failure-check',
    description: '각 레포 오픈 PR 중 CI 실패 건 확인 → 담당 코코에게 알림',
    schedule: 'daily',
    assignee: '체커코코',
    enabled: true,
  },
  {
    id: 'daily-stale-pr-review',
    description: '오픈 PR 중 48시간 이상 리뷰 없는 건 확인 → 대장코코에게 보고',
    schedule: 'daily',
    assignee: '체커코코',
    enabled: true,
  },
  {
    id: 'daily-calendar-summary',
    description: 'Google Calendar 오늘 일정 확인 → 하루 일정 요약 보고',
    schedule: 'daily',
    assignee: '대장코코',
    enabled: true,
  },
  {
    id: 'daily-new-issues-assignment',
    description: '각 레포(claude-mococo, Kil-biseo) 새로 오픈된 이슈 확인 → 미할당 이슈 자동 할당 판단',
    schedule: 'daily',
    assignee: '대장코코',
    enabled: true,
  },

  // --- Weekly ---
  {
    id: 'weekly-completed-summary',
    description: '지난 주 완료 작업(머지된 PR, close된 이슈) 요약 → 노션 문서화',
    schedule: 'weekly',
    assignee: '체커코코',
    enabled: true,
  },
  {
    id: 'weekly-stale-issues-review',
    description: '7일 이상 미해결 오픈 이슈 목록 확인 → 우선순위 재검토 및 필요 시 담당 코코 재할당',
    schedule: 'weekly',
    assignee: '대장코코',
    enabled: true,
  },
  {
    id: 'weekly-stale-branches',
    description: '각 레포 3주 이상 미활동 브랜치 목록 확인 → 정리 필요 여부 대장코코에게 보고',
    schedule: 'weekly',
    assignee: '체커코코',
    enabled: true,
  },

  // --- Periodic ---
  {
    id: 'periodic-server-health',
    description: 'mococo-corps 서버 상태 확인 (포트 9876 응답 여부) → 이상 시 즉시 대장코코 에스컬레이션',
    schedule: 'periodic',
    assignee: '대장코코',
    enabled: true,
  },
  {
    id: 'periodic-code-analysis',
    description: 'Kil-biseo/claude-mococo 레포지토리 코드 분석 → 개선점 GitHub ISSUE 등록',
    schedule: 'periodic',
    assignee: '체커코코',
    enabled: true,
  },
  {
    id: 'periodic-feature-planning',
    description: 'Kil-biseo/claude-mococo 서비스 분석 기반 신규 기능 기획 → 노션 문서화 → GitHub 이슈 등록 (이슈 본문에 노션 URL 포함) → 팀 자율 우선순위 결정 → 개발 착수 배정',
    schedule: 'periodic',
    assignee: '체커코코',
    enabled: true,
  },
  {
    id: 'periodic-pr-review-merge',
    description: '스택코코/브러쉬코코 작업 완료 PR 확인 → 코드리뷰 → 수정 요청 → CI 확인 → 모두 통과 시 PR 코멘트 작성 + 머지 실행 (Kil-biseo 한정) → 머지 시점 논블로킹 이슈 발견 시 이슈 동시 등록',
    schedule: 'periodic',
    assignee: '체커코코',
    enabled: true,
  },
];

// Runtime tasks added via Discord command (transient — lost on restart)
const runtimeTasks: HeartbeatTaskDef[] = [];
let runtimeIdCounter = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAllTasks(): HeartbeatTaskDef[] {
  return [...staticTasks, ...runtimeTasks].filter(t => t.enabled);
}

export function getTasksBySchedule(schedule: HeartbeatSchedule): HeartbeatTaskDef[] {
  return getAllTasks().filter(t => t.schedule === schedule);
}

export function addRuntimeTask(
  description: string,
  schedule: HeartbeatSchedule,
  assignee: string | null = null,
): HeartbeatTaskDef {
  const task: HeartbeatTaskDef = {
    id: `runtime-${++runtimeIdCounter}`,
    description,
    schedule,
    assignee,
    enabled: true,
  };
  runtimeTasks.push(task);
  return task;
}

export function removeRuntimeTask(id: string): boolean {
  const idx = runtimeTasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  runtimeTasks.splice(idx, 1);
  return true;
}

export function listRuntimeTasks(): HeartbeatTaskDef[] {
  return [...runtimeTasks];
}

/**
 * Convert TaskRegistry tasks to the HeartbeatTask format
 * used by inbox-compactor for backward compatibility.
 */
export function toHeartbeatTasks(): { section: HeartbeatSchedule; content: string; assignee: string | null }[] {
  return getAllTasks().map(t => ({
    section: t.schedule,
    content: t.description,
    assignee: t.assignee,
  }));
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

export function _resetRuntimeForTesting(): void {
  runtimeTasks.length = 0;
  runtimeIdCounter = 0;
}
